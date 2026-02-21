/**
 * Context Document Updater
 *
 * After each assistant response, asynchronously updates the Talk's context.md
 * using the conversation model. The context doc is a living summary that
 * gets included in the system prompt.
 *
 * Also extracts durable knowledge into per-topic knowledge files when the
 * conversation contains stable facts worth preserving beyond the current
 * context window.
 */

import type { TalkStore } from './talk-store.js';
import type { KnowledgeIndexEntry, Logger } from './types.js';
import { isValidKnowledgeSlug, normalizeKnowledgeSlug } from './talk-store.js';

const CONTEXT_UPDATE_PROMPT = `You maintain a running context document and optional knowledge files for an ongoing conversation.

## CONTEXT DOCUMENT
The context document tracks transient conversation state: what's being discussed right now, recent decisions, open questions. Keep it under 400 words. Remove information that is no longer relevant. Write in present tense, third person.

## KNOWLEDGE FILES
Knowledge files store durable facts that should persist even when the conversation moves on. Each topic file is 200-300 words of stable, factual information about one subject (a person, a policy, a project, etc.).

Create or update a knowledge file when the conversation establishes or modifies a durable fact. Do NOT create knowledge files for transient discussion topics or questions.

{{KNOWLEDGE_INDEX_SECTION}}

## OUTPUT FORMAT
Always start with the context document using the [CONTEXT] marker. Then optionally add knowledge file blocks.

[CONTEXT]
(updated context document here, under 400 words)

[KNOWLEDGE:slug|one-line summary]
(topic content, 200-300 words of durable facts)

[KNOWLEDGE:another-slug|one-line summary]
(topic content)

Slug rules: lowercase, alphanumeric and hyphens only, 2-60 chars, no double hyphens.

---

Current context document:
---
{{CURRENT_CONTEXT}}
---

Latest exchange:
User: {{USER_MESSAGE}}
Assistant: {{ASSISTANT_RESPONSE}}

Output the updated context document and any knowledge file updates using the format above.`;

/** Rate-limit: minimum interval between context updates per talk. */
const MIN_UPDATE_INTERVAL_MS = 30_000;

/** Maximum entries in the lastUpdateTime map. */
const MAX_UPDATE_TIME_ENTRIES = 500;

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

export interface ParsedContextUpdateOutput {
  contextMd: string;
  knowledgeOps: Array<{ slug: string; summary: string; content: string }>;
}

/**
 * Build the knowledge index section for the prompt.
 * Shows existing topics so the model knows what's already stored.
 */
export function buildKnowledgeIndexSection(index: KnowledgeIndexEntry[]): string {
  if (index.length === 0) {
    return 'Existing knowledge files: (none)';
  }
  const lines = index.map(e => `- ${e.slug}: ${e.summary}`);
  return `Existing knowledge files:\n${lines.join('\n')}`;
}

/**
 * Parse the structured output from the context update LLM call.
 * Handles backward compatibility: if no markers are present, entire output = context.md.
 */
