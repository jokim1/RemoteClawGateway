/**
 * System Prompt Composition
 *
 * Builds the system prompt for a Talk from its metadata, context document,
 * pinned messages, and active jobs. Sections are omitted when empty.
 */

import type { TalkMeta, TalkMessage, TalkJob } from './types.js';

export interface SystemPromptInput {
  meta: TalkMeta;
  contextMd: string;
  pinnedMessages: TalkMessage[];
}

export function composeSystemPrompt(input: SystemPromptInput): string | undefined {
  const { meta, contextMd, pinnedMessages } = input;

  const sections: string[] = [];

  // Base instruction
  sections.push('You are a focused assistant in an ongoing conversation.');

  // Objective
  if (meta.objective) {
    sections.push(
      `## Objective\n${meta.objective}\n\n` +
      'Your responses should serve this objective. If the conversation drifts, gently ' +
      'steer it back. Track progress and flag when milestones are reached.',
    );
  }

  // Conversation context
  if (contextMd.trim()) {
    sections.push(
      `## Conversation Context\nThe following is a running summary of this conversation so far:\n\n${contextMd.trim()}`,
    );
  }

  // Pinned references
  if (pinnedMessages.length > 0) {
    const pinLines = pinnedMessages.map(m => {
      const preview = m.content.length > 200
        ? m.content.slice(0, 200) + '...'
        : m.content;
      const ts = new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      return `- ${m.role} (${ts}): ${preview}`;
    });
    sections.push(
      `## Pinned References\nThe user has pinned these as important:\n${pinLines.join('\n')}`,
    );
  }

  // Active jobs
  const activeJobs = meta.jobs.filter(j => j.active);
  if (activeJobs.length > 0) {
    const jobLines = activeJobs.map(j => `- [${j.schedule}] ${j.prompt}`);
    sections.push(
      `## Active Jobs\nBackground tasks monitoring this conversation:\n${jobLines.join('\n')}`,
    );
  }

  // If there's nothing beyond the base instruction, no system prompt needed
  if (sections.length === 1 && !meta.objective && !contextMd.trim() && pinnedMessages.length === 0 && activeJobs.length === 0) {
    return undefined;
  }

  return sections.join('\n\n');
}
