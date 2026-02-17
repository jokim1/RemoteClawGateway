/**
 * Talk CRUD HTTP Handlers
 *
 * Handles /api/talks endpoints for creating, listing, reading,
 * updating, and deleting Talks, plus message history and pins.
 */

import type { HandlerContext } from './types.js';
import type { TalkStore } from './talk-store.js';
import type {
  PlatformBehavior,
  PlatformBinding,
  PlatformPermission,
  TalkAgent,
  TalkMeta,
} from './types.js';
import type { ToolRegistry } from './tool-registry.js';
import { sendJson, readJsonBody } from './http.js';
import { validateSchedule, parseEventTrigger } from './job-scheduler.js';
import { reconcileSlackRoutingForTalks } from './slack-routing-sync.js';
import { randomUUID } from 'node:crypto';
import { googleDocsAuthStatus, upsertGoogleDocsAuthConfig } from './google-docs.js';
import { getToolCatalog } from './tool-catalog.js';

type PlatformBindingsValidationResult =
  | { ok: true; bindings: PlatformBinding[]; ownershipKeys: string[] }
  | { ok: false; error: string };

type PlatformBehaviorsValidationResult =
  | { ok: true; behaviors: PlatformBehavior[] }
  | { ok: false; error: string };

type SlackScopeResolutionResult =
  | { ok: true; canonicalScope: string; accountId?: string; displayScope?: string }
  | { ok: false; error: string };

type PlatformBindingsValidationOptions = {
  resolveSlackScope?: (scope: string, accountId?: string) => Promise<SlackScopeResolutionResult>;
};

type SlackConversation = {
  id?: string;
  name?: string;
  name_normalized?: string;
};

type SlackConversationsListResponse = {
  ok?: boolean;
  error?: string;
  channels?: SlackConversation[];
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackConversationInfoResponse = {
  ok?: boolean;
  error?: string;
  channel?: SlackConversation;
};

const SLACK_LOOKUP_TIMEOUT_MS = 10_000;
const SLACK_CHANNEL_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_SLACK_ACCOUNT_ID = 'default';

const slackChannelNameByIdCache = new Map<string, { name: string; expiresAt: number }>();
const slackChannelIdByNameCache = new Map<string, { id: string; name: string; expiresAt: number }>();

type CatalogAuthRequirement = {
  id: string;
  ready: boolean;
  message?: string;
};

async function resolveCatalogAuth(requirements: string[] | undefined): Promise<{
  ready: boolean;
  requirements: CatalogAuthRequirement[];
}> {
  const reqs = Array.isArray(requirements) ? requirements : [];
  if (reqs.length === 0) {
    return { ready: true, requirements: [] };
  }

  const statuses: CatalogAuthRequirement[] = [];
  for (const req of reqs) {
    if (req === 'google_oauth') {
      const status = await googleDocsAuthStatus();
      statuses.push({
        id: req,
        ready: Boolean(status.accessTokenReady),
        message: status.accessTokenReady
          ? undefined
          : status.error || `Google OAuth is not ready. Token file: ${status.tokenPath}`,
      });
      continue;
    }
    statuses.push({
      id: req,
      ready: false,
      message: `Auth provider "${req}" setup is not yet available in guided flow.`,
    });
  }

  return {
    ready: statuses.every((entry) => entry.ready),
    requirements: statuses,
  };
}

function normalizePermission(raw: unknown): PlatformPermission {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'read' || value === 'write' || value === 'read+write') {
    return value;
  }
  return 'read+write';
}

function canWrite(permission: PlatformPermission): boolean {
  return permission === 'write' || permission === 'read+write';
}

function normalizeObjectiveAlias(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim()) return entry.trim();
    }
  }
  return undefined;
}

function normalizeToolModeInput(raw: unknown): 'off' | 'confirm' | 'auto' | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'off' || value === 'confirm' || value === 'auto') return value;
  return undefined;
}

function normalizeToolNameListInput(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function mapChannelResponseSettingsInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const row = entry as Record<string, unknown>;
    const connectionId =
      typeof row.connectionId === 'string' ? row.connectionId.trim() : '';
    const platformBindingId =
      typeof row.platformBindingId === 'string' ? row.platformBindingId.trim() : connectionId;
    const responderAgent =
      typeof row.responderAgent === 'string' ? row.responderAgent.trim() : '';
    const responseInstruction =
      typeof row.responseInstruction === 'string' ? row.responseInstruction.trim() : '';
    const autoRespond =
      typeof row.autoRespond === 'boolean' ? row.autoRespond : undefined;

    return {
      ...row,
      ...(platformBindingId ? { platformBindingId } : {}),
      ...(responderAgent ? { agentName: responderAgent } : {}),
      ...(responseInstruction ? { onMessagePrompt: responseInstruction } : {}),
      ...(autoRespond !== undefined ? { autoRespond } : {}),
    };
  });
}

export function normalizeSlackBindingScope(scope: string): string | null {
  const trimmed = scope.trim();
  if (!trimmed) return null;

  if (/^(?:\*|all|slack:\*)$/i.test(trimmed)) {
    return 'slack:*';
  }

  const channel =
    trimmed.match(/^channel:([a-z0-9]+)$/i) ??
    trimmed.match(/^slack:channel:([a-z0-9]+)$/i);
  if (channel?.[1]) {
    return `channel:${channel[1].toUpperCase()}`;
  }

  const user =
    trimmed.match(/^user:([a-z0-9]+)$/i) ??
    trimmed.match(/^slack:user:([a-z0-9]+)$/i);
  if (user?.[1]) {
    return `user:${user[1].toUpperCase()}`;
  }

  return null;
}

function resolveTemplateSecret(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const envMatch = trimmed.match(/^\$\{(.+)\}$/);
  if (envMatch?.[1]) {
    const fromEnv = process.env[envMatch[1]];
    return fromEnv?.trim() ? fromEnv.trim() : undefined;
  }
  return trimmed;
}

function listSlackAccountIds(cfg: Record<string, any>): string[] {
  const accounts = cfg?.channels?.slack?.accounts;
  if (!accounts || typeof accounts !== 'object') {
    return [DEFAULT_SLACK_ACCOUNT_ID];
  }
  const ids = Object.keys(accounts).filter(Boolean);
  if (ids.length === 0) return [DEFAULT_SLACK_ACCOUNT_ID];
  if (ids.includes(DEFAULT_SLACK_ACCOUNT_ID)) {
    return [DEFAULT_SLACK_ACCOUNT_ID, ...ids.filter((id) => id !== DEFAULT_SLACK_ACCOUNT_ID).sort()];
  }
  return ids.sort();
}