export function parseContextUpdateOutput(raw: string): ParsedContextUpdateOutput {
  const trimmed = raw.trim();

  // No markers at all → backward compat: entire output is context.md
  if (!trimmed.includes('[CONTEXT]') && !trimmed.includes('[KNOWLEDGE:')) {
    return { contextMd: trimmed, knowledgeOps: [] };
  }

  const knowledgeOps: Array<{ slug: string; summary: string; content: string }> = [];
  let contextMd = '';

  // Extract [CONTEXT] section
  const contextStart = trimmed.indexOf('[CONTEXT]');
  if (contextStart >= 0) {
    const afterMarker = trimmed.slice(contextStart + '[CONTEXT]'.length);
    // Context ends at the next [KNOWLEDGE: marker or end of string
    const nextKnowledge = afterMarker.indexOf('[KNOWLEDGE:');
    contextMd = nextKnowledge >= 0
      ? afterMarker.slice(0, nextKnowledge).trim()
      : afterMarker.trim();
  } else {
    // [KNOWLEDGE: markers exist but no [CONTEXT] marker — use pre-marker text
    const firstKnowledge = trimmed.indexOf('[KNOWLEDGE:');
    contextMd = firstKnowledge > 0 ? trimmed.slice(0, firstKnowledge).trim() : '';
  }

  // Extract [KNOWLEDGE:slug|summary] blocks
  const knowledgeRegex = /\[KNOWLEDGE:([^\]|]+)\|([^\]]+)\]/g;
  let match;
  const markers: Array<{ slug: string; summary: string; startAfter: number }> = [];
  while ((match = knowledgeRegex.exec(trimmed)) !== null) {
    const rawSlug = match[1].trim();
    const summary = match[2].trim();
    const startAfter = match.index + match[0].length;
    markers.push({ slug: rawSlug, summary, startAfter });
  }

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const nextStart = i + 1 < markers.length
      ? trimmed.indexOf('[KNOWLEDGE:', marker.startAfter)
      : trimmed.length;
    const content = trimmed.slice(marker.startAfter, nextStart).trim();
    if (!content) continue;

    let slug = normalizeKnowledgeSlug(marker.slug);
    if (!slug || !isValidKnowledgeSlug(slug)) continue;

    knowledgeOps.push({ slug, summary: marker.summary, content });
  }

  return { contextMd, knowledgeOps };
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

  // Prune oldest entries if map exceeds cap
  if (lastUpdateTime.size > MAX_UPDATE_TIME_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, time] of lastUpdateTime) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }
    if (oldestKey) lastUpdateTime.delete(oldestKey);
  }

  doContextUpdate(opts).catch(err => {
    opts.logger.warn(`ContextUpdater: failed for ${opts.talkId}: ${err}`);
  });
}

async function doContextUpdate(opts: ContextUpdateOptions): Promise<void> {
  const { talkId, userMessage, assistantResponse, model, gatewayOrigin, authToken, store, logger } = opts;

  const currentContext = await store.getContextMd(talkId);
  const knowledgeIndex = await store.getKnowledgeIndex(talkId);
  const hasKnowledge = knowledgeIndex.length > 0;

  // Truncate assistant response to avoid huge context update prompts
  const truncatedResponse = assistantResponse.length > 500
    ? assistantResponse.slice(0, 500) + '...'
    : assistantResponse;

  const prompt = CONTEXT_UPDATE_PROMPT
    .replace('{{KNOWLEDGE_INDEX_SECTION}}', buildKnowledgeIndexSection(knowledgeIndex))
    .replace('{{CURRENT_CONTEXT}}', currentContext || '(empty — this is a new conversation)')
    .replace('{{USER_MESSAGE}}', userMessage)
    .replace('{{ASSISTANT_RESPONSE}}', truncatedResponse);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const maxTokens = hasKnowledge ? 1200 : 1000;

  const response = await fetch(`${gatewayOrigin}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      tool_choice: 'none',
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
  const rawOutput = json.choices?.[0]?.message?.content?.trim();

  if (!rawOutput) return;

  const parsed = parseContextUpdateOutput(rawOutput);

  if (parsed.contextMd) {
    await store.setContextMd(talkId, parsed.contextMd);
    logger.debug(`ContextUpdater: updated context.md for ${talkId} (${parsed.contextMd.length} chars)`);
  }

  for (const op of parsed.knowledgeOps) {
    try {
      await store.setKnowledgeTopic(talkId, op.slug, op.content, op.summary);
      logger.debug(`ContextUpdater: wrote knowledge/${op.slug}.md for ${talkId} (${op.content.length} chars)`);
    } catch (err) {
      logger.warn(`ContextUpdater: failed to write knowledge/${op.slug}.md for ${talkId}: ${err}`);
    }
  }
}
