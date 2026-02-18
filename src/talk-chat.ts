/**
 * Talk Chat Handler
 *
 * POST /api/talks/:id/chat — the main endpoint.
 * Composes the system prompt, builds the message array, runs the
 * tool loop with SSE streaming, persists history, and triggers
 * async context.md updates.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TalkStore } from './talk-store.js';
import type { TalkMessage, ImageAttachmentMeta, Logger } from './types.js';
import type { ToolInfo, ToolRegistry } from './tool-registry.js';
import type { ToolExecutor } from './tool-executor.js';
import { sendJson, readJsonBody } from './http.js';
import { composeSystemPrompt } from './system-prompt.js';
import { scheduleContextUpdate } from './context-updater.js';
import { runToolLoop } from './tool-loop.js';
import { collectRoutingDiagnostics } from './model-routing-diagnostics.js';
import { getToolCatalog } from './tool-catalog.js';
import { parseEventTrigger, validateSchedule } from './job-scheduler.js';
import { extractGoogleDocsDocumentIdFromUrl, hasGoogleDocsDocumentUrl } from './google-docs-url.js';
import {
  evaluateToolAvailability,
  isBrowserIntent,
  isBrowserTool,
  resolveExecutionMode,
} from './talk-policy.js';
import { isTransientError } from './tool-loop.js';

/** Maximum number of history messages to include in LLM context. */
const MAX_CONTEXT_MESSAGES = 50;
/** Approximate max prompt payload budget before history gets trimmed more aggressively. */
const MAX_CONTEXT_BUDGET_BYTES = 60 * 1024;
/** Keep at least a short recent tail, even when over budget. */
const MIN_HISTORY_MESSAGES = 8;
/** Reserve bytes for model/tool metadata and the current user turn. */
const RESERVED_OVERHEAD_BYTES = 8 * 1024;
/** Never shrink history budget below this floor. */
const MIN_HISTORY_BUDGET_BYTES = 4 * 1024;
const CLAWTALK_DEFAULT_AGENT_ID = 'clawtalk';
const DEFAULT_TALK_FIRST_TOKEN_TIMEOUT_MS = 90_000;
const DEFAULT_TALK_TOTAL_TIMEOUT_MS = 900_000;
const DEFAULT_TALK_INACTIVITY_TIMEOUT_MS = 300_000;

type TalkErrorCode =
  | 'FIRST_TOKEN_TIMEOUT'
  | 'MODE_BLOCKED_BROWSER'
  | 'TOOL_BLOCKED_POLICY'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_ERROR'
  | 'CLIENT_DISCONNECTED'
  | 'UNKNOWN';

type TalkErrorPayload = {
  code: TalkErrorCode;
  message: string;
  hint?: string;
  transient: boolean;
  retryable: boolean;
};

function emitStatusEvent(res: ServerResponse, payload: { code: string; message: string; level?: 'info' | 'warn' | 'error'; meta?: Record<string, unknown> }): void {
  if (res.writableEnded) return;
  res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
}

function emitErrorEvent(res: ServerResponse, payload: TalkErrorPayload): void {
  if (res.writableEnded) return;
  res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
}

function classifyTalkError(err: unknown, clientSignal?: AbortSignal): TalkErrorPayload {
  const message = err instanceof Error ? err.message : 'Unknown error';
  const normalized = message.toLowerCase();
  if (normalized.includes('client disconnected')) {
    return {
      code: 'CLIENT_DISCONNECTED',
      message,
      transient: false,
      retryable: false,
    };
  }
  if (normalized.includes('first token timeout')) {
    return {
      code: 'FIRST_TOKEN_TIMEOUT',
      message,
      hint: 'The provider did not return any token before timeout. Retry, switch model, or verify provider routing.',
      transient: true,
      retryable: true,
    };
  }
  if (normalized.includes('401') || normalized.includes('403') || normalized.includes('authentication')) {
    return {
      code: 'PROVIDER_AUTH',
      message,
      hint: 'Check provider API key/auth configuration.',
      transient: false,
      retryable: false,
    };
  }
  if (normalized.includes('llm error') || normalized.includes('fetch')) {
    return {
      code: 'PROVIDER_ERROR',
      message,
      hint: 'Provider call failed. Retry or switch model/provider.',
      transient: isTransientError(err, clientSignal),
      retryable: isTransientError(err, clientSignal),
    };
  }
  const transient = isTransientError(err, clientSignal);
  return {
    code: 'UNKNOWN',
    message,
    transient,
    retryable: transient,
  };
}

function resolveTalkFirstTokenTimeoutMs(): number {
  const raw = process.env.CLAWTALK_TALK_TTFT_TIMEOUT_MS;
  if (!raw) return DEFAULT_TALK_FIRST_TOKEN_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TALK_FIRST_TOKEN_TIMEOUT_MS;
  return Math.min(300_000, Math.max(10_000, parsed));
}