function resolveSlackBotTokenForAccount(cfg: Record<string, any>, accountId: string): string | undefined {
  const accountRaw: string | undefined = cfg?.channels?.slack?.accounts?.[accountId]?.botToken;
  const accountToken = resolveTemplateSecret(accountRaw);
  if (accountToken) return accountToken;

  if (accountId === DEFAULT_SLACK_ACCOUNT_ID) {
    const topLevelToken = resolveTemplateSecret(cfg?.channels?.slack?.botToken);
    if (topLevelToken) return topLevelToken;
    const envToken = resolveTemplateSecret(process.env.SLACK_BOT_TOKEN);
    if (envToken) return envToken;
  }
  return undefined;
}

function normalizeAccountId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}

function parseScopedSlackInput(rawScope: string): { accountId?: string; scope: string } {
  const rawTrimmed = rawScope.trim();
  if (!rawTrimmed) return { scope: '' };

  const quoted =
    (rawTrimmed.startsWith('"') && rawTrimmed.endsWith('"')) ||
    (rawTrimmed.startsWith("'") && rawTrimmed.endsWith("'"));
  const trimmed = quoted ? rawTrimmed.slice(1, -1).trim() : rawTrimmed;
  if (!trimmed) return { scope: '' };

  const accountPrefix = trimmed.match(/^account:([a-z0-9._-]+):(.+)$/i);
  if (accountPrefix?.[1] && accountPrefix?.[2]) {
    return {
      accountId: accountPrefix[1].toLowerCase(),
      scope: accountPrefix[2].trim(),
    };
  }

  const spaced = trimmed.match(/^([a-z0-9._-]+)\s+(#?[a-z0-9._-]+)$/i);
  if (spaced?.[1] && spaced?.[2] && spaced[2].startsWith('#')) {
    return {
      accountId: spaced[1].toLowerCase(),
      scope: spaced[2].trim(),
    };
  }

  const shorthand = trimmed.match(/^([a-z0-9._-]+):(.+)$/i);
  if (shorthand?.[1] && shorthand?.[2]) {
    const accountPrefix = shorthand[1].toLowerCase();
    const scoped = shorthand[2].trim();
    if (
      !['slack', 'channel', 'user'].includes(accountPrefix) &&
      (
        scoped.startsWith('#') ||
        /^channel:/i.test(scoped) ||
        /^user:/i.test(scoped) ||
        /^slack:\*/i.test(scoped) ||
        scoped === '*'
      )
    ) {
      return {
        accountId: shorthand[1].toLowerCase(),
        scope: scoped,
      };
    }
  }

  return { scope: trimmed };
}

function normalizeSlackChannelNameScope(scope: string): string | null {
  const trimmed = scope.trim();
  if (!trimmed) return null;

  const withPrefix =
    trimmed.match(/^#([a-z0-9._-]+)$/i) ??
    trimmed.match(/^channel:#([a-z0-9._-]+)$/i) ??
    trimmed.match(/^slack:channel:#([a-z0-9._-]+)$/i);
  if (withPrefix?.[1]) {
    return withPrefix[1].toLowerCase();
  }

  const maybeNamedChannel =
    trimmed.match(/^channel:([a-z0-9._-]+)$/i) ??
    trimmed.match(/^slack:channel:([a-z0-9._-]+)$/i);
  if (maybeNamedChannel?.[1]) {
    // If channel:<ID> already matched the canonical parser, don't treat it as a name.
    const candidate = maybeNamedChannel[1];
    if (/^[cu][a-z0-9]+$/i.test(candidate)) {
      return null;
    }
    return candidate.toLowerCase();
  }

  if (/^[a-z0-9._-]+$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return null;
}

function getCachedSlackChannelName(accountId: string, channelId: string): string | undefined {
  const key = `${accountId}:${channelId.toUpperCase()}`;
  const cached = slackChannelNameByIdCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    slackChannelNameByIdCache.delete(key);
    return undefined;
  }
  return cached.name;
}

function setCachedSlackChannelName(accountId: string, channelId: string, channelName: string): void {
  const now = Date.now();
  const keyById = `${accountId}:${channelId.toUpperCase()}`;
  const keyByName = `${accountId}:${channelName.toLowerCase()}`;
  slackChannelNameByIdCache.set(keyById, {
    name: channelName,
    expiresAt: now + SLACK_CHANNEL_CACHE_TTL_MS,
  });
  slackChannelIdByNameCache.set(keyByName, {
    id: channelId.toUpperCase(),
    name: channelName,
    expiresAt: now + SLACK_CHANNEL_CACHE_TTL_MS,
  });
}

function getCachedSlackChannelId(accountId: string, channelName: string): { id: string; name: string } | undefined {
  const key = `${accountId}:${channelName.toLowerCase()}`;
  const cached = slackChannelIdByNameCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    slackChannelIdByNameCache.delete(key);
    return undefined;
  }
  return { id: cached.id, name: cached.name };
}

async function fetchSlackConversationInfo(params: {
  token: string;
  channelId: string;
}): Promise<SlackConversationInfoResponse | null> {
  const url = new URL('https://slack.com/api/conversations.info');
  url.searchParams.set('channel', params.channelId);
  url.searchParams.set('include_num_members', 'false');
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.token}`,
      },
      signal: AbortSignal.timeout(SLACK_LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as SlackConversationInfoResponse;
  } catch {
    return null;
  }
}

async function fetchSlackChannelByName(params: {
  token: string;
  channelName: string;
}): Promise<{ id: string; name: string } | null> {
  let cursor = '';
  const wantedName = params.channelName.toLowerCase();

  while (true) {
    const url = new URL('https://slack.com/api/conversations.list');
    url.searchParams.set('exclude_archived', 'true');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('types', 'public_channel,private_channel');
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    let payload: SlackConversationsListResponse | null = null;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${params.token}`,
        },
        signal: AbortSignal.timeout(SLACK_LOOKUP_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      payload = (await res.json()) as SlackConversationsListResponse;
    } catch {
      return null;
    }

    if (!payload?.ok) return null;
    for (const channel of payload.channels ?? []) {
      const channelId = channel.id?.trim();
      const name = (channel.name_normalized ?? channel.name ?? '').trim();
      if (!channelId || !name) continue;
      if (name.toLowerCase() !== wantedName) continue;
      return { id: channelId.toUpperCase(), name };
    }

    const nextCursor = payload.response_metadata?.next_cursor?.trim();
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return null;
}

function createSlackScopeResolver(cfg: Record<string, any>, logger: HandlerContext['logger']) {
  const accounts = listSlackAccountIds(cfg)
    .map((accountId) => ({
      accountId: accountId.toLowerCase(),
      token: resolveSlackBotTokenForAccount(cfg, accountId),
    }))
    .filter((entry): entry is { accountId: string; token: string } => Boolean(entry.token));

  const defaultAccountId = accounts[0]?.accountId ?? DEFAULT_SLACK_ACCOUNT_ID;

  const selectAccounts = (accountHint?: string): Array<{ accountId: string; token: string }> => {
    const normalizedHint = normalizeAccountId(accountHint);
    if (!normalizedHint) return accounts;
    return accounts.filter((account) => account.accountId === normalizedHint);
  };

  return async (scope: string, accountIdHint?: string): Promise<SlackScopeResolutionResult> => {
    const normalizedHint = normalizeAccountId(accountIdHint);
    const candidateAccounts = selectAccounts(normalizedHint);
    if (normalizedHint && candidateAccounts.length === 0) {
      return {
        ok: false,
        error: `references unknown Slack account "${normalizedHint}".`,
      };
    }

    const canonical = normalizeSlackBindingScope(scope);
    if (canonical) {
      if (!canonical.startsWith('channel:')) {
        return {
          ok: true,
          canonicalScope: canonical,
          accountId: normalizedHint ?? defaultAccountId,
        };
      }

      const channelId = canonical.slice('channel:'.length);
      if (!channelId) {
        return {
          ok: true,
          canonicalScope: canonical,
          accountId: normalizedHint ?? defaultAccountId,
        };
      }

      const accountsForLookup = candidateAccounts.length > 0 ? candidateAccounts : accounts;
      const cachedName = accountsForLookup[0]
        ? getCachedSlackChannelName(accountsForLookup[0].accountId, channelId)
        : undefined;
      if (cachedName) {
        return {
          ok: true,
          canonicalScope: canonical,
          accountId: accountsForLookup[0].accountId,
          displayScope: `#${cachedName}`,
        };
      }

      if (accountsForLookup.length === 0) {
        return {
          ok: true,
          canonicalScope: canonical,
          accountId: normalizedHint ?? defaultAccountId,
        };
      }

      for (const account of accountsForLookup) {
        const info = await fetchSlackConversationInfo({ token: account.token, channelId });
        if (!info?.ok || !info.channel?.id) continue;
        const channelName = (info.channel.name_normalized ?? info.channel.name ?? '').trim();
        if (!channelName) continue;
        setCachedSlackChannelName(account.accountId, info.channel.id, channelName);
        return {
          ok: true,
          canonicalScope: canonical,
          accountId: account.accountId,
          displayScope: `#${channelName}`,
        };
      }

      return {
        ok: true,
        canonicalScope: canonical,
        accountId: normalizedHint ?? defaultAccountId,
      };
    }

    const channelName = normalizeSlackChannelNameScope(scope);
    if (!channelName) {
      const trimmedScope = scope.trim();
      const looksLikeDisplayLabel = /\s+#/.test(trimmedScope)
        && !trimmedScope.startsWith('#')
        && !/^[a-z0-9._-]+:#/i.test(trimmedScope)
        && !/^account:[a-z0-9._-]+:/i.test(trimmedScope)
        && !/^channel:/i.test(trimmedScope)
        && !/^user:/i.test(trimmedScope)
        && !/^slack:/i.test(trimmedScope);
      if (looksLikeDisplayLabel) {
        return {
          ok: false,
          error:
            `Invalid Slack scope "${scope}". ` +
            'This looks like a display label. Use account ID scope (e.g. lilagames:#team-product) ' +
            'or channel:<ID> (e.g. channel:C01JZCR4ATU).',
        };
      }
      return {
        ok: false,
        error:
          `Invalid Slack scope "${scope}". ` +
          'Use channel:<ID>, user:<ID>, #channel, account:#channel, channel:<name>, or slack:*.',
      };
    }

    if (candidateAccounts.length === 0) {
      return {
        ok: false,
        error:
          `Cannot resolve Slack channel "${channelName}" because no Slack bot token is configured. ` +
          'Set channels.slack.accounts.<id>.botToken (or channels.slack.botToken/SLACK_BOT_TOKEN for default).',
      };
    }

    if (!normalizedHint && candidateAccounts.length > 1) {
      return {
        ok: false,
        error:
          `is ambiguous across Slack accounts for channel "${channelName}". ` +
          'Prefix scope with an account, e.g. kimfamily:#general or account:kimfamily:#general.',
      };
    }

    for (const account of candidateAccounts) {
      const cached = getCachedSlackChannelId(account.accountId, channelName);
      if (cached) {
        return {
          ok: true,
          canonicalScope: `channel:${cached.id.toUpperCase()}`,
          accountId: account.accountId,
          displayScope: `#${cached.name}`,
        };
      }

      const resolved = await fetchSlackChannelByName({
        token: account.token,
        channelName,
      });
      if (!resolved) continue;
      setCachedSlackChannelName(account.accountId, resolved.id, resolved.name);
      return {
        ok: true,
        canonicalScope: `channel:${resolved.id.toUpperCase()}`,
        accountId: account.accountId,
        displayScope: `#${resolved.name}`,
      };
    }

    logger.warn(
      `ClawTalk: Slack channel lookup failed for scope "${scope}"` +
      `${normalizedHint ? ` account=${normalizedHint}` : ''}`,
    );
    return {
      ok: false,
      error:
        `Slack channel "${channelName}" not found or not visible to the configured Slack bot token. ` +
        'Invite the bot to the channel or use channel:<ID>.',
    };
  };
}

export async function normalizeAndValidatePlatformBindingsInput(
  input: unknown,
  options?: PlatformBindingsValidationOptions,
): Promise<PlatformBindingsValidationResult> {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'platformBindings must be an array' };
  }

  const normalized: PlatformBinding[] = [];
  const ownershipKeys = new Set<string>();

  for (let i = 0; i < input.length; i += 1) {
    const entry = input[i];
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: `platformBindings[${i + 1}] must be an object` };
    }
    const row = entry as Record<string, unknown>;
    const platform = typeof row.platform === 'string' ? row.platform.trim().toLowerCase() : '';
    const rawScope = typeof row.scope === 'string' ? row.scope.trim() : '';
    const parsedScopedInput = platform === 'slack'
      ? parseScopedSlackInput(rawScope)
      : { scope: rawScope };
    const scope = parsedScopedInput.scope.trim();
    if (!platform || !scope) {
      return { ok: false, error: `platformBindings[${i + 1}] requires platform and scope` };
    }

    const permission = normalizePermission(row.permission);
    let normalizedScope = scope;
    let accountId = normalizeAccountId(
      typeof row.accountId === 'string' ? row.accountId : undefined,
    ) ?? normalizeAccountId(parsedScopedInput.accountId);
    let displayScope = typeof row.displayScope === 'string' ? row.displayScope.trim() : '';
    if (platform === 'slack') {
      if (options?.resolveSlackScope) {
        const resolved = await options.resolveSlackScope(scope, accountId);
        if (!resolved.ok) {
          return { ok: false, error: `platformBindings[${i + 1}] ${resolved.error}` };
        }
        normalizedScope = resolved.canonicalScope;
        accountId = normalizeAccountId(resolved.accountId) ?? accountId;
        if (resolved.displayScope) {
          displayScope = resolved.displayScope.trim();
        }
      } else {
        const canonicalScope = normalizeSlackBindingScope(scope);
        if (!canonicalScope) {
          return {
            ok: false,
            error:
              `platformBindings[${i + 1}] has invalid Slack scope "${scope}". ` +
              'Use channel:<ID>, user:<ID>, #channel, account:#channel, or slack:*.',
          };
        }
        normalizedScope = canonicalScope;
        accountId = accountId ?? DEFAULT_SLACK_ACCOUNT_ID;
      }

      if (!normalizedScope) {
        return {
          ok: false,
          error:
            `platformBindings[${i + 1}] has invalid Slack scope "${scope}". ` +
            'Use channel:<ID>, user:<ID>, #channel, account:#channel, channel:<name>, or slack:*.',
        };
      }
      if (canWrite(permission)) {
        const ownershipAccountId = accountId ?? DEFAULT_SLACK_ACCOUNT_ID;
        ownershipKeys.add(`slack:${ownershipAccountId}:${normalizedScope.toLowerCase()}`);
      }
    }

    normalized.push({
      ...row,
      platform,
      scope: normalizedScope,
      ...(accountId ? { accountId } : {}),
      ...(displayScope ? { displayScope } : {}),
      permission,
    } as PlatformBinding);
  }

  return {
    ok: true,
    bindings: normalized,
    ownershipKeys: Array.from(ownershipKeys),
  };
}

