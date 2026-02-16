import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { TalkStore } from './talk-store.js';
import type {
  HandlerContext,
  Logger,
  PlatformBinding,
  TalkAgent,
  TalkMessage,
  TalkMeta,
} from './types.js';
import { readJsonBody, sendJson } from './http.js';
import { composeSystemPrompt } from './system-prompt.js';
import { scheduleContextUpdate } from './context-updater.js';

const MAX_CONTEXT_MESSAGES = 50;
const MAX_CONTEXT_BUDGET_BYTES = 60 * 1024;
const MIN_HISTORY_MESSAGES = 8;
const RESERVED_OVERHEAD_BYTES = 8 * 1024;
const MIN_HISTORY_BUDGET_BYTES = 4 * 1024;
const LLM_TIMEOUT_MS = 120_000;
const SEND_TIMEOUT_MS = 30_000;
const EVENT_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_MAX_QUEUE = 1_000;
const DEFAULT_SUPPRESS_TTL_MS = 120_000;
const DEFAULT_SUPPRESS_MAX_CANCELS = 3;
const DEFAULT_PROCESS_TIMEOUT_MS = 150_000;
const SLACK_DEFAULT_ACCOUNT = 'default';

type SlackIngressEvent = {
  eventId: string;
  accountId?: string;
  channelId: string;
  channelName?: string;
  threadTs?: string;
  messageTs?: string;
  userId?: string;
  userName?: string;
  /**
   * Expected OpenClaw outbound target for this conversation (e.g. channel:C123, user:U123).
   * Used to suppress OpenClaw replies when ClawTalk owns the event.
   */
  outboundTarget?: string;
  text: string;
};

type SeenDecision = {
  ts: number;
  decision: 'handled' | 'pass';
  talkId?: string;
  reason?: string;
};

type QueueItem = {
  talkId: string;
  event: SlackIngressEvent;
  platformBindingId: string;
  attemptToken: string;
  replyAccountId?: string;
  behaviorAgentName?: string;
  behaviorOnMessagePrompt?: string;
  attempt: number;
  enqueuedAt: number;
  inboundContent?: string;
  inboundPersisted?: boolean;
  reply?: string;
  model?: string;
  sessionKey?: string;
  agentName?: string;
  agentRole?: TalkAgent['role'];
  replySent?: boolean;
  assistantPersisted?: boolean;
};

type SlackIngressEventRuntime = {
  eventId: string;
  talkId: string;
  accountId?: string;
  channelId: string;
  platformBindingId: string;
  state: 'queued' | 'running' | 'retrying' | 'done' | 'failed';
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempt: number;
  attemptToken: string;
  retries: number;
  replySent: boolean;
  persisted: boolean;
  lastError?: string;
  lastErrorAt?: number;
};

type SlackIngressTalkCounters = {
  handled: number;
  passed: number;
  queueOverflow: number;
  delivered: number;
  failed: number;
  retries: number;
};

export type SlackIngressTalkRuntimeSnapshot = {
  talkId: string;
  inflight: number;
  counters: SlackIngressTalkCounters;
  recentEvents: Array<{
    eventId: string;
    accountId?: string;
    channelId: string;
    state: 'queued' | 'running' | 'retrying' | 'done' | 'failed';
    attempt: number;
    retries: number;
    queuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    replySent: boolean;
    persisted: boolean;
    lastError?: string;
    lastErrorAt?: number;
  }>;
};

type SlackIngressDeps = {
  store: TalkStore;
  gatewayOrigin: string;
  authToken: string | undefined;
  logger: Logger;
  /**
   * Optional direct Slack sender. When provided, replies bypass OpenClaw outbound hooks.
   */
  sendSlackMessage?: (params: {
    accountId?: string;
    channelId: string;
    threadTs?: string;
    message: string;
  }) => Promise<boolean>;
  /**
   * Set false in tests to enqueue ownership decisions without running the async queue.
   */
  autoProcessQueue?: boolean;
};

type OutboundSuppressionLease = {
  eventId: string;
  talkId: string;
  target: string;
  accountId?: string;
  createdAt: number;
  expiresAt: number;
  remainingCancels: number;
};

type SlackOwnershipDecision = {
  decision: 'handled' | 'pass';
  eventId: string;
  talkId?: string;
  reason?: string;
  queued?: boolean;
  duplicate?: boolean;
};

export type SlackOwnershipInspection = {
  decision: 'handled' | 'pass';
  talkId?: string;
  reason?: string;
  bindingId?: string;
  behaviorAgentName?: string;
  behaviorOnMessagePrompt?: string;
};

export type MessageReceivedHookEvent = {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};

export type MessageHookContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