function resolveTalkTotalTimeoutMs(): number {
  const raw = process.env.CLAWTALK_TALK_TOTAL_TIMEOUT_MS ?? process.env.CLAWTALK_TALK_TOOLLOOP_TIMEOUT_MS;
  if (!raw) return DEFAULT_TALK_TOTAL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TALK_TOTAL_TIMEOUT_MS;
  return Math.min(1_800_000, Math.max(60_000, parsed));
}

function resolveTalkInactivityTimeoutMs(): number {
  const raw = process.env.CLAWTALK_TALK_INACTIVITY_TIMEOUT_MS;
  if (!raw) return DEFAULT_TALK_INACTIVITY_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TALK_INACTIVITY_TIMEOUT_MS;
  return Math.min(900_000, Math.max(30_000, parsed));
}

function isModelIdentityQuestion(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return (
    /^what model\b/.test(text)
    || /^which model\b/.test(text)
    || /^what llm\b/.test(text)
    || /^who are you\b/.test(text)
    || /\bwhat model are you\b/.test(text)
    || /\bwhich model are you\b/.test(text)
    || /\bwhat are you running\b/.test(text)
  );
}

function isLikelyActionRequest(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return (
    /\b(run|execute|install|build|test|debug|fix|patch|edit|create|delete|remove|update)\b/.test(text)
    || /\b(search|look up|research|fetch|download|upload|open|read|write)\b/.test(text)
    || /\b(file|files|code|command|terminal|shell|api|curl|http|https|json)\b/.test(text)
    || /^\/\w+/.test(text)
    || /```/.test(text)
  );
}

function hasExplicitToolApproval(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return (
    /\b(use|run|execute)\s+(the\s+)?tools?\b/.test(text)
    || /\btools?\s+(ok|okay|approved?|allowed?)\b/.test(text)
    || /^\/tools\b/.test(text)
  );
}

function isMentionRelayPrompt(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return /^\[[^\]]*mentioned you[^\]]*\]$/.test(text);
}

function isGoogleDriveIntent(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return (
    /\bgoogle drive\b/.test(text)
    || /\bgdrive\b/.test(text)
    || /\bdrive files?\b/.test(text)
    || /\brecent files?\b/.test(text)
  );
}

function extractDriveListLimit(message: string): number {
  const text = message.trim().toLowerCase();
  const explicit = text.match(/\b(\d{1,3})\s+(?:most\s+)?recent\b/);
  const generic = text.match(/\b(?:limit|top)\s+(\d{1,3})\b/);
  const value = Number.parseInt((explicit?.[1] ?? generic?.[1] ?? '10'), 10);
  if (!Number.isFinite(value)) return 10;
  return Math.min(100, Math.max(1, value));
}

function extractPdfPathFromMessage(message: string): string | undefined {
  const match = message.match(/(\/[^\s\]\)'"`]+\.pdf)\b/i);
  return match?.[1];
}

function prioritizeTurnToolInfos(tools: ToolInfo[], message: string): ToolInfo[] {
  let filtered = tools;

  if (isGoogleDriveIntent(message)) {
    const hasDriveTool = filtered.some((tool) => tool.name.trim().toLowerCase() === 'google_drive_files');
    if (hasDriveTool) {
      const blockedForDriveIntent = new Set([
        'exec',
        'shell_exec',
        'manage_tools',
        'read',
        'write',
        'edit',
      ]);
      filtered = filtered.filter((tool) => !blockedForDriveIntent.has(tool.name.trim().toLowerCase()));
    }
  }

  if (hasGoogleDocsDocumentUrl(message)) {
    const hasDocsReadTool = filtered.some((tool) => tool.name.trim().toLowerCase() === 'google_docs_read');
    if (hasDocsReadTool) {
      filtered = filtered.filter((tool) => tool.name.trim().toLowerCase() !== 'web_fetch_extract');
    }
  }

  return filtered;
}

function filterToolInfos(
  tools: ToolInfo[],
  allow: string[] | undefined,
  deny: string[] | undefined,
): ToolInfo[] {
  const allowSet = new Set((allow ?? []).map((n) => n.toLowerCase()));
  const denySet = new Set((deny ?? []).map((n) => n.toLowerCase()));
  return tools.filter((tool) => {
    const key = tool.name.toLowerCase();
    if (denySet.has(key)) return false;
    if (allowSet.size > 0 && !allowSet.has(key)) return false;
    return true;
  });
}

function sanitizeSessionPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 96);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

function resolveTalkAgentRouting(meta: { agents?: Array<{ name: string; openClawAgentId?: string }> }, requestedAgentName?: string): {
  headerAgentId?: string;
  sessionAgentPart: string;
} {
  const requested = requestedAgentName?.trim().toLowerCase();
  if (!requested) {
    return {
      // No explicit per-agent routing: rely on requested model and avoid
      // forcing a possibly-invalid OpenClaw agent id.
      sessionAgentPart: 'talk',
    };
  }
  const matched = (meta.agents ?? []).find((agent) => agent.name.trim().toLowerCase() === requested);
  const routed = matched?.openClawAgentId?.trim();
  return {
    headerAgentId: routed || undefined,
    sessionAgentPart: routed || requested,
  };
}

