/**
 * Talk Chat Handler
 *
 * POST /api/talks/:id/chat — the main endpoint.
 * Composes the system prompt, builds the message array, proxies to
 * Moltbot /v1/chat/completions with SSE streaming, persists history,
 * and triggers async context.md updates.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TalkStore } from './talk-store.js';
import type { TalkMessage, Logger } from './types.js';
import { sendJson, readJsonBody } from './http.js';
import { composeSystemPrompt } from './system-prompt.js';
import { scheduleContextUpdate } from './context-updater.js';

/** Maximum number of history messages to include in LLM context. */
const MAX_CONTEXT_MESSAGES = 50;

/** Maximum response body size for non-streaming fallback. */
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface TalkChatContext {
  req: IncomingMessage;
  res: ServerResponse;
  talkId: string;
  store: TalkStore;
  gatewayOrigin: string;
  authToken: string | undefined;
  logger: Logger;
}

export async function handleTalkChat(ctx: TalkChatContext): Promise<void> {
  const { req, res, talkId, store, gatewayOrigin, authToken, logger } = ctx;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Parse request body
  let body: { message: string; model?: string };
  try {
    body = (await readJsonBody(req)) as typeof body;
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
  if (body.model && body.model !== meta.model) {
    store.updateTalk(talkId, { model: body.model });
  }

  // Load context and pinned messages
  const contextMd = await store.getContextMd(talkId);
  const pinnedMessages: TalkMessage[] = [];
  for (const pinId of meta.pinnedMessageIds) {
    const msg = await store.getMessage(talkId, pinId);
    if (msg) pinnedMessages.push(msg);
  }

  // Compose system prompt
  const systemPrompt = composeSystemPrompt({ meta, contextMd, pinnedMessages });

  // Load recent history
  const history = await store.getRecentMessages(talkId, MAX_CONTEXT_MESSAGES);

  // Build message array for LLM
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: 'user', content: body.message });

  // Persist user message
  const userMsg: TalkMessage = {
    id: randomUUID(),
    role: 'user',
    content: body.message,
    timestamp: Date.now(),
  };
  await store.appendMessage(talkId, userMsg);

  // Call Moltbot /v1/chat/completions (streaming)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  let llmResponse: Response;
  try {
    llmResponse = await fetch(`${gatewayOrigin}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    logger.error(`TalkChat: LLM fetch failed: ${err}`);
    sendJson(res, 502, { error: 'Failed to reach AI provider' });
    return;
  }

  if (!llmResponse.ok) {
    const errBody = await llmResponse.text().catch(() => '');
    logger.warn(`TalkChat: LLM error (${llmResponse.status}): ${errBody.slice(0, 200)}`);
    sendJson(res, llmResponse.status, { error: errBody.slice(0, 500) });
    return;
  }

  // Stream SSE back to client, collecting full content for persistence
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Inject the user message ID as a custom SSE event so the client can reference it
  res.write(`event: meta\ndata: ${JSON.stringify({ userMessageId: userMsg.id })}\n\n`);

  const reader = llmResponse.body?.getReader();
  if (!reader) {
    sendJson(res, 502, { error: 'No response body from AI provider' });
    return;
  }

  const decoder = new TextDecoder();
  let fullContent = '';
  let responseModel: string | undefined;
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // Pass the raw SSE chunk through to the client
      res.write(chunk);

      // Also parse it to collect the full response
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (!responseModel && parsed.model) {
              responseModel = parsed.model;
            }
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) fullContent += content;
          } catch {
            // partial chunk, ignore
          }
        }
      }
    }
  } catch (err) {
    logger.error(`TalkChat: stream error: ${err}`);
  } finally {
    res.end();
  }

  // Persist assistant message
  if (fullContent.trim()) {
    const assistantMsg: TalkMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: fullContent,
      timestamp: Date.now(),
      model: responseModel || model,
    };
    await store.appendMessage(talkId, assistantMsg);

    // Send the assistant message ID as a trailing custom event (already ended — use persist only)
    // The client can fetch the message ID from the meta event or GET /messages

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