export type MessageSendingHookEvent = {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type MessageReceivedHookResult = { cancel: true } | undefined;

const seenEvents = new Map<string, SeenDecision>();
const outboundSuppressions = new Map<string, OutboundSuppressionLease>();
const queue: QueueItem[] = [];
const runtimeByEventId = new Map<string, SlackIngressEventRuntime>();
const runtimeCountersByTalkId = new Map<string, SlackIngressTalkCounters>();
let queueProcessing = false;

function parseIntegerEnv(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function estimateHistoryMessageBytes(msg: TalkMessage): number {
  let size = Buffer.byteLength(msg.content || '', 'utf-8');
  if (msg.agentName) size += Buffer.byteLength(msg.agentName, 'utf-8');
  if (msg.tool_name) size += Buffer.byteLength(msg.tool_name, 'utf-8');
  if (msg.tool_call_id) size += Buffer.byteLength(msg.tool_call_id, 'utf-8');
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    size += Buffer.byteLength(JSON.stringify(msg.tool_calls), 'utf-8');
  }
  return size + 64;
}

function selectHistoryWithinBudget(
  history: TalkMessage[],
  budgetBytes: number,
  minMessages = MIN_HISTORY_MESSAGES,
): TalkMessage[] {
  if (history.length <= minMessages) return history;
  const selected: TalkMessage[] = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    const msgBytes = estimateHistoryMessageBytes(msg);
    const mustKeep = selected.length < minMessages;
    if (!mustKeep && used + msgBytes > budgetBytes) break;
    selected.unshift(msg);
    used += msgBytes;
  }

  return selected;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function normalizeTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const slackScoped = trimmed.match(/^(?:slack:)?(channel|user):(.+)$/i);
  if (slackScoped?.[1] && slackScoped?.[2]) {
    const kind = slackScoped[1].toLowerCase();
    const rawId = slackScoped[2].trim();
    if (!rawId) return undefined;
    return `${kind}:${rawId.toLowerCase()}`;
  }

  const directId = trimmed.match(/^(?:slack:)?([a-z0-9]+)$/i);
  if (directId?.[1]) {
    const id = directId[1];
    if (/^u/i.test(id)) {
      return `user:${id.toLowerCase()}`;
    }
    return `channel:${id.toLowerCase()}`;
  }

  return trimmed.toLowerCase();
}

function parseSlackTargetId(target: string | undefined): string | undefined {
  const normalized = normalizeText(target);
  if (!normalized) return undefined;
  if (normalized.includes(':')) {
    const parts = normalized.split(':');
    const maybeId = parts[parts.length - 1]?.trim();
    return maybeId || undefined;
  }
  return normalized;
}

function parseSlackFromId(from: string | undefined): string | undefined {
  const normalized = normalizeText(from);
  if (!normalized) return undefined;
  const parts = normalized.split(':');
  if (parts.length >= 3) {
    return parts.slice(2).join(':') || undefined;
  }
  if (parts.length === 2) {
    return parts[1] || undefined;
  }
  return undefined;
}

function buildDefaultOutboundTarget(channelId: string): string {
  return `channel:${channelId}`;
}

function buildSuppressionKey(accountId: string | undefined, target: string): string {
  return `slack:${(accountId ?? SLACK_DEFAULT_ACCOUNT).trim().toLowerCase()}:${target.toLowerCase()}`;
}

function getSuppressionTtlMs(): number {
  return parseIntegerEnv('CLAWTALK_INGRESS_SUPPRESS_TTL_MS', DEFAULT_SUPPRESS_TTL_MS, 5_000, 3_600_000);
}

function getSuppressionMaxCancels(): number {
  return parseIntegerEnv(
    'CLAWTALK_INGRESS_SUPPRESS_MAX_CANCELS',
    DEFAULT_SUPPRESS_MAX_CANCELS,
    1,
    20,
  );
}

function getProcessTimeoutMs(): number {
  return parseIntegerEnv(
    'CLAWTALK_INGRESS_PROCESS_TIMEOUT_MS',
    DEFAULT_PROCESS_TIMEOUT_MS,
    10_000,
    600_000,
  );
}

function getTalkCounters(talkId: string): SlackIngressTalkCounters {
  const existing = runtimeCountersByTalkId.get(talkId);
  if (existing) return existing;
  const initial: SlackIngressTalkCounters = {
    handled: 0,
    passed: 0,
    queueOverflow: 0,
    delivered: 0,
    failed: 0,
    retries: 0,
  };
  runtimeCountersByTalkId.set(talkId, initial);
  return initial;
}

function createAttemptToken(): string {
  return randomUUID();
}

function trackEventQueued(item: QueueItem): void {
  const now = Date.now();
  runtimeByEventId.set(item.event.eventId, {
    eventId: item.event.eventId,
    talkId: item.talkId,
    accountId: item.event.accountId,
    channelId: item.event.channelId,
    platformBindingId: item.platformBindingId,
    state: 'queued',
    queuedAt: now,
    attempt: item.attempt,
    attemptToken: item.attemptToken,
    retries: 0,
    replySent: false,
    persisted: false,
  });
}

function trackEventRunning(item: QueueItem): void {
  const runtime = runtimeByEventId.get(item.event.eventId);
  if (!runtime) return;
  runtime.state = 'running';
  runtime.startedAt = Date.now();
  runtime.attempt = item.attempt;
  runtime.attemptToken = item.attemptToken;
}

function trackEventDelivered(item: QueueItem): void {
  const runtime = runtimeByEventId.get(item.event.eventId);
  if (!runtime) return;
  runtime.state = 'done';
  runtime.finishedAt = Date.now();
  runtime.replySent = true;
  runtime.persisted = true;
}

function trackEventRetry(item: QueueItem, err: unknown): void {
  const runtime = runtimeByEventId.get(item.event.eventId);
  if (!runtime) return;
  runtime.state = 'retrying';
  runtime.attempt = item.attempt + 1;
  runtime.retries += 1;
  runtime.lastError = err instanceof Error ? err.message : String(err);
  runtime.lastErrorAt = Date.now();
}