export function normalizeAndValidatePlatformBehaviorsInput(
  input: unknown,
  params: {
    bindings: PlatformBinding[];
    agents: TalkAgent[];
  },
): PlatformBehaviorsValidationResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'platformBehaviors must be an array' };
  }

  const now = Date.now();
  const bindingIds = new Set(params.bindings.map((binding) => binding.id));
  const agentNames = new Set((params.agents ?? []).map((agent) => agent.name.toLowerCase()));
  const seenBindingIds = new Set<string>();
  const normalized: PlatformBehavior[] = [];

  for (let i = 0; i < input.length; i += 1) {
    const entry = input[i];
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: `platformBehaviors[${i + 1}] must be an object` };
    }
    const row = entry as Record<string, unknown>;
    const platformBindingId = typeof row.platformBindingId === 'string' ? row.platformBindingId.trim() : '';
    if (!platformBindingId) {
      return { ok: false, error: `platformBehaviors[${i + 1}] requires platformBindingId` };
    }
    if (!bindingIds.has(platformBindingId)) {
      return {
        ok: false,
        error:
          `platformBehaviors[${i + 1}] references unknown binding "${platformBindingId}". ` +
          'Use /platform list to get a valid platformN first.',
      };
    }
    if (seenBindingIds.has(platformBindingId)) {
      return {
        ok: false,
        error:
          `platformBehaviors has multiple entries for binding "${platformBindingId}". ` +
          'Use one behavior per binding.',
      };
    }
    seenBindingIds.add(platformBindingId);

    const agentName = typeof row.agentName === 'string' ? row.agentName.trim() : '';
    if (agentName && !agentNames.has(agentName.toLowerCase())) {
      return {
        ok: false,
        error:
          `platformBehaviors[${i + 1}] references unknown agent "${agentName}". ` +
          'Add the agent first or omit agentName to use the primary talk agent.',
      };
    }

    const onMessagePrompt = typeof row.onMessagePrompt === 'string' ? row.onMessagePrompt.trim() : '';
    const autoRespond = typeof row.autoRespond === 'boolean' ? row.autoRespond : undefined;
    if (!agentName && !onMessagePrompt && autoRespond !== false) {
      return {
        ok: false,
        error:
          `platformBehaviors[${i + 1}] must define agentName and/or onMessagePrompt, or set autoRespond=false.`,
      };
    }

    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : randomUUID();
    const createdAt = typeof row.createdAt === 'number' ? row.createdAt : now;
    const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : now;

    normalized.push({
      id,
      platformBindingId,
      ...(autoRespond !== undefined ? { autoRespond } : {}),
      ...(agentName ? { agentName } : {}),
      ...(onMessagePrompt ? { onMessagePrompt } : {}),
      createdAt,
      updatedAt,
    });
  }

  return { ok: true, behaviors: normalized };
}

