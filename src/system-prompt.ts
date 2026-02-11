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
  agentOverride?: {
    name: string;
    role: string;
    roleInstructions: string;
    otherAgents: { name: string; role: string; model: string }[];
  };
}

export function composeSystemPrompt(input: SystemPromptInput): string | undefined {
  const { meta, contextMd, pinnedMessages, agentOverride } = input;

  const sections: string[] = [];

  // Agent identity (prepended before base instruction when present)
  if (agentOverride) {
    let identitySection = `## Your Identity\nYou are **${agentOverride.name}**, acting as the **${agentOverride.role}** in this conversation.\n\n${agentOverride.roleInstructions}`;
    if (agentOverride.otherAgents.length > 0) {
      const agentLines = agentOverride.otherAgents.map(
        a => `- **${a.name}** (${a.role}) — using ${a.model}`,
      );
      identitySection += `\n\n### Other Agents in This Conversation\n${agentLines.join('\n')}`;
    }
    identitySection += '\n\n---';
    sections.push(identitySection);
  }

  // Base instruction
  sections.push(
    'You are a focused assistant in an ongoing conversation.\n\n' +
    '## Context Saving\n' +
    'This conversation is a **Talk** — a scoped, self-contained context. ' +
    'When the user asks to save or remember context, default to saving it ' +
    'within this Talk (e.g. pinned messages, conversation context, or objective) ' +
    'rather than writing to external or general-purpose context files. ' +
    'Talks are designed to keep context confined and focused. ' +
    'Only save to broader/external context if the user explicitly asks for it.\n\n' +
    '## Formatting\n' +
    'This conversation is displayed in a terminal. ' +
    'NEVER use markdown tables (pipes/dashes) or HTML tables — they render poorly in terminals. ' +
    'When presenting tabular data, use a fenced code block with manually aligned columns, or ' +
    'use plain spaced columns without pipes. For example:\n' +
    '```\n' +
    'Name            Score   Result\n' +
    'Alice             95   Passed\n' +
    'Bob               82   Passed\n' +
    '```\n\n' +
    '## Honesty\n' +
    'Do not speculate about or fabricate system internals, configuration entries, ' +
    'session identifiers, or infrastructure details you do not actually have access to. ' +
    'If you do not know how something works internally, say so rather than guessing.',
  );

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

  // Talk jobs explanation + creation instructions (always included)
  sections.push(
    `## Talk Jobs\n` +
    `This Talk has a **built-in job scheduler**. Jobs are recurring tasks that belong to ` +
    `this Talk and run server-side on a schedule. Each job execution has full access to ` +
    `this Talk's context (objective, pinned messages, conversation summary). ` +
    `Jobs produce reports that the user can review.\n\n` +
    `**This is NOT the system cron.** Talk jobs are a feature of ClawTalk — they are ` +
    `scoped to this Talk, managed via slash commands, and run automatically by the gateway.\n\n` +
    `### Managing Jobs\n` +
    `The user manages jobs with these slash commands:\n` +
    '- `/job add "schedule" prompt` — create a new job\n' +
    '- `/jobs` — list all jobs in this Talk\n' +
    '- `/job pause N` — pause job #N\n' +
    '- `/job resume N` — resume job #N\n' +
    '- `/job delete N` — delete job #N\n' +
    '- `/reports` — view job execution reports\n\n' +
    `### Creating Jobs via Response\n` +
    `You can also create a job by outputting a fenced job block in your response:\n\n` +
    '```job\n' +
    `schedule: <cron or human-readable schedule>\n` +
    `prompt: <self-contained instruction for each run>\n` +
    '```\n\n' +
    `Schedule formats:\n` +
    '- One-off: `in 1h`, `in 30m`, `at 3pm`, `at 14:00` (runs once, then deactivates)\n' +
    '- Interval: `every 2h`, `every 30m` (recurring)\n' +
    '- Daily: `daily 8am`, `daily 14:00` (recurring)\n' +
    '- Cron: `0 8 * * *` (daily 8 AM), `0 9 * * 1` (Monday 9 AM), `30 17 * * 1-5` (weekdays 5:30 PM)\n\n' +
    `One-off jobs run once at the specified time, then auto-deactivate. ` +
    `When you promise to follow up later (e.g. "I'll research this and have it for you in an hour"), ` +
    `create a one-off job to ensure you deliver.\n\n` +
    `The prompt must be self-contained — it runs independently with only the Talk context. ` +
    `Create jobs when the user asks for something recurring, scheduled, or when you commit to a follow-up.\n\n` +
    `### Moving External Tasks to Talk Jobs\n` +
    `If the user asks to move an external cron job, scheduled task, or recurring reminder ` +
    `into this Talk, create a Talk job for it. Talk jobs are the preferred way to handle ` +
    `recurring work within a Talk's scope.`,
  );

  return sections.join('\n\n');
}