function trackEventFailed(item: QueueItem, err: unknown): void {
  const runtime = runtimeByEventId.get(item.event.eventId);
  if (!runtime) return;
  runtime.state = 'failed';
  runtime.finishedAt = Date.now();
  runtime.lastError = err instanceof Error ? err.message : String(err);
  runtime.lastErrorAt = Date.now();
}

function isAttemptCurrent(item: QueueItem): boolean {
  const runtime = runtimeByEventId.get(item.event.eventId);
  if (!runtime) return true;
  return runtime.attemptToken === item.attemptToken;
}

async function runWithTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer?.unref?.();
  });
  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pruneSeenEvents(now = Date.now()): void {
  for (const [key, value] of seenEvents) {
    if (now - value.ts > EVENT_TTL_MS) {
      seenEvents.delete(key);
    }
  }
}

function pruneOutboundSuppressions(now = Date.now()): void {
  for (const [key, lease] of outboundSuppressions) {
    if (lease.expiresAt <= now || lease.remainingCancels <= 0) {
      outboundSuppressions.delete(key);
    }
  }
}

function upsertOutboundSuppression(event: SlackIngressEvent, talkId: string): void {
  const normalizedTarget = normalizeTarget(event.outboundTarget ?? buildDefaultOutboundTarget(event.channelId));
  if (!normalizedTarget) return;

  const now = Date.now();
  const key = buildSuppressionKey(event.accountId, normalizedTarget);
  outboundSuppressions.set(key, {
    eventId: event.eventId,
    talkId,
    target: normalizedTarget,
    accountId: event.accountId,
    createdAt: now,
    expiresAt: now + getSuppressionTtlMs(),
    remainingCancels: getSuppressionMaxCancels(),
  });
}

function buildEventId(input: {
  channelId: string;
  accountId?: string;
  messageTs?: string;
  threadTs?: string;
  userId?: string;
}): string {
  const base = [
    'slack',
    input.accountId ?? 'default',
    input.channelId,
    input.messageTs ?? input.threadTs ?? 'unknown',
    input.userId ?? 'unknown',
  ];
  return base.join(':');
}

function parseSlackIngressEvent(raw: unknown): SlackIngressEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const channelId = normalizeText(body.channelId);
  const text = normalizeText(body.text);
  if (!channelId || !text) {
    return null;
  }

  const accountId = normalizeText(body.accountId);
  const messageTs = normalizeText(body.messageTs);
  const threadTs = normalizeText(body.threadTs);
  const userId = normalizeText(body.userId);
  const outboundTarget =
    normalizeText(body.outboundTarget) ??
    (channelId ? buildDefaultOutboundTarget(channelId) : undefined);
  const eventId =
    normalizeText(body.eventId) ??
    buildEventId({
      channelId,
      accountId,
      messageTs,
      threadTs,
      userId,
    });

  return {
    eventId,
    accountId,
    channelId,
    channelName: normalizeText(body.channelName),
    threadTs,
    messageTs,
    userId,
    userName: normalizeText(body.userName),
    outboundTarget,
    text,
  };
}

function normalizeScope(scope: string): string {
  return scope.trim().toLowerCase();
}

function normalizeAccountId(value: string | undefined): string {
  return (value ?? SLACK_DEFAULT_ACCOUNT).trim().toLowerCase();
}

function normalizeChannelName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/^#/, '').toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function canWrite(permission: string | undefined): boolean {
  const normalized = (permission ?? 'read+write').trim().toLowerCase();
  return normalized === 'write' || normalized === 'read+write';
}

function scoreSlackBinding(binding: PlatformBinding, event: SlackIngressEvent): number {
  if (binding.platform.trim().toLowerCase() !== 'slack') {
    return -1;
  }
  if (!canWrite(binding.permission)) {
    return -1;
  }
  const bindingAccountId = binding.accountId?.trim()
    ? normalizeAccountId(binding.accountId)
    : undefined;
  const explicitEventAccountId = event.accountId?.trim()
    ? normalizeAccountId(event.accountId)
    : undefined;
  if (bindingAccountId && explicitEventAccountId && bindingAccountId !== explicitEventAccountId) {
    return -1;
  }

  const scope = normalizeScope(binding.scope);
  if (!scope) return -1;

  const channelId = event.channelId.trim().toLowerCase();
  const channelName = normalizeChannelName(event.channelName);
  const outboundTarget = normalizeTarget(event.outboundTarget);

  if (scope === '*' || scope === 'all' || scope === 'slack:*') {
    return 10;
  }
  if (
    scope === channelId ||
    scope === `channel:${channelId}` ||
    scope === `user:${channelId}` ||
    scope === `slack:${channelId}`
  ) {
    return 100;
  }
  if (outboundTarget && (scope === outboundTarget || scope === `slack:${outboundTarget}`)) {
    return 95;
  }
  if (channelName) {
    if (scope === `#${channelName}` || scope === channelName) {
      return 90;
    }
    if (scope.endsWith(` #${channelName}`)) {
      return 80;
    }
  }
  return -1;
}

