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
const LLM_TIMEOUT_MS = 120_000;
const SEND_TIMEOUT_MS = 30_000;
const EVENT_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_MAX_QUEUE = 1_000;

type SlackIngressEvent = {
  eventId: string;
  accountId?: string;
  channelId: string;
  channelName?: string;
  threadTs?: string;
  messageTs?: string;
  userId?: string;
  userName?: string;
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

type SlackIngressDeps = {
  store: TalkStore;
  gatewayOrigin: string;
  authToken: string | undefined;
  logger: Logger;
};

const seenEvents = new Map<string, SeenDecision>();
const queue: QueueItem[] = [];
let queueProcessing = false;

function parseIntegerEnv(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pruneSeenEvents(now = Date.now()): void {
  for (const [key, value] of seenEvents) {
    if (now - value.ts > EVENT_TTL_MS) {
      seenEvents.delete(key);
    }
  }
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
    text,
  };
}

function normalizeScope(scope: string): string {
  return scope.trim().toLowerCase();
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

  const scope = normalizeScope(binding.scope);
  if (!scope) return -1;

  const channelId = event.channelId.trim().toLowerCase();
  const channelName = normalizeChannelName(event.channelName);

  if (scope === '*' || scope === 'all' || scope === 'slack:*') {
    return 10;
  }
  if (scope === channelId || scope === `channel:${channelId}` || scope === `slack:${channelId}`) {
    return 100;
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
): { talkId?: string; reason?: string } {
  let bestScore = -1;
  const candidates: TalkMeta[] = [];

  for (const talk of talks) {
    const bindings = talk.platformBindings ?? [];
    let talkScore = -1;
    for (const binding of bindings) {
      const score = scoreSlackBinding(binding, event);
      if (score > talkScore) {
        talkScore = score;
      }
    }
    if (talkScore < 0) continue;
    if (talkScore > bestScore) {
      bestScore = talkScore;
      candidates.length = 0;
      candidates.push(talk);
      continue;
    }
    if (talkScore === bestScore) {
      candidates.push(talk);
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
  return { talkId: candidates[0].id };
}

function resolvePrimaryAgent(meta: TalkMeta): TalkAgent | undefined {
  const agents = meta.agents ?? [];
  return agents.find((agent) => agent.isPrimary) ?? agents[0];
}

function buildRoleInstructions(agent: TalkAgent): string {
  return `Act as the ${agent.role} for this Talk. Keep responses concise, actionable, and grounded in the Talk objective and directives.`;
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

  const selectedAgent = resolvePrimaryAgent(meta);
  const model = selectedAgent?.model || meta.model || 'moltbot';
  const contextMd = await deps.store.getContextMd(talkId);
  const pinnedMessages = await Promise.all(meta.pinnedMessageIds.map(id => deps.store.getMessage(talkId, id)));
  const history = await deps.store.getRecentMessages(talkId, MAX_CONTEXT_MESSAGES);

  const systemPrompt = composeSystemPrompt({
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
  message: string;
  sessionKey: string;
}): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-openclaw-message-channel': 'slack',
  };
  if (params.event.accountId) {
    headers['x-openclaw-account-id'] = params.event.accountId;
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
        ...(params.event.accountId ? { accountId: params.event.accountId } : {}),
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
    message,
    sessionKey: fallbackSessionKey,
  });
}

async function processQueueItem(item: QueueItem, deps: SlackIngressDeps): Promise<void> {
  await ensureInboundMessage(item, deps);

  if (!item.reply || !item.sessionKey || !item.model) {
    const generated = await callLlmForEvent({
      deps,
      talkId: item.talkId,
      event: item.event,
    });
    item.reply = generated.reply;
    item.model = generated.model;
    item.sessionKey = generated.sessionKey;
    item.agentName = generated.agentName;
    item.agentRole = generated.agentRole;
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
      message: reply,
      sessionKey,
    });
    item.replySent = true;
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
  const retryItem: QueueItem = { ...item, attempt: nextAttempt };
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
        await processQueueItem(item, deps);
        deps.logger.info(`SlackIngress: delivered reply for event ${item.event.eventId} (talk ${item.talkId})`);
      } catch (err) {
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

  pruneSeenEvents();
  const seen = seenEvents.get(event.eventId);
  if (seen) {
    sendJson(ctx.res, 200, {
      decision: seen.decision,
      talkId: seen.talkId,
      reason: seen.reason,
      eventId: event.eventId,
      duplicate: true,
    });
    return;
  }

  const owner = resolveOwnerTalk(deps.store.listTalks(), event, deps.logger);
  if (!owner.talkId) {
    const reason = owner.reason ?? 'no-binding';
    seenEvents.set(event.eventId, {
      ts: Date.now(),
      decision: 'pass',
      reason,
    });
    sendJson(ctx.res, 200, {
      decision: 'pass',
      reason,
      eventId: event.eventId,
    });
    return;
  }

  const maxQueue = parseIntegerEnv('CLAWTALK_INGRESS_MAX_QUEUE', DEFAULT_MAX_QUEUE, 10, 100_000);
  if (queue.length >= maxQueue) {
    const reason = 'queue-overflow';
    seenEvents.set(event.eventId, {
      ts: Date.now(),
      decision: 'pass',
      reason,
    });
    sendJson(ctx.res, 200, {
      decision: 'pass',
      reason,
      eventId: event.eventId,
    });
    return;
  }

  seenEvents.set(event.eventId, {
    ts: Date.now(),
    decision: 'handled',
    talkId: owner.talkId,
  });
  queue.push({
    talkId: owner.talkId,
    event,
    attempt: 0,
    enqueuedAt: Date.now(),
    inboundContent: buildInboundMessage(event),
  });
  void processQueue(deps);

  sendJson(ctx.res, 202, {
    decision: 'handled',
    talkId: owner.talkId,
    eventId: event.eventId,
    queued: true,
  });
}
