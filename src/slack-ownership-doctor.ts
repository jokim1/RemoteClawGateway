import type { PlatformBinding, TalkMeta } from './types.js';
import { normalizeSlackBindingScope } from './talks.js';

const DEFAULT_ACCOUNT_ID = 'default';

type OpenClawSlackBinding = {
  agentId: string;
  accountId: string;
  scope: string;
  order: number;
};

export type SlackOwnershipConflict = {
  talkId: string;
  talkScope: string;
  talkAccountId: string;
  openClawAgentId: string;
  openClawScope: string;
  openClawAccountId: string;
};

function normalizeAccountId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_ACCOUNT_ID;
  const trimmed = value.trim().toLowerCase();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

function normalizeSlackScopeForOwnership(scope: string): string | null {
  return normalizeSlackBindingScope(scope)?.toLowerCase() ?? null;
}

function isWritePermission(permission: PlatformBinding['permission']): boolean {
  return permission === 'write' || permission === 'read+write';
}

function parseOpenClawSlackBindings(cfg: Record<string, unknown>): OpenClawSlackBinding[] {
  const rawBindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  const parsed: OpenClawSlackBinding[] = [];

  for (let order = 0; order < rawBindings.length; order += 1) {
    const row = rawBindings[order];
    if (!row || typeof row !== 'object') continue;
    const binding = row as Record<string, unknown>;
    const agentId = typeof binding.agentId === 'string' ? binding.agentId.trim() : '';
    if (!agentId) continue;
    const match = (binding.match && typeof binding.match === 'object')
      ? binding.match as Record<string, unknown>
      : null;
    if (!match) continue;
    const channel = typeof match.channel === 'string' ? match.channel.trim().toLowerCase() : '';
    if (channel !== 'slack') continue;

    const accountId = normalizeAccountId(match.accountId);
    const peer = (match.peer && typeof match.peer === 'object')
      ? match.peer as Record<string, unknown>
      : null;
    if (!peer) {
      parsed.push({ agentId, accountId, scope: 'slack:*', order });
      continue;
    }
    const kind = typeof peer.kind === 'string' ? peer.kind.trim().toLowerCase() : '';
    const id = typeof peer.id === 'string' ? peer.id.trim() : '';
    if (!id || !kind) continue;

    if (kind === 'channel') {
      parsed.push({ agentId, accountId, scope: `channel:${id.toUpperCase()}`.toLowerCase(), order });
      continue;
    }
    if (kind === 'user') {
      parsed.push({ agentId, accountId, scope: `user:${id.toUpperCase()}`.toLowerCase(), order });
      continue;
    }
  }

  return parsed;
}

function talkSlackBindings(talk: TalkMeta): Array<{ talkId: string; accountId: string; scope: string }> {
  const out: Array<{ talkId: string; accountId: string; scope: string }> = [];
  for (const binding of talk.platformBindings ?? []) {
    if (binding.platform.trim().toLowerCase() !== 'slack') continue;
    if (!isWritePermission(binding.permission)) continue;
    const scope = normalizeSlackScopeForOwnership(binding.scope);
    if (!scope) continue;
    out.push({
      talkId: talk.id,
      accountId: normalizeAccountId(binding.accountId),
      scope,
    });
  }
  return out;
}

function scopesConflict(talkScope: string, openClawScope: string): boolean {
  return (
    talkScope === openClawScope ||
    talkScope === 'slack:*' ||
    openClawScope === 'slack:*'
  );
}

export function findOpenClawSlackOwnershipConflicts(params: {
  talks: TalkMeta[];
  openClawConfig: Record<string, unknown>;
  clawTalkAgentIds: string[];
}): SlackOwnershipConflict[] {
  const ownedAgentIds = new Set(
    params.clawTalkAgentIds
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
  const openClawSlackBindings = parseOpenClawSlackBindings(params.openClawConfig);
  if (openClawSlackBindings.length === 0) return [];

  const conflicts: SlackOwnershipConflict[] = [];
  for (const talk of params.talks) {
    for (const talkBinding of talkSlackBindings(talk)) {
      const matching = openClawSlackBindings
        .filter((binding) =>
          talkBinding.accountId === binding.accountId
          && scopesConflict(talkBinding.scope, binding.scope),
        )
        .sort((a, b) => a.order - b.order);
      if (matching.length === 0) continue;

      const winner = matching[0];
      if (ownedAgentIds.has(winner.agentId.trim().toLowerCase())) {
        continue;
      }

      conflicts.push({
        talkId: talkBinding.talkId,
        talkScope: talkBinding.scope,
        talkAccountId: talkBinding.accountId,
        openClawAgentId: winner.agentId,
        openClawScope: winner.scope,
        openClawAccountId: winner.accountId,
      });
    }
  }
  return conflicts;
}