function resolveOwnerTalk(
  talks: TalkMeta[],
  event: SlackIngressEvent,
  logger: Logger,
): { talkId?: string; reason?: string; binding?: PlatformBinding } {
  let bestScore = -1;
  const candidates: Array<{ talk: TalkMeta; binding: PlatformBinding }> = [];

  for (const talk of talks) {
    const bindings = talk.platformBindings ?? [];
    let talkScore = -1;
    let talkBestBinding: PlatformBinding | undefined;
    for (const binding of bindings) {
      const score = scoreSlackBinding(binding, event);
      if (score > talkScore) {
        talkScore = score;
        talkBestBinding = binding;
      }
    }
    if (talkScore < 0 || !talkBestBinding) continue;
    if (talkScore > bestScore) {
      bestScore = talkScore;
      candidates.length = 0;
      candidates.push({ talk, binding: talkBestBinding });
      continue;
    }
    if (talkScore === bestScore) {
      candidates.push({ talk, binding: talkBestBinding });
    }
  }

  if (candidates.length === 0) {
    return { reason: 'no-binding' };
  }
  if (candidates.length > 1) {
    logger.warn(
      `SlackIngress: ambiguous owner for ${event.eventId}; ${candidates.length} talks matched score ${bestScore}`,
    );
    return { reason: 'ambiguous-binding' };
  }
  return {
    talkId: candidates[0].talk.id,
    binding: candidates[0].binding,
  };
}

function resolvePrimaryAgent(meta: TalkMeta): TalkAgent | undefined {
  const agents = meta.agents ?? [];
  return agents.find((agent) => agent.isPrimary) ?? agents[0];
}

function resolveAgentForEvent(meta: TalkMeta, preferredAgentName?: string): TalkAgent | undefined {
  const preferred = preferredAgentName?.trim().toLowerCase();
  if (preferred) {
    const matched = (meta.agents ?? []).find((agent) => agent.name.trim().toLowerCase() === preferred);
    if (matched) return matched;
  }
  return resolvePrimaryAgent(meta);
}

function resolveBehaviorForBinding(meta: TalkMeta, bindingId: string): {
  autoRespond?: boolean;
  agentName?: string;
  onMessagePrompt?: string;
} | undefined {
  const behavior = (meta.platformBehaviors ?? []).find((entry) => entry.platformBindingId === bindingId);
  if (!behavior) return undefined;
  return {
    autoRespond: behavior.autoRespond,
    agentName: behavior.agentName?.trim() || undefined,
    onMessagePrompt: behavior.onMessagePrompt?.trim() || undefined,
  };
}

function shouldHandleViaBehavior(meta: TalkMeta, bindingId: string): {
  handle: boolean;
  reason?: string;
  behavior?: { autoRespond?: boolean; agentName?: string; onMessagePrompt?: string };
} {
  const behavior = resolveBehaviorForBinding(meta, bindingId);
  if (!behavior) {
    // Missing behavior row means "use default talk behavior" for this binding.
    return { handle: true };
  }

  if (behavior.autoRespond === false) {
    return { handle: false, reason: 'on-message-disabled' };
  }

  return { handle: true, behavior };
}

function buildRoleInstructions(agent: TalkAgent): string {
  return `Act as the ${agent.role} for this Talk. Keep responses concise, actionable, and grounded in the Talk objectives and rules.`;
}

function sanitizeSessionPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 96);
}

function buildSlackSessionKey(params: {
  talkId: string;
  event: SlackIngressEvent;
  agentId?: string;
}): string {
  const agentId = sanitizeSessionPart(params.agentId ?? 'main') || 'main';
  const talkId = sanitizeSessionPart(params.talkId) || 'talk';
  const channelId = sanitizeSessionPart(params.event.channelId) || 'channel';
  const threadId = sanitizeSessionPart(
    params.event.threadTs ?? params.event.messageTs ?? params.event.eventId,
  ) || 'event';
  return `agent:${agentId}:clawtalk:talk:${talkId}:slack:channel:${channelId}:thread:${threadId}`;
}

function buildInboundMessage(event: SlackIngressEvent): string {
  const sender = event.userName ?? event.userId ?? 'unknown';
  const channelLabel = event.channelName ? `#${event.channelName.replace(/^#/, '')}` : `#${event.channelId}`;
  const threadSuffix = event.threadTs ? ` (thread ${event.threadTs})` : '';
  return `[Slack ${channelLabel}${threadSuffix} from ${sender}]\n${event.text}`;
}

