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
import type { ToolRegistry } from './tool-registry.js';
import type { ToolExecutor } from './tool-executor.js';
import { sendJson, readJsonBody } from './http.js';
import { composeSystemPrompt } from './system-prompt.js';
import { scheduleContextUpdate } from './context-updater.js';
import { runToolLoop } from './tool-loop.js';

/** Maximum number of history messages to include in LLM context. */
const MAX_CONTEXT_MESSAGES = 50;

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

export async function handleTalkChat(ctx: TalkChatContext): Promise<void> {
  const { req, res, talkId, store, gatewayOrigin, authToken, logger, registry, executor } = ctx;

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
  const model = body.model || meta.model || 'moltbot';
  // Only update the talk's default model for non-agent messages.
  // Agent messages use their own model without changing the talk default.
  if (body.model && body.model !== meta.model && !body.agentName) {
    store.updateTalk(talkId, { model: body.model });
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
  const systemPrompt = composeSystemPrompt({ meta, contextMd, pinnedMessages, agentOverride, registry });

  // Load recent history
  const history = await store.getRecentMessages(talkId, MAX_CONTEXT_MESSAGES);

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
  const userMsg: TalkMessage = {
    id: randomUUID(),
    role: 'user',
    content: body.message,
    timestamp: Date.now(),
    ...(body.agentName && { agentName: body.agentName }),
    ...(body.agentRole && { agentRole: body.agentRole as any }),
    ...(attachmentMeta && { attachment: attachmentMeta }),
  };
  await store.appendMessage(talkId, userMsg);

  // Disable server-level timeouts for this long-lived SSE connection.
  // Node.js 18+ defaults requestTimeout to 5 minutes, which is too short
  // for multi-iteration tool loops (Opus + several tool calls can take 10+ min).
  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);

  // Set up SSE response headers
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Inject the user message ID as a custom SSE event so the client can reference it
  res.write(`event: meta\ndata: ${JSON.stringify({ userMessageId: userMsg.id })}\n\n`);

  // Get tool schemas for this request
  const tools = registry.getToolSchemas();

  let fullContent = '';
  let responseModel: string | undefined;
  let toolCallMessages: Array<any> = [];

  try {
    const result = await runToolLoop({
      messages,
      model,
      tools,
      gatewayOrigin,
      authToken,
      res,
      registry,
      executor,
      logger,
    });

    fullContent = result.fullContent;
    responseModel = result.responseModel;
    toolCallMessages = result.toolCallMessages;
  } catch (err) {
    logger.error(`TalkChat: tool loop error: ${err}`);
    // Write error as SSE event before closing
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: `\n\n[Error: ${err instanceof Error ? err.message : 'Unknown error'}]` } }],
    })}\n\n`);
  } finally {
    res.write('data: [DONE]\n\n');
    res.end();
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

      // Auto-create jobs from ```job``` blocks in the response
      const jobBlocks = parseJobBlocks(fullContent);
      for (const { schedule, prompt } of jobBlocks) {
        const type = /^(in\s|at\s)/i.test(schedule) ? 'once' as const : 'recurring' as const;
        const job = store.addJob(talkId, schedule, prompt, type);
        if (job) {
          logger.info(`TalkChat: auto-created ${type} job ${job.id} [${schedule}] for talk ${talkId}`);
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