export function findSlackBindingConflicts(params: {
  candidateOwnershipKeys: string[];
  talks: TalkMeta[];
  skipTalkId?: string;
}): Array<{ scope: string; talkId: string }> {
  const keySet = new Set(params.candidateOwnershipKeys.map((value) => value.toLowerCase()));
  if (keySet.size === 0) return [];

  const conflicts = new Map<string, { scope: string; talkId: string }>();
  for (const talk of params.talks) {
    if (params.skipTalkId && talk.id === params.skipTalkId) continue;
    for (const binding of talk.platformBindings ?? []) {
      if (binding.platform.trim().toLowerCase() !== 'slack') continue;
      const permission = normalizePermission(binding.permission);
      if (!canWrite(permission)) continue;
      const canonicalScope = normalizeSlackBindingScope(binding.scope);
      if (!canonicalScope) continue;
      const accountId = normalizeAccountId(binding.accountId) ?? DEFAULT_SLACK_ACCOUNT_ID;
      const key = `slack:${accountId}:${canonicalScope.toLowerCase()}`;
      if (!keySet.has(key)) continue;
      const mapKey = `${talk.id}:${key}`;
      conflicts.set(mapKey, { scope: canonicalScope, talkId: talk.id });
    }
  }
  return Array.from(conflicts.values());
}

/**
 * Route a /api/talks request to the appropriate handler.
 * Returns true if the request was handled.
 */