async function callLlmForEvent(params: {
  deps: SlackIngressDeps;
  talkId: string;
  event: SlackIngressEvent;
  behaviorAgentName?: string;
  behaviorOnMessagePrompt?: string;
}): Promise<{
  reply: string;
  model: string;
  sessionKey: string;
  agentName?: string;
  agentRole?: TalkAgent['role'];
}> {
  const { deps, talkId, event } = params;
  const meta = deps.store.getTalk(talkId);
  if (!meta) {
    throw new Error(`talk ${talkId} not found`);
  }

  const selectedAgent = resolveAgentForEvent(meta, params.behaviorAgentName);
  const model = selectedAgent?.model || meta.model || 'moltbot';
  const contextMd = await deps.store.getContextMd(talkId);
  const pinnedMessages = await Promise.all(meta.pinnedMessageIds.map(id => deps.store.getMessage(talkId, id)));
  const recentHistory = await deps.store.getRecentMessages(talkId, MAX_CONTEXT_MESSAGES);

  const baseSystemPrompt = composeSystemPrompt({
    meta,
    contextMd,
    pinnedMessages: pinnedMessages.filter(Boolean) as TalkMessage[],
    agentOverride: selectedAgent
      ? {
          name: selectedAgent.name,
          role: selectedAgent.role,
          roleInstructions: buildRoleInstructions(selectedAgent),
          otherAgents: (meta.agents ?? [])
            .filter(a => a.name !== selectedAgent.name)
            .map(a => ({ name: a.name, role: a.role, model: a.model })),
        }
      : undefined,
  });

  const behaviorPrompt = params.behaviorOnMessagePrompt?.trim();
  const systemPrompt = behaviorPrompt
    ? `${baseSystemPrompt}\n\n` +
      `Platform inbound behavior (Slack binding specific):\n${behaviorPrompt}`
    : baseSystemPrompt;
  const systemPromptBytes = Buffer.byteLength(systemPrompt ?? '', 'utf-8');
  const historyBudgetBytes = Math.max(
    MIN_HISTORY_BUDGET_BYTES,
    MAX_CONTEXT_BUDGET_BYTES - systemPromptBytes - RESERVED_OVERHEAD_BYTES,
  );
  const history = selectHistoryWithinBudget(recentHistory, historyBudgetBytes);

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  for (const msg of history) {
    let content = msg.content;
    if (msg.agentName && msg.role === 'assistant') {
      content = `[${msg.agentName}]: ${content}`;
    }
    messages.push({ role: msg.role, content });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (deps.authToken) {
    headers.Authorization = `Bearer ${deps.authToken}`;
  }
  const sessionKey = buildSlackSessionKey({
    talkId,
    event,
    agentId: selectedAgent?.openClawAgentId ?? 'main',
  });
  headers['x-openclaw-session-key'] = sessionKey;
  if (selectedAgent?.openClawAgentId?.trim()) {
    headers['x-openclaw-agent-id'] = selectedAgent.openClawAgentId.trim();
  }

  const llmResponse = await fetch(`${deps.gatewayOrigin}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!llmResponse.ok) {
    const errBody = await llmResponse.text().catch(() => '');
    throw new Error(`llm call failed (${llmResponse.status}): ${errBody.slice(0, 200)}`);
  }

  const json = await llmResponse.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const reply = json.choices?.[0]?.message?.content?.trim() ?? '';
  if (!reply) {
    throw new Error('llm returned empty response');
  }

  return {
    reply,
    model,
    sessionKey,
    agentName: selectedAgent?.name,
    agentRole: selectedAgent?.role,
  };
}

async function ensureInboundMessage(item: QueueItem, deps: SlackIngressDeps): Promise<void> {
  if (item.inboundPersisted) return;
  const inboundContent = item.inboundContent ?? buildInboundMessage(item.event);
  item.inboundContent = inboundContent;
  const userMsg: TalkMessage = {
    id: randomUUID(),
    role: 'user',
    content: inboundContent,
    timestamp: Date.now(),
  };
  await deps.store.appendMessage(item.talkId, userMsg);
  item.inboundPersisted = true;
}

async function persistAssistantResult(item: QueueItem, deps: SlackIngressDeps): Promise<void> {
  if (item.assistantPersisted) return;
  if (!item.reply || !item.model) {
    throw new Error('assistant result missing');
  }

  const assistantMsg: TalkMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: item.reply,
    timestamp: Date.now(),
    model: item.model,
    ...(item.agentName ? { agentName: item.agentName } : {}),
    ...(item.agentRole ? { agentRole: item.agentRole } : {}),
  };
  await deps.store.appendMessage(item.talkId, assistantMsg);
  item.assistantPersisted = true;

  scheduleContextUpdate({
    talkId: item.talkId,
    userMessage: item.inboundContent ?? buildInboundMessage(item.event),
    assistantResponse: item.reply,
    model: item.model,
    gatewayOrigin: deps.gatewayOrigin,
    authToken: deps.authToken,
    store: deps.store,
    logger: deps.logger,
  });
}

async function sendSlackReply(params: {
  deps: SlackIngressDeps;
  event: SlackIngressEvent;
  accountId?: string;
  message: string;
  sessionKey: string;
}): Promise<void> {
  const resolvedAccountId = params.accountId ?? params.event.accountId;
  if (params.deps.sendSlackMessage) {
    const sent = await params.deps.sendSlackMessage({
      accountId: resolvedAccountId,
      channelId: params.event.channelId,
      threadTs: params.event.threadTs,
      message: params.message,
    });
    if (!sent) {
      throw new Error('slack send callback returned false');
    }
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-openclaw-message-channel': 'slack',
  };
  if (resolvedAccountId) {
    headers['x-openclaw-account-id'] = resolvedAccountId;
  }
  if (params.deps.authToken) {
    headers.Authorization = `Bearer ${params.deps.authToken}`;
  }

  const response = await fetch(`${params.deps.gatewayOrigin}/tools/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tool: 'message',
      sessionKey: params.sessionKey,
      args: {
        action: 'send',
        channel: 'slack',
        target: `channel:${params.event.channelId}`,
        message: params.message,
        ...(params.event.threadTs ? { replyTo: params.event.threadTs } : {}),
        ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
        bestEffort: true,
      },
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`slack send failed (${response.status}): ${errBody.slice(0, 200)}`);
  }

  const payload = await response.json().catch(() => null) as
    | { ok?: boolean; error?: { message?: string } }
    | null;
  if (!payload || payload.ok !== true) {
    throw new Error(payload?.error?.message ?? 'slack send returned non-ok result');
  }
}

