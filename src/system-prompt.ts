/**
 * System Prompt Composition
 *
 * Builds the system prompt for a Talk from its metadata, context document,
 * pinned messages, and active jobs. Sections are omitted when empty.
 */

import type { TalkMeta, TalkMessage, TalkJob } from './types.js';
import type { ToolInfo, ToolRegistry } from './tool-registry.js';

/** Maximum pinned messages included in the prompt. */
const MAX_PINNED_IN_PROMPT = 10;

/** Maximum tools listed in the prompt. */
const MAX_TOOLS_IN_PROMPT = 20;

/** Maximum characters per job prompt display. */
const MAX_JOB_PROMPT_CHARS = 200;

/** Maximum total prompt size in bytes. */
const MAX_PROMPT_BYTES = 48 * 1024;

export interface SystemPromptInput {
  meta: TalkMeta;
  contextMd: string;
  pinnedMessages: TalkMessage[];
  knowledgeTopics?: Array<{ slug: string; content: string }>;
  activeModel?: string;
  agentOverride?: {
    name: string;
    role: string;
    roleInstructions: string;
    otherAgents: { name: string; role: string; model: string }[];
  };
  registry?: ToolRegistry;
  toolManifest?: ToolInfo[];
  toolMode?: 'off' | 'confirm' | 'auto';
}

function totalPromptBytes(sections: string[]): number {
  if (sections.length === 0) return 0;
  return Buffer.byteLength(sections.join('\n\n'), 'utf-8');
}