function buildTalkSessionKey(talkId: string, agentPart: string, lanePart?: string): string {
  const talk = sanitizeSessionPart(talkId) || 'talk';
  const agent = sanitizeSessionPart(agentPart) || CLAWTALK_DEFAULT_AGENT_ID;
  const lane = lanePart ? sanitizeSessionPart(lanePart) : '';
  return lane
    ? `agent:${agent}:clawtalk:talk:${talk}:chat:lane:${lane}`
    : `agent:${agent}:clawtalk:talk:${talk}:chat`;
}

function buildFullControlTalkSessionKey(talkId: string, lanePart?: string): string {
  const talk = sanitizeSessionPart(talkId) || 'talk';
  const lane = lanePart ? sanitizeSessionPart(lanePart) : '';
  return lane
    ? `talk:clawtalk:talk:${talk}:chat:lane:${lane}`
    : `talk:clawtalk:talk:${talk}:chat`;
}

function buildRunScopedSessionPart(basePart: string, model: string, traceId: string): string {
  const base = sanitizeSessionPart(basePart) || 'talk';
  const modelPart = sanitizeSessionPart(model).slice(0, 20) || 'model';
  const tracePart = sanitizeSessionPart(traceId).slice(0, 8) || 'trace';
  return `${base}_${modelPart}_${tracePart}`;
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

export interface TalkChatContext {
  req: IncomingMessage;
  res: ServerResponse;
  talkId: string;
  store: TalkStore;
  gatewayOrigin: string;
  authToken: string | undefined;
  logger: Logger;
  registry: ToolRegistry;
  executor: ToolExecutor;
  dataDir?: string;
}

/** Extract ```job``` blocks from AI response text. */
function parseJobBlocks(text: string): Array<{ schedule: string; prompt: string }> {
  const results: Array<{ schedule: string; prompt: string }> = [];
  const regex = /```job\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const scheduleLine = block.match(/^schedule:\s*(.+)$/m);
    const promptLine = block.match(/^prompt:\s*([\s\S]+?)$/m);
    if (scheduleLine && promptLine) {
      results.push({
        schedule: scheduleLine[1].trim(),
        prompt: promptLine[1].trim(),
      });
    }
  }
  return results;
}

export type AutomationIntentMode =
  | 'none'
  | 'recurring_explicit'
  | 'ambiguous_followup'
  | 'immediate_executable'
  | 'immediate_blocked';

function hasRecurringAutomationLanguage(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return /\b(automation|automations|job|jobs|schedule|scheduled|reschedule|recurring|cron)\b/.test(text)
    || /\b(every\s+\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks))\b/.test(text)
    || /\b(daily|weekly|monthly|yearly)\b/.test(text)
    || /\bon\s+[^\s]+/.test(text)
    || /\b(in\s+\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks))\b/.test(text)
    || /\b(at\s+\d{1,2}(:\d{2})?\s*(am|pm)?)\b/.test(text)
    || /\b(tomorrow|next\s+(hour|day|week|month))\b/.test(text);
}

function hasAmbiguousFollowupLanguage(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return /\b(follow\s*up|check\s*back|remind|reminder|later)\b/.test(text)
    && !hasRecurringAutomationLanguage(text);
}

export function classifyUserAutomationIntent(params: {
  message: string;
  likelyActionRequest: boolean;
  toolsEnabledForTurn: boolean;
  availableToolCount: number;
  hasPolicyBlockedTools: boolean;
}): AutomationIntentMode {
  const {
    message,
    likelyActionRequest,
    toolsEnabledForTurn,
    availableToolCount,
    hasPolicyBlockedTools,
  } = params;

  if (hasRecurringAutomationLanguage(message)) return 'recurring_explicit';
  if (hasAmbiguousFollowupLanguage(message)) return 'ambiguous_followup';
  if (!likelyActionRequest) return 'none';

  const blocked = !toolsEnabledForTurn || availableToolCount === 0 || hasPolicyBlockedTools;
  return blocked ? 'immediate_blocked' : 'immediate_executable';
}

export function classifyJobScheduleType(schedule: string): 'once' | 'recurring' | 'event' {
  if (parseEventTrigger(schedule)) return 'event';
  if (/^(in\s|at\s)/i.test(schedule.trim())) return 'once';
  return 'recurring';
}

export async function handleTalkChat(ctx: TalkChatContext): Promise<void> {
  const { req, res, talkId, store, gatewayOrigin, authToken, logger, registry, executor, dataDir } = ctx;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Parse request body (allow up to 5MB for image attachments)
  let body: {
    message: string;
    model?: string;
    agentName?: string;
    agentRole?: string;
    agentRoleInstructions?: string;
    otherAgents?: { name: string; role: string; model: string }[];
    imageBase64?: string;
    imageMimeType?: string;
    /** When true, this is a recovery retry — skip persisting the user message to avoid duplicates. */
    recovery?: boolean;
  };
  try {
    body = (await readJsonBody(req, 5 * 1024 * 1024)) as typeof body;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.message || typeof body.message !== 'string') {
    sendJson(res, 400, { error: 'Missing "message" field' });
    return;
  }

  // Load talk
  const meta = store.getTalk(talkId);
  if (!meta) {
    sendJson(res, 404, { error: 'Talk not found' });
    return;
  }

  // Resolve model (request override → talk default)
  const model = body.model || meta.model || 'openclaw';
  const talkExecutionMode = resolveExecutionMode(meta);
  // Only update the talk's default model for non-agent messages.
  // Agent messages use their own model without changing the talk default.
  if (body.model && body.model !== meta.model && !body.agentName) {
    store.updateTalk(talkId, { model: body.model });
  }

  // Per-turn tool policy:
  // - Model identity/meta questions use deterministic server-side answer.
  // - Talk-level toolMode controls when tools are enabled.
  // - allow/deny lists constrain which tools can run.
  const isModelQuestion = isModelIdentityQuestion(body.message);
  const talkToolMode = meta.toolMode ?? 'auto';
  const likelyActionRequest = isLikelyActionRequest(body.message);
  const mentionRelayPrompt = isMentionRelayPrompt(body.message);
  const explicitToolApproval = hasExplicitToolApproval(body.message);
  const enableToolsForTurn = !isModelQuestion
    && talkToolMode !== 'off'
    && (
      (talkToolMode === 'auto' && (likelyActionRequest || mentionRelayPrompt))
      || (talkToolMode === 'confirm' && explicitToolApproval)
    );
  const catalog = getToolCatalog(dataDir, logger);
  const globallyEnabledTools = catalog.filterEnabledTools(registry.listTools());
  const prePolicyToolInfos = filterToolInfos(
    globallyEnabledTools,
    meta.toolsAllow,
    meta.toolsDeny,
  );
  const policyStates = evaluateToolAvailability(prePolicyToolInfos, meta);
  const policyFilteredToolInfos = policyStates
    .filter((tool) => tool.enabled)
    .map(({ name, description, builtin }) => ({ name, description, builtin }));
  const availableToolInfos = prioritizeTurnToolInfos(policyFilteredToolInfos, body.message);
  const hasPolicyBlockedTools = likelyActionRequest
    && policyFilteredToolInfos.length === 0
    && prePolicyToolInfos.length > 0;
  const hasGoogleDriveTool = availableToolInfos.some(
    (tool) => tool.name.trim().toLowerCase() === 'google_drive_files',
  );
  const hasGoogleDocsReadTool = availableToolInfos.some(
    (tool) => tool.name.trim().toLowerCase() === 'google_docs_read',
  );
  const hasPdfExtractTool = availableToolInfos.some(
    (tool) => tool.name.trim().toLowerCase() === 'pdf_extract_text',
  );

  // Deterministic Drive listing fast path:
  // bypass model/tool-chaining for common "recent drive files" requests.
  if (!isModelQuestion && isGoogleDriveIntent(body.message) && hasGoogleDriveTool) {
    const driveLimit = extractDriveListLimit(body.message);
    const userMessageId = randomUUID();
    const driveResult = await executor.execute('google_drive_files', JSON.stringify({
      action: 'list',
      page_size: driveLimit,
      ...(meta.googleAuthProfile ? { profile: meta.googleAuthProfile } : {}),
    }));
    const directReply = driveResult.success
      ? driveResult.content
      : `Google Drive request failed: ${driveResult.content}`;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.write(`event: meta\ndata: ${JSON.stringify({ userMessageId })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: directReply } }],
      model,
    })}\n\n`);
    await store.appendMessage(talkId, {
      id: userMessageId,
      role: 'user',
      content: body.message,
      timestamp: Date.now(),
      ...(body.agentName && { agentName: body.agentName }),
      ...(body.agentRole && { agentRole: body.agentRole as any }),
    });
    await store.appendMessage(talkId, {
      id: randomUUID(),
      role: 'assistant',
      content: directReply,
      timestamp: Date.now(),
      model,
      ...(body.agentName && { agentName: body.agentName }),
      ...(body.agentRole && { agentRole: body.agentRole as any }),
    });
    scheduleContextUpdate({
      talkId,
      userMessage: body.message,
      assistantResponse: directReply,
      model,
      gatewayOrigin,
      authToken,
      store,
      logger,
    });
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  // Deterministic Google Docs read fast path:
  // bypass model/tool-chaining when the user directly provides a Google Docs URL.
  const googleDocId = extractGoogleDocsDocumentIdFromUrl(body.message);
  if (!isModelQuestion && googleDocId && hasGoogleDocsReadTool) {
    const userMessageId = randomUUID();
    const docsResult = await executor.execute('google_docs_read', JSON.stringify({
      doc_id: googleDocId,
      ...(meta.googleAuthProfile ? { profile: meta.googleAuthProfile } : {}),
    }));
    const directReply = docsResult.success
      ? docsResult.content
      : `Google Docs request failed: ${docsResult.content}`;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.write(`event: meta\ndata: ${JSON.stringify({ userMessageId })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: directReply } }],
      model,
    })}\n\n`);
    await store.appendMessage(talkId, {
      id: userMessageId,
      role: 'user',
      content: body.message,
      timestamp: Date.now(),
      ...(body.agentName && { agentName: body.agentName }),
      ...(body.agentRole && { agentRole: body.agentRole as any }),
    });
    await store.appendMessage(talkId, {
      id: randomUUID(),
      role: 'assistant',
      content: directReply,
      timestamp: Date.now(),
      model,
      ...(body.agentName && { agentName: body.agentName }),
      ...(body.agentRole && { agentRole: body.agentRole as any }),
    });
    scheduleContextUpdate({
      talkId,
      userMessage: body.message,
      assistantResponse: directReply,
      model,
      gatewayOrigin,
      authToken,
      store,
      logger,
    });
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  // Deterministic PDF extraction fast path for uploaded files:
  // bypass model/tool-chaining when user points at a PDF path.
  const pdfPath = extractPdfPathFromMessage(body.message);
  if (!isModelQuestion && pdfPath && hasPdfExtractTool) {
    const userMessageId = randomUUID();
    const pdfResult = await executor.execute('pdf_extract_text', JSON.stringify({
      path: pdfPath,
    }));
    const directReply = pdfResult.success
      ? pdfResult.content
      : `PDF extraction failed: ${pdfResult.content}`;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.write(`event: meta\ndata: ${JSON.stringify({ userMessageId })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: directReply } }],
      model,
    })}\n\n`);
    await store.appendMessage(talkId, {
      id: userMessageId,
      role: 'user',
      content: body.message,
      timestamp: Date.now(),
      ...(body.agentName && { agentName: body.agentName }),
      ...(body.agentRole && { agentRole: body.agentRole as any }),
    });
    await store.appendMessage(talkId, {
      id: randomUUID(),
      role: 'assistant',
      content: directReply,
      timestamp: Date.now(),
      model,
      ...(body.agentName && { agentName: body.agentName }),
      ...(body.agentRole && { agentRole: body.agentRole as any }),
    });
    scheduleContextUpdate({
      talkId,
      userMessage: body.message,
      assistantResponse: directReply,
      model,
      gatewayOrigin,
      authToken,
      store,
      logger,
    });
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  // Load context and pinned messages
  const contextMd = await store.getContextMd(talkId);
  const pinnedMessages: TalkMessage[] = [];
  for (const pinId of meta.pinnedMessageIds) {
    const msg = await store.getMessage(talkId, pinId);
    if (msg) pinnedMessages.push(msg);
  }

  // Compose system prompt (now includes tool descriptions)
  const agentOverride = body.agentName ? {
    name: body.agentName,
    role: body.agentRole || '',
    roleInstructions: body.agentRoleInstructions || '',
    otherAgents: body.otherAgents || [],
  } : undefined;
  const systemPrompt = composeSystemPrompt({
    meta,
    contextMd,
    pinnedMessages,
    activeModel: model,
    agentOverride,
    toolManifest: availableToolInfos,
    toolMode: talkToolMode,
    registry: enableToolsForTurn ? registry : undefined,
  });

  // Load recent history and adapt the included window to fit context budget.
  const recentHistory = await store.getRecentMessages(talkId, MAX_CONTEXT_MESSAGES);
  const systemPromptBytes = Buffer.byteLength(systemPrompt ?? '', 'utf-8');
  const userTurnBytes = Buffer.byteLength(body.message, 'utf-8');
  const historyBudgetBytes = Math.max(
    MIN_HISTORY_BUDGET_BYTES,
    MAX_CONTEXT_BUDGET_BYTES - systemPromptBytes - userTurnBytes - RESERVED_OVERHEAD_BYTES,
  );
  const history = selectHistoryWithinBudget(recentHistory, historyBudgetBytes);

  // Build message array for LLM, handling tool messages from history
  const messages: Array<any> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  for (const m of history) {
    if (m.role === 'tool') {
      // Tool result messages need tool_call_id and name
      messages.push({
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id,
        name: m.tool_name,
      });
    } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // Assistant messages with tool calls
      let content = m.content;
      if (m.agentName) {
        content = `[${m.agentName}]: ${content}`;
      }
      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: m.tool_calls,
      });
    } else {
      let content = m.content;
      if (m.agentName && m.role === 'assistant') {
        content = `[${m.agentName}]: ${content}`;
      }
      messages.push({ role: m.role, content });
    }
  }

  // Build user message content (multimodal when image attached)
  if (body.imageBase64 && body.imageMimeType) {
    messages.push({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${body.imageMimeType};base64,${body.imageBase64}` } },
        { type: 'text', text: body.message },
      ],
    });
  } else {
    messages.push({ role: 'user', content: body.message });
  }

  // Build attachment metadata (base64 is NOT persisted)
  let attachmentMeta: ImageAttachmentMeta | undefined;
  if (body.imageBase64 && body.imageMimeType) {
    const base64Bytes = Math.ceil(body.imageBase64.length * 3 / 4);
    attachmentMeta = {
      filename: 'image',
      mimeType: body.imageMimeType,
      width: 0,
      height: 0,
      sizeBytes: base64Bytes,
    };
  }

  // Persist user message (metadata only, no base64)
  // Skip persistence on recovery retries to avoid duplicate user messages.
  const userMsg: TalkMessage = {
    id: randomUUID(),
    role: 'user',
    content: body.message,
    timestamp: Date.now(),
    ...(body.agentName && { agentName: body.agentName }),
    ...(body.agentRole && { agentRole: body.agentRole as any }),
    ...(attachmentMeta && { attachment: attachmentMeta }),
  };
  if (!body.recovery) {
    await store.appendMessage(talkId, userMsg);
  }

  // Disable server-level timeouts for this long-lived SSE connection.
  // Node.js 18+ defaults requestTimeout to 5 minutes, which is too short
  // for multi-iteration tool loops (Opus + several tool calls can take 10+ min).
  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);

  // Client disconnect detection — abort the tool loop when nobody is listening.
  const clientAbort = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      logger.info(`TalkChat: client disconnected for talk ${talkId}, aborting tool loop`);
      clientAbort.abort();
    }
  });

  // Set up SSE response headers
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Inject the user message ID as a custom SSE event so the client can reference it
  res.write(`event: meta\ndata: ${JSON.stringify({ userMessageId: userMsg.id })}\n\n`);
  emitStatusEvent(res, {
    code: 'ROUTE_READY',
    message: `Routing request via ${talkExecutionMode === 'full_control' ? 'ClawTalk Proxy' : 'OpenClaw Agent'}...`,
    level: 'info',
  });

  // Tool policy derived above and mirrored in prompt composition.
  const disableTools = !enableToolsForTurn || availableToolInfos.length === 0;
  const automationIntent = classifyUserAutomationIntent({
    message: body.message,
    likelyActionRequest,
    toolsEnabledForTurn: !disableTools,
    availableToolCount: availableToolInfos.length,
    hasPolicyBlockedTools,
  });
  const enabledToolNames = new Set(availableToolInfos.map((tool) => tool.name.toLowerCase()));
  const tools = disableTools
    ? []
    : registry.getToolSchemas().filter((tool) => enabledToolNames.has(tool.function.name.toLowerCase()));
  logger.info(
    `TalkChat: tool availability talkId=${talkId} enabled=${!disableTools} count=${tools.length} names=${tools.map((t) => t.function.name).join(',') || '-'}`,
  );
  const maxIterations = disableTools ? 2 : undefined;
  if (disableTools) {
    const reason = isModelQuestion
      ? 'model-meta'
      : talkToolMode === 'off'
        ? 'tool-mode-off'
        : talkToolMode === 'confirm' && !explicitToolApproval
          ? 'tool-confirm-awaiting-approval'
          : mentionRelayPrompt
            ? 'mention-relay'
            : 'non-action-turn';
    logger.info(`TalkChat: tool bypass (${reason}) talkId=${talkId}`);
  }
  if (hasPolicyBlockedTools) {
    const blocked = policyStates.find((tool) => !tool.enabled && tool.reason);
    emitStatusEvent(res, {
      code: 'TOOLS_BLOCKED_BY_POLICY',
      message: blocked?.reason || 'Tools are blocked by current Talk policy settings.',
      level: 'warn',
      meta: blocked?.reasonCode ? { reasonCode: blocked.reasonCode } : undefined,
    });
  }

  const browserIntent = isBrowserIntent(body.message);
  const hasBrowserCapability = availableToolInfos.some((tool) => isBrowserTool(tool.name));
  if (browserIntent && talkExecutionMode === 'full_control') {
    const errPayload: TalkErrorPayload = {
      code: 'MODE_BLOCKED_BROWSER',
      message: 'Browser control is unavailable in ClawTalk Proxy mode.',
      hint: 'Switch Execution Mode to OpenClaw Agent, then retry.',
      transient: false,
      retryable: true,
    };
    emitStatusEvent(res, {
      code: 'BROWSER_PRECHECK_FAILED',
      message: errPayload.message,
      level: 'warn',
    });
    emitErrorEvent(res, errPayload);
    store.setProcessing(talkId, false);
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }
  if (browserIntent && !hasBrowserCapability) {
    emitStatusEvent(res, {
      code: 'BROWSER_CAPABILITY_UNKNOWN',
      message: 'No browser-specific tool is currently enabled for this talk. Response may be limited to guidance only.',
      level: 'warn',
    });
  }

  let fullContent = '';
  let responseModel: string | undefined;
  let toolCallMessages: Array<any> = [];
  const routing = resolveTalkAgentRouting(meta, body.agentName);
  const inboundAgentHeaderRaw = firstHeaderValue(req.headers['x-openclaw-agent-id']);
  const inboundAgentId = inboundAgentHeaderRaw?.trim() || undefined;
  const traceId = randomUUID();
  const routeDiag = await collectRoutingDiagnostics({
    requestedModel: model,
    headerAgentId: routing.headerAgentId,
  });
  const resolvedHeaderAgentId = routing.headerAgentId
    ?? inboundAgentId;
  // Keep `agent:<id>` stable and real so OpenClaw resolves workspace/identity correctly.
  // Use a separate lane suffix for per-run isolation.
  const resolvedSessionAgentId =
    resolvedHeaderAgentId?.trim()
    || inboundAgentId
    || CLAWTALK_DEFAULT_AGENT_ID;
  const sessionRoutePart = resolvedSessionAgentId;
  const runScopedSessionPart = buildRunScopedSessionPart(
    routing.sessionAgentPart || resolvedSessionAgentId,
    model,
    traceId,
  );
  const sessionKey = (() => {
    if (talkExecutionMode === 'full_control') {
      // No `agent:` prefix — keeps request in transparent LLM-proxy mode so
      // gateway tools are callable instead of being replaced by OpenClaw agent tools.
      return buildFullControlTalkSessionKey(talkId, runScopedSessionPart);
    }
    return buildTalkSessionKey(talkId, resolvedSessionAgentId, runScopedSessionPart);
  })();
  const extraHeaders: Record<string, string> = {
    'x-openclaw-session-key': sessionKey,
    'x-openclaw-trace-id': traceId,
  };
  // In full_control mode, suppress agent-id header so OpenClaw doesn't activate
  // its embedded agent. Model routing happens via the `model` param instead.
  if (talkExecutionMode !== 'full_control' && resolvedHeaderAgentId?.trim()) {
    extraHeaders['x-openclaw-agent-id'] = resolvedHeaderAgentId.trim();
  }
  logger.info(
    `ModelRoute trace=${traceId} flow=talk-chat talkId=${talkId} requestedModel=${routeDiag.requestedModel} `
    + `sessionRoutePart=${sessionRoutePart} runScopedSessionPart=${runScopedSessionPart} executionMode=${talkExecutionMode} sessionKey=${extraHeaders['x-openclaw-session-key']} `
    + `inboundAgentId=${inboundAgentId ?? '-'} `
    + `headerAgentId=${routing.headerAgentId ?? '-'} effectiveHeaderAgentId=${resolvedHeaderAgentId ?? '-'} `
    + `configuredAgentId=${routeDiag.configuredAgentId ?? '-'} `
    + `configuredAgentModel=${routeDiag.configuredAgentModel ?? '-'} defaultAgentId=${routeDiag.defaultAgentId ?? '-'} `
    + `defaultAgentModel=${routeDiag.defaultAgentModel ?? '-'} matchedRequestedModelAgentId=${routeDiag.matchedRequestedModelAgentId ?? '-'} `
    + `matchedRequestedModelAgentModel=${routeDiag.matchedRequestedModelAgentModel ?? '-'} notes=${routeDiag.notes.join(',') || '-'}`,
  );

  if (isModelQuestion) {
    const effectiveAgentId = resolvedHeaderAgentId ?? resolvedSessionAgentId ?? '-';
    const effectiveAgentModel = model;
    const routedAgentDefaultModel = routeDiag.configuredAgentModel
      ?? routeDiag.defaultAgentModel
      ?? '-';
    const directReply =
      `Requested model: ${model}\n` +
      `Effective agent route: ${effectiveAgentId}\n` +
      `Effective agent model: ${effectiveAgentModel}\n` +
      `Routed agent default model: ${routedAgentDefaultModel}`;

    // Return deterministic model-routing truth without invoking the LLM.
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: directReply } }],
      model,
    })}\n\n`);
    const assistantMsg: TalkMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: directReply,
      timestamp: Date.now(),
      model,
      ...(body.agentName && { agentName: body.agentName }),
      ...(body.agentRole && { agentRole: body.agentRole as any }),
    };
    await store.appendMessage(talkId, assistantMsg);
    scheduleContextUpdate({
      talkId,
      userMessage: body.message,
      assistantResponse: directReply,
      model,
      gatewayOrigin,
      authToken,
      store,
      logger,
    });
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  store.setProcessing(talkId, true);
  try {
    const result = await runToolLoop({
      messages,
      model,
      tools,
      gatewayOrigin,
      authToken,
      extraHeaders,
      res,
      registry,
      executor,
      logger,
      clientSignal: clientAbort.signal,
      traceId,
      firstTokenTimeoutMs: resolveTalkFirstTokenTimeoutMs(),
      timeoutMs: resolveTalkInactivityTimeoutMs(),
      maxTotalMs: resolveTalkTotalTimeoutMs(),
      maxIterations,
      toolChoice: disableTools ? 'none' : 'auto',
      defaultGoogleAuthProfile: meta.googleAuthProfile,
      onStatus: (status) => emitStatusEvent(res, status),
    });

    fullContent = result.fullContent;
    responseModel = result.responseModel;
    toolCallMessages = result.toolCallMessages;
    logger.info(
      `ModelRoute trace=${traceId} flow=talk-chat-complete talkId=${talkId} responseModel=${responseModel ?? '-'} chars=${fullContent.length}`,
    );
  } catch (err) {
    const payload = classifyTalkError(err, clientAbort.signal);
    logger.error(`TalkChat: tool loop error: ${payload.message}`);
    logger.warn(`ModelRoute trace=${traceId} flow=talk-chat-error talkId=${talkId} error=${payload.message}`);

    // Don't write to a closed connection
    if (!clientAbort.signal.aborted && !res.writableEnded) {
      emitErrorEvent(res, payload);
    }
  } finally {
    store.setProcessing(talkId, false);
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  // Persist assistant message and any tool messages
  if (fullContent.trim() || toolCallMessages.length > 0) {
    // Persist intermediate tool call / tool result messages
    for (const msg of toolCallMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        const toolAssistantMsg: TalkMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: msg.content || '',
          timestamp: Date.now(),
          model: responseModel || model,
          tool_calls: msg.tool_calls,
          ...(body.agentName && { agentName: body.agentName }),
          ...(body.agentRole && { agentRole: body.agentRole as any }),
        };
        await store.appendMessage(talkId, toolAssistantMsg);
      } else if (msg.role === 'tool') {
        const toolResultMsg: TalkMessage = {
          id: randomUUID(),
          role: 'tool',
          content: msg.content,
          timestamp: Date.now(),
          tool_call_id: msg.tool_call_id,
          tool_name: msg.name,
        };
        await store.appendMessage(talkId, toolResultMsg);
      }
    }

    // Persist the final assistant text response
    if (fullContent.trim()) {
      const assistantMsg: TalkMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: fullContent,
        timestamp: Date.now(),
        model: responseModel || model,
        ...(body.agentName && { agentName: body.agentName }),
        ...(body.agentRole && { agentRole: body.agentRole as any }),
      };
      await store.appendMessage(talkId, assistantMsg);

      // Auto-create jobs from ```job``` blocks in the response only when user explicitly
      // asked for scheduled/automation behavior.
      const jobBlocks = parseJobBlocks(fullContent);
      if (jobBlocks.length > 0) {
        logger.info(
          `TalkChat: job creation intent mode=${automationIntent} jobBlocks=${jobBlocks.length} talkId=${talkId}`,
        );
      }
      for (const { schedule, prompt } of jobBlocks) {
        const scheduleType = classifyJobScheduleType(schedule);
        let allow = false;
        let normalizedSchedule = schedule;
        let type: 'once' | 'recurring' | 'event' = scheduleType;

        if (automationIntent === 'recurring_explicit') {
          allow = true;
        } else if (automationIntent === 'immediate_blocked') {
          allow = true;
          normalizedSchedule = 'in 1m';
          type = 'once';
        }

        if (!allow) {
          logger.info(
            `TalkChat: blocked assistant job block schedule="${schedule}" scheduleType=${scheduleType} intent=${automationIntent} talkId=${talkId}`,
          );
          continue;
        }

        const scheduleError = validateSchedule(normalizedSchedule);
        if (scheduleError) {
          logger.warn(`TalkChat: skipped auto-created job with invalid schedule "${normalizedSchedule}": ${scheduleError}`);
          continue;
        }
        const eventScope = parseEventTrigger(normalizedSchedule);
        if (type === 'event' && eventScope) {
          const bindings = meta.platformBindings ?? [];
          let resolvedScope = eventScope;
          const platformMatch = eventScope.match(/^platform(\d+)$/i);
          if (platformMatch) {
            const idx = parseInt(platformMatch[1], 10);
            if (idx < 1 || idx > bindings.length) {
              logger.warn(
                `TalkChat: skipped auto-created event job with unknown platform index platform${idx} in talk ${talkId}`,
              );
              continue;
            }
            resolvedScope = bindings[idx - 1].scope;
          }

          const matchingBinding = bindings.find(
            b => b.scope.toLowerCase() === resolvedScope.toLowerCase(),
          );
          if (!matchingBinding) {
            logger.warn(
              `TalkChat: skipped auto-created event job with unbound scope "${resolvedScope}" in talk ${talkId}`,
            );
            continue;
          }

          normalizedSchedule = `on ${resolvedScope}`;
        }
        const job = store.addJob(talkId, normalizedSchedule, prompt, type);
        if (job) {
          logger.info(`TalkChat: auto-created ${type} job ${job.id} [${normalizedSchedule}] for talk ${talkId}`);
        }
      }

      // Trigger async context update
      scheduleContextUpdate({
        talkId,
        userMessage: body.message,
        assistantResponse: fullContent,
        model: responseModel || model,
        gatewayOrigin,
        authToken,
        store,
        logger,
      });
    }
  }
}