async function writeDeadLetter(params: {
  deps: SlackIngressDeps;
  item: QueueItem;
  error: unknown;
}): Promise<void> {
  const record = {
    id: randomUUID(),
    failedAt: Date.now(),
    error: params.error instanceof Error ? params.error.message : String(params.error),
    item: {
      talkId: params.item.talkId,
      event: params.item.event,
      attempt: params.item.attempt,
      enqueuedAt: params.item.enqueuedAt,
    },
  };
  const file = path.join(params.deps.store.getDataDir(), 'ingress-dead-letter.jsonl');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf-8');
}

async function sendFailureNotice(params: {
  deps: SlackIngressDeps;
  item: QueueItem;
}): Promise<void> {
  const message =
    'ClawTalk failed to process this Slack event after multiple retries. Please retry in this thread.';
  const fallbackSessionKey = buildSlackSessionKey({
    talkId: params.item.talkId,
    event: params.item.event,
    agentId: 'main',
  });
  await sendSlackReply({
    deps: params.deps,
    event: params.item.event,
    accountId: params.item.replyAccountId,
    message,
    sessionKey: fallbackSessionKey,
  });
}

async function processQueueItem(item: QueueItem, deps: SlackIngressDeps): Promise<void> {
  if (!isAttemptCurrent(item)) {
    throw new Error('stale attempt superseded by newer retry');
  }
  await ensureInboundMessage(item, deps);

  if (!item.reply || !item.sessionKey || !item.model) {
    const generated = await callLlmForEvent({
      deps,
      talkId: item.talkId,
      event: item.event,
      behaviorAgentName: item.behaviorAgentName,
      behaviorOnMessagePrompt: item.behaviorOnMessagePrompt,
    });
    item.reply = generated.reply;
    item.model = generated.model;
    item.sessionKey = generated.sessionKey;
    item.agentName = generated.agentName;
    item.agentRole = generated.agentRole;
  }

  if (!isAttemptCurrent(item)) {
    throw new Error('stale attempt superseded by newer retry');
  }
  if (!item.replySent) {
    const reply = item.reply;
    const sessionKey = item.sessionKey;
    if (!reply || !sessionKey) {
      throw new Error('reply payload missing');
    }
    await sendSlackReply({
      deps,
      event: item.event,
      accountId: item.replyAccountId,
      message: reply,
      sessionKey,
    });
    item.replySent = true;
  }

  if (!isAttemptCurrent(item)) {
    throw new Error('stale attempt superseded by newer retry');
  }
  await persistAssistantResult(item, deps);
}

function scheduleRetry(item: QueueItem, deps: SlackIngressDeps, err: unknown): void {
  const maxAttempts = parseIntegerEnv('CLAWTALK_INGRESS_RETRY_ATTEMPTS', DEFAULT_RETRY_ATTEMPTS, 1, 10);
  const nextAttempt = item.attempt + 1;
  if (nextAttempt >= maxAttempts) {
    if (!item.replySent) {
      seenEvents.delete(item.event.eventId);
    }
    void writeDeadLetter({ deps, item, error: err }).catch(() => {});
    const notifyOnFailure = process.env.CLAWTALK_INGRESS_NOTIFY_FAILURE !== '0' && !item.replySent;
    if (notifyOnFailure) {
      void sendFailureNotice({ deps, item }).catch(() => {});
    }
    return;
  }

  const baseDelay = parseIntegerEnv('CLAWTALK_INGRESS_RETRY_BASE_MS', DEFAULT_RETRY_BASE_MS, 100, 60_000);
  const delayMs = Math.min(60_000, baseDelay * (2 ** item.attempt));
  const retryItem: QueueItem = { ...item, attempt: nextAttempt, attemptToken: createAttemptToken() };
  const runtime = runtimeByEventId.get(item.event.eventId);
  if (runtime) {
    runtime.attemptToken = retryItem.attemptToken;
  }
  const timer = setTimeout(() => {
    queue.push(retryItem);
    void processQueue(deps);
  }, delayMs);
  timer.unref?.();
}

async function processQueue(deps: SlackIngressDeps): Promise<void> {
  if (queueProcessing) return;
  queueProcessing = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      try {
        trackEventRunning(item);
        await runWithTimeout(
          processQueueItem(item, deps),
          getProcessTimeoutMs(),
          `SlackIngress event ${item.event.eventId}`,
        );
        trackEventDelivered(item);
        getTalkCounters(item.talkId).delivered += 1;
        deps.logger.debug(`SlackIngress: delivered reply for event ${item.event.eventId} (talk ${item.talkId})`);
      } catch (err) {
        const maxAttempts = parseIntegerEnv('CLAWTALK_INGRESS_RETRY_ATTEMPTS', DEFAULT_RETRY_ATTEMPTS, 1, 10);
        const nextAttempt = item.attempt + 1;
        if (nextAttempt >= maxAttempts) {
          trackEventFailed(item, err);
          getTalkCounters(item.talkId).failed += 1;
        } else {
          trackEventRetry(item, err);
          getTalkCounters(item.talkId).retries += 1;
        }
        deps.logger.warn(
          `SlackIngress: processing failed for ${item.event.eventId} (attempt ${item.attempt + 1}): ${String(err)}`,
        );
        scheduleRetry(item, deps, err);
      }
    }
  } finally {
    queueProcessing = false;
  }
}