export function composeSystemPrompt(input: SystemPromptInput): string | undefined {
  const { meta, contextMd, pinnedMessages, knowledgeTopics, activeModel, agentOverride, registry, toolManifest, toolMode } = input;
  const stateBackend = meta.stateBackend ?? 'stream_store';
  const defaultStateStream = meta.defaultStateStream ?? 'default';

  // Priority-ordered sections: identity > objective > context > pinned > jobs > tools
  // Each section is built and then assembled, truncating lower-priority sections if needed.

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

  // Execution environment — tool-aware capability awareness
  if (registry) {
    const tools = toolManifest ?? registry.listTools();
    if (tools.length > 0) {
      // Cap tool listing at MAX_TOOLS_IN_PROMPT
      const displayTools = tools.slice(0, MAX_TOOLS_IN_PROMPT);
      const toolLines = displayTools.map(t => `- **${t.name}**: ${t.description.slice(0, 120)}`);
      const overflow = tools.length > MAX_TOOLS_IN_PROMPT
        ? `\n- ... and ${tools.length - MAX_TOOLS_IN_PROMPT} more tools`
        : '';
      sections.push(
        '## Execution Environment\n' +
        'Your response is displayed in a terminal chat interface (ClawTalk). ' +
        'You have **tools available** via function calling for this turn.\n\n' +
        `Tool execution mode for this Talk: **${toolMode ?? 'auto'}**.\n\n` +
        '### Available Tools\n' +
        toolLines.join('\n') + overflow + '\n\n' +
        '### Tool Usage Guidelines\n' +
        '- Use tools only when the user asks for external actions or verification (file ops, web requests, installs, code execution).\n' +
        '- **Do not use tools** for simple conversational/meta questions (e.g., "what model are you?", greetings, clarifications).\n' +
        '- If a tool call fails, tell the user what happened and suggest alternatives.\n' +
        '- For multi-step tasks, chain tool calls as needed — you can call tools multiple times in sequence.\n' +
        '- For Google Docs URLs (`docs.google.com/document/...`), use `google_docs_read` instead of `web_fetch_extract`.\n' +
        '- For Google Docs/Drive actions, use gateway tools (`google_docs_*`, `google_drive_files`) via function calls.\n' +
        '- Do not use or mention `gog` CLI, local skills, or external auth flows for Google actions in this Talk.\n' +
        '- If Google tools are unavailable or blocked, say that explicitly and mention Execution Mode / OAuth readiness as the likely cause.\n' +
        '- For `read`, always provide a concrete `file_path` argument. Never call `read` with empty or missing path.\n' +
        '- For `edit`/`apply_patch`, include all required fields and validate target paths before calling.\n' +
        `- Talk state backend: \`${stateBackend}\`. ` +
        (stateBackend === 'stream_store'
          ? `Prefer state tools (\`state_append_event\`, \`state_read_summary\`) and default stream \`${defaultStateStream}\`. Do not assume memory markdown files exist.\n`
          : 'Use workspace files for persistence and do not call state_* stream tools unless the user switches backend.\n') +
        '- `shell_exec` runs commands in a bash shell on the server. Use it for file creation, curl, package installs, etc.\n' +
        '- `manage_tools` lets you register new custom tools to expand your capabilities.\n' +
        '- Always report tool results clearly. Show relevant output, not just "done".\n' +
        '- For long-running commands, consider using appropriate timeouts.\n\n' +
        '**CRITICAL: Never promise an action you cannot verify completing.** ' +
        'Use your tools to actually perform the action, then report the result.',
      );
    } else {
      sections.push(
        '## Execution Environment\n' +
        'Your response is displayed in a terminal chat interface (ClawTalk). ' +
        'No tools are currently available. You can only output text.\n\n' +
        '- If asked to perform actions, explain that you have no tools and suggest alternatives.\n' +
        '- You may schedule a ```job block only when the user explicitly asks for recurring/scheduled/follow-up work (see Talk Automations section below).',
      );
    }
  } else {
    const manifest = (toolManifest ?? []).slice(0, MAX_TOOLS_IN_PROMPT);
    const manifestLines = manifest.map(t => `- **${t.name}**: ${t.description.slice(0, 120)}`);
    const manifestOverflow = (toolManifest?.length ?? 0) > MAX_TOOLS_IN_PROMPT
      ? `\n- ... and ${(toolManifest?.length ?? 0) - MAX_TOOLS_IN_PROMPT} more tools`
      : '';
    sections.push(
      '## Execution Environment\n' +
      'Your response is displayed in a terminal chat interface (ClawTalk). ' +
      'Tool execution is currently disabled for this turn.\n\n' +
      `Tool execution mode for this Talk: **${toolMode ?? 'auto'}**.\n\n` +
      (
        manifest.length > 0
          ? '### Installed Tools (for awareness)\n' + manifestLines.join('\n') + manifestOverflow + '\n\n'
          : ''
      ) +
      '**If you have tools available:** Use them. If a tool call fails, tell the user what happened and suggest alternatives.\n\n' +
      `Talk state backend: \`${stateBackend}\`. ` +
      (stateBackend === 'stream_store'
        ? `Prefer state tools with stream \`${defaultStateStream}\`; do not assume memory markdown files exist.\n\n`
        : 'Persist tracking data in workspace files unless the user switches backend.\n\n') +
      '**If you do NOT have tools available:** You can only output text in this response. Be upfront about this:\n' +
      '- If asked to create a document or report, write the full content directly in your response.\n' +
      '- If asked to do something that requires tools you don\'t have (file upload, web search, API calls, code execution), ' +
      'say so IMMEDIATELY. Do not pretend you can do it. Do not say "let me try" and then produce nothing.\n' +
      '- You may schedule a ```job block only when the user explicitly asks for recurring/scheduled/follow-up work (see Talk Automations section below).\n\n' +
      '**CRITICAL: Never promise an action you cannot verify completing.** ' +
      'If you say "Let me create that file" or "I\'ll upload this now," you MUST actually produce output in this response. ' +
      'If you cannot, say so honestly on the first attempt — do not stall across multiple turns.',
    );
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
    'NEVER use markdown tables (pipes/dashes), HTML tables, or box-drawing Unicode table characters. ' +
    'When presenting tabular data, use a fenced code block with manually aligned plain-text columns, or ' +
    'use plain spaced columns without pipes. For example:\n' +
    '```\n' +
    'Name            Score   Result\n' +
    'Alice             95   Passed\n' +
    'Bob               82   Passed\n' +
    '```\n' +
    'If you drafted a markdown or HTML table, rewrite it into the format above before sending.\n\n' +
    '## Honesty\n' +
    'Do not speculate about or fabricate system internals, configuration entries, ' +
    'session identifiers, or infrastructure details you do not actually have access to. ' +
      'If you do not know how something works internally, say so rather than guessing.',
  );

  if (activeModel?.trim()) {
    sections.push(
      `## Model Configuration\n` +
      `Current request model: \`${activeModel.trim()}\`\n\n` +
      `If asked what model you are, answer using this configured model string. ` +
      `Do not infer identity from prior conversation text, prior summaries, or memory.`,
    );
  }

  // Objectives
  if (meta.objective) {
    sections.push(
      `## Objectives\n${meta.objective}\n\n` +
      'Your responses should serve this objective. If the conversation drifts, gently ' +
      'steer it back. Track progress and flag when milestones are reached.',
    );
  }

  // Rules
  const activeDirectives = (meta.directives ?? []).filter(d => d.active);
  if (activeDirectives.length > 0) {
    const directiveLines = activeDirectives.map((d, i) => `${i + 1}. ${d.text}`);
    sections.push(
      '## Rules\n' +
      'Follow each directive as written. These are standing rules for this conversation.\n\n' +
      directiveLines.join('\n'),
    );
  }

  // Channel Connections
  const bindings = meta.platformBindings ?? [];
  if (bindings.length > 0) {
    const bindingLines = bindings.map(b => `- **${b.platform}** ${b.scope} (${b.permission})`);
    sections.push(
      '## Channel Connections\n' +
      'You have access to the following platforms. Use them as needed to fulfill rules and objectives.\n\n' +
      bindingLines.join('\n'),
    );
  }

  // Conversation context
  if (contextMd.trim()) {
    sections.push(
      `## Conversation Context\nThe following is a running summary of this conversation so far:\n\n${contextMd.trim()}`,
    );
  }

  // Knowledge topics (durable facts matched to this message)
  if (knowledgeTopics && knowledgeTopics.length > 0) {
    const topicSections = knowledgeTopics.map(
      t => `### ${t.slug}\n${t.content.trim()}`,
    );
    sections.push(
      '## Knowledge\n' +
      'The following are durable facts about topics relevant to this message. ' +
      'These persist across conversations and should be treated as established context.\n\n' +
      topicSections.join('\n\n'),
    );
  }

  // Pinned references (capped at MAX_PINNED_IN_PROMPT)
  if (pinnedMessages.length > 0) {
    const capped = pinnedMessages.slice(0, MAX_PINNED_IN_PROMPT);
    const pinLines = capped.map(m => {
      const preview = m.content.length > 200
        ? m.content.slice(0, 200) + '...'
        : m.content;
      const ts = new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      return `- ${m.role} (${ts}): ${preview}`;
    });
    const overflow = pinnedMessages.length > MAX_PINNED_IN_PROMPT
      ? `\n- ... and ${pinnedMessages.length - MAX_PINNED_IN_PROMPT} more pinned messages`
      : '';
    sections.push(
      `## Pinned References\nThe user has pinned these as important:\n${pinLines.join('\n')}${overflow}`,
    );
  }

  // Active automations (cap prompt display at MAX_JOB_PROMPT_CHARS each)
  const activeJobs = meta.jobs.filter(j => j.active);
  if (activeJobs.length > 0) {
    const scheduledJobs = activeJobs.filter(j => j.type !== 'event');
    const eventJobs = activeJobs.filter(j => j.type === 'event');
    const lines: string[] = [];

    if (scheduledJobs.length > 0) {
      lines.push('**Scheduled:**');
      for (const j of scheduledJobs) {
        const promptPreview = j.prompt.length > MAX_JOB_PROMPT_CHARS
          ? j.prompt.slice(0, MAX_JOB_PROMPT_CHARS) + '...'
          : j.prompt;
        lines.push(`- [${j.schedule}] ${promptPreview}`);
      }
    }

    if (eventJobs.length > 0) {
      lines.push('**Event-driven:**');
      for (const j of eventJobs) {
        const promptPreview = j.prompt.length > MAX_JOB_PROMPT_CHARS
          ? j.prompt.slice(0, MAX_JOB_PROMPT_CHARS) + '...'
          : j.prompt;
        lines.push(`- [${j.schedule}] ${promptPreview}`);
      }
    }

    sections.push(
      `## Active Automations\nBackground tasks monitoring this conversation:\n${lines.join('\n')}`,
    );
  }

  // Talk automations explanation + creation instructions (always included)
  sections.push(
    `## Talk Automations\n` +
    `This Talk has a **built-in automation scheduler**. Automations are recurring tasks that belong to ` +
    `this Talk and run server-side on a schedule. Each automation execution has full access to ` +
    `this Talk's context (objective, pinned messages, conversation summary). ` +
    `Automations produce reports that the user can review.\n\n` +
    `**This is NOT the system cron.** Talk automations are a feature of ClawTalk — they are ` +
    `scoped to this Talk, managed in the Talk interface, and run automatically by the gateway.\n\n` +
    `### Managing Automations\n` +
    `The user can create, pause, resume, and remove automations from the Talk controls.\n\n` +
    `### Creating Automations via Response\n` +
    `You can also create an automation by outputting a fenced job block in your response:\n\n` +
    '```job\n' +
    `schedule: <cron or human-readable schedule>\n` +
    `prompt: <self-contained instruction for each run>\n` +
    '```\n\n' +
    `Schedule formats:\n` +
    '- Event: `on <scope>` — triggers when a message arrives matching a `/platform` binding (e.g. `on #kids-study-log`)\n' +
    '- One-off: `in 1h`, `in 30m`, `at 3pm`, `at 14:00` (runs once, then deactivates)\n' +
    '- Interval: `every 2h`, `every 30m` (recurring)\n' +
    '- Daily: `daily 8am`, `daily 14:00` (recurring)\n' +
    '- Cron: `0 8 * * *` (daily 8 AM), `0 9 * * 1` (Monday 9 AM), `30 17 * * 1-5` (weekdays 5:30 PM)\n\n' +
    `Event-driven jobs fire whenever a message arrives from the specified platform scope. ` +
    `The scope must match an existing Channel Connection. The message content and sender ` +
    `are injected into the job context automatically.\n\n` +
    `One-off automations run once at the specified time, then auto-deactivate. ` +
    `When you promise to follow up later (e.g. "I'll research this and have it for you in an hour"), ` +
    `create a one-off automation to ensure you deliver.\n\n` +
    `The prompt must be self-contained — it runs independently with only the Talk context. ` +
    `Create automations when the user asks for something recurring, scheduled, or when you commit to a follow-up.\n` +
    `If you create an automation, explicitly tell the user a job was created and include the schedule.\n` +
    `If intent is ambiguous ("follow up later" without timing), ask one confirmation question before creating a job.\n` +
    `Do NOT create automations for immediate one-turn requests that should be executed now with available tools.\n\n` +
    `### Moving External Tasks to Talk Automations\n` +
    `If the user asks to move an external cron job, scheduled task, or recurring reminder ` +
    `into this Talk, create a Talk automation for it. Talk automations are the preferred way to handle ` +
    `recurring work within a Talk's scope.`,
  );

  // Drop lower-priority optional sections first so Objectives/Rules remain intact.
  const workingSections = [...sections];
  const optionalDropOrder = [
    '## Talk Automations',
    '## Active Automations',
    '## Knowledge',
    '## Pinned References',
    '## Conversation Context',
    '## Channel Connections',
    '## Execution Environment',
    '## Your Identity',
  ];

  for (const heading of optionalDropOrder) {
    while (totalPromptBytes(workingSections) > MAX_PROMPT_BYTES) {
      const idx = workingSections.findIndex(section => section.startsWith(heading));
      if (idx === -1) break;
      workingSections.splice(idx, 1);
    }
  }

  let result = workingSections.join('\n\n');

  // Truncate at MAX_PROMPT_BYTES to prevent excessive prompt sizes
  if (Buffer.byteLength(result, 'utf-8') > MAX_PROMPT_BYTES) {
    // Truncate from the end (lower-priority sections: jobs, tools are at bottom)
    const encoder = new TextEncoder();
    const encoded = encoder.encode(result);
    const truncated = encoded.slice(0, MAX_PROMPT_BYTES);
    result = new TextDecoder().decode(truncated);
    // Ensure we end at a clean line boundary
    const lastNewline = result.lastIndexOf('\n');
    if (lastNewline > MAX_PROMPT_BYTES * 0.9) {
      result = result.slice(0, lastNewline);
    }
    result += '\n\n[System prompt truncated due to size]';
  }

  return result;
}