export async function handleTalks(ctx: HandlerContext, store: TalkStore, registry?: ToolRegistry): Promise<void> {
  const { req, res, url } = ctx;
  const pathname = url.pathname;

  // POST /api/talks — create
  if (pathname === '/api/talks' && req.method === 'POST') {
    return handleCreateTalk(ctx, store);
  }

  // GET /api/talks — list
  if (pathname === '/api/talks' && req.method === 'GET') {
    return handleListTalks(ctx, store);
  }

  // Match /api/talks/:id patterns
  const talkMatch = pathname.match(/^\/api\/talks\/([\w-]+)$/);
  if (talkMatch) {
    const talkId = talkMatch[1];
    if (req.method === 'GET') return handleGetTalk(ctx, store, talkId);
    if (req.method === 'PATCH') return handleUpdateTalk(ctx, store, talkId);
    if (req.method === 'DELETE') return handleDeleteTalk(ctx, store, talkId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET/DELETE /api/talks/:id/messages
  const messagesMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/messages$/);
  if (messagesMatch) {
    if (req.method === 'DELETE') return handleDeleteMessages(ctx, store, messagesMatch[1]);
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    return handleGetMessages(ctx, store, messagesMatch[1]);
  }

  // GET/PATCH /api/talks/:id/tools
  const toolsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/tools$/);
  if (toolsMatch) {
    const talkId = toolsMatch[1];
    if (req.method === 'GET') return handleGetTalkTools(ctx, store, talkId, registry);
    if (req.method === 'PATCH') return handleUpdateTalkTools(ctx, store, talkId, registry);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // POST/DELETE /api/talks/:id/pin/:msgId
  const pinMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/pin\/([\w-]+)$/);
  if (pinMatch) {
    const [, talkId, msgId] = pinMatch;
    if (req.method === 'POST') return handleAddPin(ctx, store, talkId, msgId);
    if (req.method === 'DELETE') return handleRemovePin(ctx, store, talkId, msgId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // POST/GET /api/talks/:id/jobs
  const jobsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/jobs$/);
  if (jobsMatch) {
    const talkId = jobsMatch[1];
    if (req.method === 'POST') return handleCreateJob(ctx, store, talkId);
    if (req.method === 'GET') return handleListJobs(ctx, store, talkId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // PATCH/DELETE /api/talks/:id/jobs/:jobId
  const jobMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/jobs\/([\w-]+)$/);
  if (jobMatch) {
    const [, talkId, jobId] = jobMatch;
    if (req.method === 'PATCH') return handleUpdateJob(ctx, store, talkId, jobId);
    if (req.method === 'DELETE') return handleDeleteJob(ctx, store, talkId, jobId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET /api/talks/:id/jobs/:jobId/reports
  const reportsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/jobs\/([\w-]+)\/reports$/);
  if (reportsMatch) {
    const [, talkId, jobId] = reportsMatch;
    if (req.method === 'GET') return handleGetReports(ctx, store, talkId, jobId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET /api/talks/:id/reports (all reports for a talk)
  const talkReportsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/reports$/);
  if (talkReportsMatch) {
    if (req.method === 'GET') return handleGetReports(ctx, store, talkReportsMatch[1]);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // POST/GET /api/talks/:id/agents
  const agentsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/agents$/);
  if (agentsMatch) {
    const talkId = agentsMatch[1];
    if (req.method === 'POST') return handleAddAgent(ctx, store, talkId);
    if (req.method === 'GET') return handleListAgents(ctx, store, talkId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // DELETE /api/talks/:id/agents/:name
  const agentMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/agents\/([\w-]+)$/);
  if (agentMatch) {
    const [, talkId, agentName] = agentMatch;
    if (req.method === 'DELETE') return handleDeleteAgent(ctx, store, talkId, agentName);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCreateTalk(ctx: HandlerContext, store: TalkStore): Promise<void> {
  let body: {
    model?: string;
    topicTitle?: string;
    objective?: string;
    objectives?: string | string[];
    directives?: any[];
    rules?: any[];
    platformBindings?: any[];
    channelConnections?: any[];
    platformBehaviors?: any[];
    channelResponseSettings?: any[];
    toolMode?: string;
    toolsAllow?: string[];
    toolsDeny?: string[];
    toolPolicy?: {
      mode?: string;
      allow?: string[];
      deny?: string[];
    };
  } = {};
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    // empty body is fine
  }

  if (body.objective === undefined && body.objectives !== undefined) {
    body.objective = normalizeObjectiveAlias(body.objectives);
  }
  if (body.directives === undefined && body.rules !== undefined) {
    body.directives = body.rules;
  }
  if (body.platformBindings === undefined && body.channelConnections !== undefined) {
    body.platformBindings = body.channelConnections;
  }
  if (body.platformBehaviors === undefined && body.channelResponseSettings !== undefined) {
    body.platformBehaviors = mapChannelResponseSettingsInput(body.channelResponseSettings) as any[];
  }
  if (body.toolMode === undefined && body.toolPolicy?.mode !== undefined) {
    body.toolMode = body.toolPolicy.mode;
  }
  if (body.toolsAllow === undefined && body.toolPolicy?.allow !== undefined) {
    body.toolsAllow = body.toolPolicy.allow;
  }
  if (body.toolsDeny === undefined && body.toolPolicy?.deny !== undefined) {
    body.toolsDeny = body.toolPolicy.deny;
  }

  const toolMode = normalizeToolModeInput(body.toolMode);
  if (body.toolMode !== undefined && toolMode === undefined) {
    sendJson(ctx.res, 400, { error: 'toolMode must be one of: off, confirm, auto' });
    return;
  }
  const toolsAllow = normalizeToolNameListInput(body.toolsAllow);
  const toolsDeny = normalizeToolNameListInput(body.toolsDeny);

  if (body.platformBindings !== undefined) {
    const parsed = await normalizeAndValidatePlatformBindingsInput(body.platformBindings, {
      resolveSlackScope: createSlackScopeResolver(ctx.cfg, ctx.logger),
    });
    if (!parsed.ok) {
      sendJson(ctx.res, 400, { error: parsed.error });
      return;
    }
    const conflicts = findSlackBindingConflicts({
      candidateOwnershipKeys: parsed.ownershipKeys,
      talks: store.listTalks(),
    });
    if (conflicts.length > 0) {
      const conflict = conflicts[0];
      sendJson(ctx.res, 409, {
        error:
          `Slack ownership conflict for scope "${conflict.scope}". ` +
          `Already claimed by talk ${conflict.talkId}.`,
      });
      return;
    }
    body.platformBindings = parsed.bindings;
  }

  if (body.platformBehaviors !== undefined) {
    const behaviorParse = normalizeAndValidatePlatformBehaviorsInput(body.platformBehaviors, {
      bindings: body.platformBindings ?? [],
      agents: [],
    });
    if (!behaviorParse.ok) {
      sendJson(ctx.res, 400, { error: behaviorParse.error });
      return;
    }
    body.platformBehaviors = behaviorParse.behaviors;
  }

  const talk = store.createTalk(body.model);
  store.updateTalk(talk.id, {
    ...(body.topicTitle ? { topicTitle: body.topicTitle } : {}),
    ...(body.objective ? { objective: body.objective } : {}),
    ...(body.directives !== undefined ? { directives: body.directives } : {}),
    ...(body.platformBindings !== undefined ? { platformBindings: body.platformBindings } : {}),
    ...(body.platformBehaviors !== undefined ? { platformBehaviors: body.platformBehaviors } : {}),
    ...(toolMode !== undefined ? { toolMode } : {}),
    ...(toolsAllow !== undefined ? { toolsAllow } : {}),
    ...(toolsDeny !== undefined ? { toolsDeny } : {}),
  });

  void reconcileSlackRoutingForTalks(store.listTalks(), ctx.logger);

  sendJson(ctx.res, 201, store.getTalk(talk.id) ?? talk);
}

async function handleListTalks(ctx: HandlerContext, store: TalkStore): Promise<void> {
  const talks = store.listTalks();
  sendJson(ctx.res, 200, { talks });
}

async function handleGetTalk(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const contextMd = await store.getContextMd(talkId);
  sendJson(ctx.res, 200, { ...talk, contextMd });
}

function selectTalkTools(
  allTools: Array<{ name: string; description: string; builtin: boolean }>,
  allow: string[] | undefined,
  deny: string[] | undefined,
  isToolEnabled?: (toolName: string) => boolean,
): Array<{ name: string; description: string; builtin: boolean }> {
  const allowSet = new Set((allow ?? []).map((n) => n.toLowerCase()));
  const denySet = new Set((deny ?? []).map((n) => n.toLowerCase()));
  return allTools.filter((tool) => {
    const key = tool.name.toLowerCase();
    if (isToolEnabled && !isToolEnabled(key)) return false;
    if (denySet.has(key)) return false;
    if (allowSet.size > 0 && !allowSet.has(key)) return false;
    return true;
  });
}

async function handleGetTalkTools(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
  registry?: ToolRegistry,
): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const catalog = getToolCatalog(ctx.pluginCfg.dataDir, ctx.logger);
  const registeredTools = registry?.listTools() ?? [];
  const allTools = catalog.filterEnabledTools(registeredTools);
  const enabledTools = selectTalkTools(allTools, talk.toolsAllow, talk.toolsDeny);
  sendJson(ctx.res, 200, {
    talkId,
    toolMode: talk.toolMode ?? 'auto',
    toolsAllow: talk.toolsAllow ?? [],
    toolsDeny: talk.toolsDeny ?? [],
    availableTools: allTools,
    enabledTools,
  });
}

async function handleUpdateTalkTools(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
  registry?: ToolRegistry,
): Promise<void> {
  let body: {
    toolMode?: string;
    toolsAllow?: string[];
    toolsDeny?: string[];
  };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const toolMode = normalizeToolModeInput(body.toolMode);
  if (body.toolMode !== undefined && toolMode === undefined) {
    sendJson(ctx.res, 400, { error: 'toolMode must be one of: off, confirm, auto' });
    return;
  }
  const toolsAllow = normalizeToolNameListInput(body.toolsAllow);
  const toolsDeny = normalizeToolNameListInput(body.toolsDeny);

  const updated = store.updateTalk(talkId, {
    ...(toolMode !== undefined ? { toolMode } : {}),
    ...(toolsAllow !== undefined ? { toolsAllow } : {}),
    ...(toolsDeny !== undefined ? { toolsDeny } : {}),
  });
  if (!updated) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const catalog = getToolCatalog(ctx.pluginCfg.dataDir, ctx.logger);
  const registeredTools = registry?.listTools() ?? [];
  const allTools = catalog.filterEnabledTools(registeredTools);
  const enabledTools = selectTalkTools(allTools, updated.toolsAllow, updated.toolsDeny);
  sendJson(ctx.res, 200, {
    talkId,
    toolMode: updated.toolMode ?? 'auto',
    toolsAllow: updated.toolsAllow ?? [],
    toolsDeny: updated.toolsDeny ?? [],
    availableTools: allTools,
    enabledTools,
  });
}

async function handleUpdateTalk(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  let body: {
    topicTitle?: string;
    objective?: string;
    objectives?: string | string[];
    model?: string;
    agents?: any[];
    directives?: any[];
    rules?: any[];
    platformBindings?: any[];
    channelConnections?: any[];
    platformBehaviors?: any[];
    channelResponseSettings?: any[];
    toolMode?: string;
    toolsAllow?: string[];
    toolsDeny?: string[];
    toolPolicy?: {
      mode?: string;
      allow?: string[];
      deny?: string[];
    };
  };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  if (body.objective === undefined && body.objectives !== undefined) {
    body.objective = normalizeObjectiveAlias(body.objectives);
  }
  if (body.directives === undefined && body.rules !== undefined) {
    body.directives = body.rules;
  }
  if (body.platformBindings === undefined && body.channelConnections !== undefined) {
    body.platformBindings = body.channelConnections;
  }
  if (body.platformBehaviors === undefined && body.channelResponseSettings !== undefined) {
    body.platformBehaviors = mapChannelResponseSettingsInput(body.channelResponseSettings) as any[];
  }
  if (body.toolMode === undefined && body.toolPolicy?.mode !== undefined) {
    body.toolMode = body.toolPolicy.mode;
  }
  if (body.toolsAllow === undefined && body.toolPolicy?.allow !== undefined) {
    body.toolsAllow = body.toolPolicy.allow;
  }
  if (body.toolsDeny === undefined && body.toolPolicy?.deny !== undefined) {
    body.toolsDeny = body.toolPolicy.deny;
  }

  const toolMode = normalizeToolModeInput(body.toolMode);
  if (body.toolMode !== undefined && toolMode === undefined) {
    sendJson(ctx.res, 400, { error: 'toolMode must be one of: off, confirm, auto' });
    return;
  }
  const toolsAllow = normalizeToolNameListInput(body.toolsAllow);
  const toolsDeny = normalizeToolNameListInput(body.toolsDeny);

  if (body.platformBindings !== undefined) {
    const parsed = await normalizeAndValidatePlatformBindingsInput(body.platformBindings, {
      resolveSlackScope: createSlackScopeResolver(ctx.cfg, ctx.logger),
    });
    if (!parsed.ok) {
      sendJson(ctx.res, 400, { error: parsed.error });
      return;
    }
    const conflicts = findSlackBindingConflicts({
      candidateOwnershipKeys: parsed.ownershipKeys,
      talks: store.listTalks(),
      skipTalkId: talkId,
    });
    if (conflicts.length > 0) {
      const conflict = conflicts[0];
      sendJson(ctx.res, 409, {
        error:
          `Slack ownership conflict for scope "${conflict.scope}". ` +
          `Already claimed by talk ${conflict.talkId}.`,
      });
      return;
    }
    body.platformBindings = parsed.bindings;
  }

  if (body.platformBehaviors !== undefined) {
    const effectiveBindings = body.platformBindings ?? (talk.platformBindings ?? []);
    const effectiveAgents = body.agents ?? (talk.agents ?? []);
    const behaviorParse = normalizeAndValidatePlatformBehaviorsInput(body.platformBehaviors, {
      bindings: effectiveBindings,
      agents: effectiveAgents,
    });
    if (!behaviorParse.ok) {
      sendJson(ctx.res, 400, { error: behaviorParse.error });
      return;
    }
    body.platformBehaviors = behaviorParse.behaviors;
  }

  if (body.agents !== undefined) {
    await store.setAgents(talkId, body.agents);
  }
  if (body.directives !== undefined) {
    await store.setDirectives(talkId, body.directives);
  }
  if (body.platformBindings !== undefined) {
    await store.setPlatformBindings(talkId, body.platformBindings);
  }
  if (body.platformBehaviors !== undefined) {
    await store.setPlatformBehaviors(talkId, body.platformBehaviors);
  }

  const updated = store.updateTalk(talkId, {
    topicTitle: body.topicTitle,
    objective: body.objective,
    model: body.model,
    directives: body.directives,
    platformBindings: body.platformBindings,
    platformBehaviors: body.platformBehaviors,
    toolMode,
    toolsAllow,
    toolsDeny,
  });
  if (!updated) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  void reconcileSlackRoutingForTalks(store.listTalks(), ctx.logger);
  sendJson(ctx.res, 200, updated);
}

async function handleDeleteTalk(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const success = store.deleteTalk(talkId);
  if (!success) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  void reconcileSlackRoutingForTalks(store.listTalks(), ctx.logger);
  sendJson(ctx.res, 200, { ok: true });
}

async function handleGetMessages(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const limit = parseInt(ctx.url.searchParams.get('limit') ?? '100', 10);
  const afterId = ctx.url.searchParams.get('after') ?? undefined;

  let messages = await store.getMessages(talkId);

  // Pagination: skip messages up to and including `after`
  if (afterId) {
    const idx = messages.findIndex(m => m.id === afterId);
    if (idx !== -1) {
      messages = messages.slice(idx + 1);
    }
  }

  // Apply limit
  messages = messages.slice(-limit);

  sendJson(ctx.res, 200, { messages });
}

async function handleDeleteMessages(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  let body: { messageIds?: string[] };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!Array.isArray(body.messageIds) || body.messageIds.length === 0) {
    sendJson(ctx.res, 400, { error: 'messageIds must be a non-empty array' });
    return;
  }

  const result = await store.deleteMessages(talkId, body.messageIds);
  sendJson(ctx.res, 200, result);
}

async function handleAddPin(ctx: HandlerContext, store: TalkStore, talkId: string, msgId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const success = store.addPin(talkId, msgId);
  if (!success) {
    sendJson(ctx.res, 409, { error: 'Already pinned' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true, pinnedMessageIds: talk.pinnedMessageIds });
}

async function handleRemovePin(ctx: HandlerContext, store: TalkStore, talkId: string, msgId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const success = store.removePin(talkId, msgId);
  if (!success) {
    sendJson(ctx.res, 404, { error: 'Pin not found' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true, pinnedMessageIds: talk.pinnedMessageIds });
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function handleCreateJob(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  let body: { schedule?: string; prompt?: string };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.schedule || !body.prompt) {
    sendJson(ctx.res, 400, { error: 'Missing schedule or prompt' });
    return;
  }

  const scheduleError = validateSchedule(body.schedule);
  if (scheduleError) {
    sendJson(ctx.res, 400, { error: scheduleError });
    return;
  }

  // Detect event-driven jobs and validate scope against platform bindings
  const eventScope = parseEventTrigger(body.schedule);
  let jobType: 'once' | 'recurring' | 'event';
  if (/^(in\s|at\s)/i.test(body.schedule)) {
    jobType = 'once';
  } else {
    jobType = 'recurring';
  }

  if (eventScope) {
    const bindings = talk.platformBindings ?? [];

    // Resolve platformN shorthand → real scope
    let resolvedScope = eventScope;
    const platformMatch = eventScope.match(/^platform(\d+)$/i);
    if (platformMatch) {
      const idx = parseInt(platformMatch[1], 10);
      if (idx < 1 || idx > bindings.length) {
        sendJson(ctx.res, 400, {
          error: `No platform binding at position ${idx}. This talk has ${bindings.length} binding(s). Use /platform list to see them.`,
        });
        return;
      }
      resolvedScope = bindings[idx - 1].scope;
    }

    const matchingBinding = bindings.find(
      b => b.scope.toLowerCase() === resolvedScope.toLowerCase(),
    );
    if (!matchingBinding) {
      sendJson(ctx.res, 400, {
        error: `No platform binding found for "${resolvedScope}". Add one with /platform <name> ${resolvedScope} <permission>, or use platformN shorthand.`,
      });
      return;
    }
    // Rewrite schedule with resolved scope so downstream always sees real scope
    body.schedule = `on ${resolvedScope}`;
    jobType = 'event';
  }

  const job = store.addJob(talkId, body.schedule, body.prompt, jobType);
  if (!job) {
    sendJson(ctx.res, 500, { error: 'Failed to create job' });
    return;
  }
  sendJson(ctx.res, 201, job);
}

async function handleListJobs(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const jobs = store.listJobs(talkId);
  sendJson(ctx.res, 200, { jobs });
}

async function handleUpdateJob(ctx: HandlerContext, store: TalkStore, talkId: string, jobId: string): Promise<void> {
  let body: { active?: boolean; schedule?: string; prompt?: string };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (body.schedule) {
    const scheduleError = validateSchedule(body.schedule);
    if (scheduleError) {
      sendJson(ctx.res, 400, { error: scheduleError });
      return;
    }
  }

  const updated = store.updateJob(talkId, jobId, body);
  if (!updated) {
    sendJson(ctx.res, 404, { error: 'Job not found' });
    return;
  }
  sendJson(ctx.res, 200, updated);
}

async function handleDeleteJob(ctx: HandlerContext, store: TalkStore, talkId: string, jobId: string): Promise<void> {
  const success = store.deleteJob(talkId, jobId);
  if (!success) {
    sendJson(ctx.res, 404, { error: 'Job not found' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true });
}

async function handleGetReports(ctx: HandlerContext, store: TalkStore, talkId: string, jobId?: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const limit = parseInt(ctx.url.searchParams.get('limit') ?? '20', 10);
  const sinceParam = ctx.url.searchParams.get('since');
  const since = sinceParam ? parseInt(sinceParam, 10) : undefined;
  const reports = await store.getRecentReports(talkId, limit, jobId, since);
  sendJson(ctx.res, 200, { reports });
}

// ---------------------------------------------------------------------------
// Agent handlers
// ---------------------------------------------------------------------------

async function handleAddAgent(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  let body: { name?: string; model?: string; role?: string; isPrimary?: boolean };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.name || !body.model || !body.role) {
    sendJson(ctx.res, 400, { error: 'Missing name, model, or role' });
    return;
  }

  const agent = await store.addAgent(talkId, {
    name: body.name,
    model: body.model,
    role: body.role as any,
    isPrimary: body.isPrimary ?? false,
  });
  sendJson(ctx.res, 201, agent);
}

async function handleListAgents(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const agents = store.listAgents(talkId);
  sendJson(ctx.res, 200, { agents });
}

async function handleDeleteAgent(ctx: HandlerContext, store: TalkStore, talkId: string, agentName: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  try {
    await store.removeAgent(talkId, agentName);
  } catch {
    sendJson(ctx.res, 404, { error: 'Agent not found' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Route /api/tools requests for managing the tool registry.
 */
export async function handleToolRoutes(ctx: HandlerContext, registry: ToolRegistry): Promise<void> {
  const { req, res, url } = ctx;
  const pathname = url.pathname;
  const catalog = getToolCatalog(ctx.pluginCfg.dataDir, ctx.logger);

  // PATCH /api/tools — built-in tool management actions
  if (pathname === '/api/tools' && req.method === 'PATCH') {
    let body:
      | {
          action?: 'google_auth_status';
        }
      | {
          action?: 'google_auth_config';
          refreshToken?: string;
          clientId?: string;
          clientSecret?: string;
          tokenUri?: string;
        };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (body.action === 'google_auth_status') {
      const status = await googleDocsAuthStatus();
      sendJson(res, 200, { status });
      return;
    }

    if (body.action === 'google_auth_config') {
      const payload = body as {
        refreshToken?: string;
        clientId?: string;
        clientSecret?: string;
        tokenUri?: string;
      };
      if (
        payload.refreshToken === undefined
        && payload.clientId === undefined
        && payload.clientSecret === undefined
        && payload.tokenUri === undefined
      ) {
        sendJson(res, 400, { error: 'Expected at least one of: refreshToken, clientId, clientSecret, tokenUri' });
        return;
      }
      const updated = await upsertGoogleDocsAuthConfig({
        refreshToken: payload.refreshToken,
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        tokenUri: payload.tokenUri,
      });
      const status = await googleDocsAuthStatus();
      sendJson(res, 200, { updated, status });
      return;
    }

    sendJson(res, 400, { error: 'Unknown PATCH /api/tools action' });
    return;
  }

  // GET /api/tools — list all tools
  if (pathname === '/api/tools' && req.method === 'GET') {
    const tools = registry.listTools();
    const catalogEntries = catalog.list(tools);
    sendJson(res, 200, {
      tools,
      installedTools: catalog.filterEnabledTools(tools),
      catalog: catalogEntries,
      installedCatalogIds: catalog.getInstalledIds(),
    });
    return;
  }

  // GET /api/tools/catalog — list tool catalog + installed state
  if (pathname === '/api/tools/catalog' && req.method === 'GET') {
    const tools = registry.listTools();
    const catalogEntries = catalog.list(tools);
    const catalogWithAuth = await Promise.all(
      catalogEntries.map(async (entry) => ({
        ...entry,
        auth: await resolveCatalogAuth(entry.requiredAuth),
      })),
    );
    sendJson(res, 200, {
      catalog: catalogWithAuth,
      installedCatalogIds: catalog.getInstalledIds(),
      installedTools: catalog.filterEnabledTools(tools),
      registeredTools: tools,
    });
    return;
  }

  // POST /api/tools/catalog/install — install a catalog tool by id
  if (pathname === '/api/tools/catalog/install' && req.method === 'POST') {
    let body: { id?: string };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const id = body.id?.trim();
    if (!id) {
      sendJson(res, 400, { error: 'Missing required field: id' });
      return;
    }
    const result = catalog.install(id, registry.listTools());
    if (!result.ok) {
      sendJson(res, 409, { error: result.error ?? 'Install failed' });
      return;
    }
    const auth = await resolveCatalogAuth(result.entry?.requiredAuth);
    sendJson(res, 200, {
      ok: true,
      installed: result.entry,
      auth,
      authSetupRecommended: !auth.ready,
    });
    return;
  }

  // POST /api/tools/catalog/uninstall — uninstall a catalog tool by id
  if (pathname === '/api/tools/catalog/uninstall' && req.method === 'POST') {
    let body: { id?: string };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const id = body.id?.trim();
    if (!id) {
      sendJson(res, 400, { error: 'Missing required field: id' });
      return;
    }
    const result = catalog.uninstall(id, registry.listTools());
    if (!result.ok) {
      sendJson(res, 404, { error: result.error ?? 'Uninstall failed' });
      return;
    }
    sendJson(res, 200, { ok: true, uninstalled: result.entry });
    return;
  }

  // POST /api/tools — register a new tool
  if (pathname === '/api/tools' && req.method === 'POST') {
    let body: { name?: string; description?: string; parameters?: any };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!body.name || !body.description) {
      sendJson(res, 400, { error: 'Missing name or description' });
      return;
    }

    const parameters = body.parameters ?? { type: 'object', properties: {} };
    const ok = registry.registerTool(body.name, body.description, parameters);
    if (!ok) {
      sendJson(res, 409, { error: `Cannot register tool "${body.name}" (name conflicts with built-in)` });
      return;
    }
    sendJson(res, 201, { ok: true, name: body.name });
    return;
  }

  // DELETE /api/tools/:name — remove a dynamic tool
  const toolNameMatch = pathname.match(/^\/api\/tools\/([\w-]+)$/);
  if (toolNameMatch && req.method === 'DELETE') {
    const name = toolNameMatch[1];
    const ok = registry.removeTool(name);
    if (!ok) {
      sendJson(res, 404, { error: `Tool "${name}" not found or is built-in` });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}