function routeSlackIngressEvent(
  event: SlackIngressEvent,
  deps: SlackIngressDeps,
): { statusCode: number; payload: SlackOwnershipDecision } {
  pruneSeenEvents();
  pruneOutboundSuppressions();

  const seen = seenEvents.get(event.eventId);
  if (seen) {
    if (seen.decision === 'handled' && seen.talkId) {
      upsertOutboundSuppression(event, seen.talkId);
    }
    return {
      statusCode: 200,
      payload: {
        decision: seen.decision,
        talkId: seen.talkId,
        reason: seen.reason,
        eventId: event.eventId,
        duplicate: true,
      },
    };
  }

  const ownership = inspectSlackOwnership(event, deps.store, deps.logger);
  if (ownership.decision === 'pass' || !ownership.talkId || !ownership.bindingId) {
    const reason = ownership.reason ?? 'no-binding';
    if (reason !== 'no-binding') {
      deps.logger.debug(
        `SlackIngress: pass event=${event.eventId} account=${event.accountId ?? 'unknown'} ` +
        `channel=${event.channelId} reason=${reason}`,
      );
    }
    if (ownership.talkId) {
      getTalkCounters(ownership.talkId).passed += 1;
    }
    seenEvents.set(event.eventId, {
      ts: Date.now(),
      decision: 'pass',
      reason,
    });
    return {
      statusCode: 200,
      payload: {
        decision: 'pass',
        reason,
        eventId: event.eventId,
      },
    };
  }

  const maxQueue = parseIntegerEnv('CLAWTALK_INGRESS_MAX_QUEUE', DEFAULT_MAX_QUEUE, 10, 100_000);
  if (queue.length >= maxQueue) {
    const reason = 'queue-overflow';
    deps.logger.warn(
      `SlackIngress: dropping event due to queue overflow event=${event.eventId} ` +
      `account=${event.accountId ?? 'unknown'} channel=${event.channelId} maxQueue=${maxQueue}`,
    );
    getTalkCounters(ownership.talkId).queueOverflow += 1;
    seenEvents.set(event.eventId, {
      ts: Date.now(),
      decision: 'pass',
      reason,
    });
    return {
      statusCode: 200,
      payload: {
        decision: 'pass',
        reason,
        eventId: event.eventId,
      },
    };
  }

  seenEvents.set(event.eventId, {
    ts: Date.now(),
    decision: 'handled',
    talkId: ownership.talkId,
  });
  getTalkCounters(ownership.talkId).handled += 1;
  deps.logger.debug(
    `SlackIngress: handled event=${event.eventId} account=${event.accountId ?? 'unknown'} ` +
    `channel=${event.channelId} talk=${ownership.talkId} binding=${ownership.bindingId}`,
  );
  upsertOutboundSuppression(event, ownership.talkId);
  const ownerTalk = deps.store.getTalk(ownership.talkId);
  const ownerBinding = ownerTalk?.platformBindings?.find((binding) => binding.id === ownership.bindingId);
  const queuedItem: QueueItem = {
    talkId: ownership.talkId,
    event,
    platformBindingId: ownership.bindingId,
    attemptToken: createAttemptToken(),
    replyAccountId: event.accountId ?? ownerBinding?.accountId,
    behaviorAgentName: ownership.behaviorAgentName,
    behaviorOnMessagePrompt: ownership.behaviorOnMessagePrompt,
    attempt: 0,
    enqueuedAt: Date.now(),
    inboundContent: buildInboundMessage(event),
  };
  queue.push(queuedItem);
  trackEventQueued(queuedItem);
  if (deps.autoProcessQueue !== false) {
    void processQueue(deps);
  }

  return {
    statusCode: 202,
    payload: {
      decision: 'handled',
      talkId: ownership.talkId,
      eventId: event.eventId,
      queued: true,
    },
  };
}

export function inspectSlackOwnership(
  event: Pick<SlackIngressEvent, 'accountId' | 'channelId' | 'channelName' | 'outboundTarget' | 'eventId'>,
  store: TalkStore,
  logger: Logger,
): SlackOwnershipInspection {
  const owner = resolveOwnerTalk(store.listTalks(), {
    ...event,
    text: '',
  }, logger);
  if (!owner.talkId || !owner.binding) {
    return {
      decision: 'pass',
      reason: owner.reason ?? 'no-binding',
    };
  }

  const ownerTalk = store.getTalk(owner.talkId);
  if (!ownerTalk) {
    return {
      decision: 'pass',
      reason: 'talk-not-found',
      talkId: owner.talkId,
      bindingId: owner.binding.id,
    };
  }

  const behaviorDecision = shouldHandleViaBehavior(ownerTalk, owner.binding.id);
  if (!behaviorDecision.handle) {
    return {
      decision: 'pass',
      reason: behaviorDecision.reason ?? 'no-platform-behavior',
      talkId: owner.talkId,
      bindingId: owner.binding.id,
    };
  }

  return {
    decision: 'handled',
    talkId: owner.talkId,
    bindingId: owner.binding.id,
    behaviorAgentName: behaviorDecision.behavior?.agentName,
    behaviorOnMessagePrompt: behaviorDecision.behavior?.onMessagePrompt,
  };
}

