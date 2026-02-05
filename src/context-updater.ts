/**
 * Context Document Updater
 *
 * After each assistant response, asynchronously updates the Talk's context.md
 * using the conversation model. The context doc is a living summary that
 * gets included in the system prompt.
 */

import type { TalkStore } from './talk-store.js';
import type { Logger } from './types.js';

const CONTEXT_UPDATE_PROMPT = `You maintain a running context document for an ongoing conversation.
Update the document below based on the latest exchange.

Rules:
- Keep it under 400 words
- Track: key decisions, important facts, current progress, open questions
- Remove information that is no longer relevant
- Write in present tense, third person ("The user is working on...")
- Do not include greetings, pleasantries, or meta-commentary

Current document:
---
{{CURRENT_CONTEXT}}
---

Latest exchange:
User: {{USER_MESSAGE}}
Assistant: {{ASSISTANT_RESPONSE}}

Output only the updated document, nothing else.`;

/** Rate-limit: minimum interval between context updates per talk. */
const MIN_UPDATE_INTERVAL_MS = 30_000;

/** Track last update time per talk to rate-limit. */
const lastUpdateTime = new Map<string, number>();

export interface ContextUpdateOptions {
  talkId: string;
  userMessage: string;
  assistantResponse: string;
  model: string;
  gatewayOrigin: string;
  authToken: string | undefined;
  store: TalkStore;
  logger: Logger;
}

/**
 * Fire-and-forget context.md update. Call this after each assistant response.
 * Skips if called too recently for the same talk.
 */
export function scheduleContextUpdate(opts: ContextUpdateOptions): void {
  const now = Date.now();
  const lastUpdate = lastUpdateTime.get(opts.talkId) ?? 0;
  if (now - lastUpdate < MIN_UPDATE_INTERVAL_MS) {
    opts.logger.debug(`ContextUpdater: skipping update for ${opts.talkId} (rate limited)`);
    return;
  }
  lastUpdateTime.set(opts.talkId, now);

  doContextUpdate(opts).catch(err => {
    opts.logger.warn(`ContextUpdater: failed for ${opts.talkId}: ${err}`);
  });
}

async function doContextUpdate(opts: ContextUpdateOptions): Promise<void> {
  const { talkId, userMessage, assistantResponse, model, gatewayOrigin, authToken, store, logger } = opts;

  const currentContext = await store.getContextMd(talkId);

  // Truncate assistant response to avoid huge context update prompts
  const truncatedResponse = assistantResponse.length > 500
    ? assistantResponse.slice(0, 500) + '...'
    : assistantResponse;

  const prompt = CONTEXT_UPDATE_PROMPT
    .replace('{{CURRENT_CONTEXT}}', currentContext || '(empty — this is a new conversation)')
    .replace('{{USER_MESSAGE}}', userMessage)
    .replace('{{ASSISTANT_RESPONSE}}', truncatedResponse);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const response = await fetch(`${gatewayOrigin}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    logger.warn(`ContextUpdater: LLM call failed (${response.status}): ${errBody.slice(0, 200)}`);
    return;
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const updatedContext = json.choices?.[0]?.message?.content?.trim();

  if (updatedContext) {
    await store.setContextMd(talkId, updatedContext);
    logger.debug(`ContextUpdater: updated context.md for ${talkId} (${updatedContext.length} chars)`);
  }
}