function parseSlackMessageReceivedHookEvent(
  event: MessageReceivedHookEvent,
  ctx: MessageHookContext,
): SlackIngressEvent | null {
  if (ctx.channelId.trim().toLowerCase() !== 'slack') {
    return null;
  }

  const text = normalizeText(event.content);
  if (!text) {
    return null;
  }

  const metadata = asRecord(event.metadata);
  const outboundTarget = normalizeText(metadata?.to) ?? normalizeText(ctx.conversationId);
  const channelId = parseSlackTargetId(outboundTarget) ?? parseSlackFromId(event.from);
  if (!channelId) {
    return null;
  }

  const accountId = normalizeText(ctx.accountId) ?? normalizeText(metadata?.accountId);
  const threadTs = normalizeText(metadata?.threadId);
  const messageTs =
    normalizeText(metadata?.messageId) ??
    (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? String(Math.floor(event.timestamp))
      : undefined);
  const userId = normalizeText(metadata?.senderId);
  const userName = normalizeText(metadata?.senderName) ?? normalizeText(metadata?.senderUsername);

  return {
    eventId: buildEventId({
      channelId,
      accountId,
      messageTs,
      threadTs,
      userId,
    }),
    accountId,
    channelId,
    threadTs,
    messageTs,
    userId,
    userName,
    outboundTarget: outboundTarget ?? buildDefaultOutboundTarget(channelId),
    text,
  };
}

function consumeOutboundSuppression(
  event: MessageSendingHookEvent,
  ctx: MessageHookContext,
): OutboundSuppressionLease | undefined {
  if (ctx.channelId.trim().toLowerCase() !== 'slack') {
    return undefined;
  }

  pruneOutboundSuppressions();
  const target = normalizeTarget(event.to);
  if (!target) {
    return undefined;
  }

  const metadata = asRecord(event.metadata);
  const accountId = normalizeText(metadata?.accountId) ?? normalizeText(ctx.accountId);
  const candidateKeys = accountId
    ? [buildSuppressionKey(accountId, target), buildSuppressionKey(undefined, target)]
    : [buildSuppressionKey(undefined, target)];
  const matchedKey = candidateKeys.find((key) => outboundSuppressions.has(key));
  if (!matchedKey) {
    return undefined;
  }
  const lease = outboundSuppressions.get(matchedKey);
  if (!lease) {
    return undefined;
  }

  lease.remainingCancels -= 1;
  if (lease.remainingCancels <= 0) {
    outboundSuppressions.delete(matchedKey);
  }
  return lease;
}

export async function handleSlackMessageReceivedHook(
  event: MessageReceivedHookEvent,
  ctx: MessageHookContext,
  deps: SlackIngressDeps,
): Promise<MessageReceivedHookResult> {
  const parsed = parseSlackMessageReceivedHookEvent(event, ctx);
  if (!parsed) return undefined;
  const decision = routeSlackIngressEvent(parsed, deps);
  return decision.payload.decision === 'handled' ? { cancel: true } : undefined;
}

export function handleSlackMessageSendingHook(
  event: MessageSendingHookEvent,
  ctx: MessageHookContext,
  logger?: Logger,
): { cancel: true } | undefined {
  const lease = consumeOutboundSuppression(event, ctx);
  if (!lease) {
    return undefined;
  }
  logger?.debug(
    `SlackIngress: suppressed OpenClaw outbound for ${lease.target} (talk ${lease.talkId}, event ${lease.eventId})`,
  );
  return { cancel: true };
}

export async function handleSlackIngress(
  ctx: HandlerContext,
  deps: SlackIngressDeps,
): Promise<void> {
  if (ctx.req.method !== 'POST') {
    sendJson(ctx.res, 405, { error: 'Method not allowed' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(ctx.req);
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const event = parseSlackIngressEvent(body);
  if (!event) {
    sendJson(ctx.res, 400, {
      error: 'Missing required fields: channelId and text',
    });
    return;
  }

  const decision = routeSlackIngressEvent(event, deps);
  sendJson(ctx.res, decision.statusCode, decision.payload);
}

export function __resetSlackIngressStateForTests(): void {
  seenEvents.clear();
  outboundSuppressions.clear();
  runtimeByEventId.clear();
  runtimeCountersByTalkId.clear();
  queue.length = 0;
  queueProcessing = false;
}

export function getSlackIngressTalkRuntimeSnapshot(talkId: string): SlackIngressTalkRuntimeSnapshot {
  const counters = getTalkCounters(talkId);
  const events = Array.from(runtimeByEventId.values())
    .filter((event) => event.talkId === talkId)
    .sort((a, b) => b.queuedAt - a.queuedAt)
    .slice(0, 10)
    .map((event) => ({
      eventId: event.eventId,
      accountId: event.accountId,
      channelId: event.channelId,
      state: event.state,
      attempt: event.attempt,
      retries: event.retries,
      queuedAt: event.queuedAt,
      startedAt: event.startedAt,
      finishedAt: event.finishedAt,
      replySent: event.replySent,
      persisted: event.persisted,
      lastError: event.lastError,
      lastErrorAt: event.lastErrorAt,
    }));
  const inflight = events.filter((event) => event.state === 'queued' || event.state === 'running' || event.state === 'retrying').length;
  return {
    talkId,
    inflight,
    counters: { ...counters },
    recentEvents: events,
  };
}
