import type { Logger, PluginApi } from './types.js';
import type { ToolExecutor, ToolExecResult } from './tool-executor.js';

type AgentToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
};

const OPENCLAW_NATIVE_GOOGLE_TOOL_NAMES = new Set<string>([
  'google_docs_create',
  'google_docs_append',
  'google_docs_read',
  'google_docs_auth_status',
  'google_docs_list_tabs',
  'google_docs_add_tab',
  'google_docs_update_tab',
  'google_docs_delete_tab',
  'google_drive_files',
]);

export function resolveOpenClawNativeGoogleToolsEnabled(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return true;
  const value = raw.trim().toLowerCase();
  if (!value) return true;
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off');
}

export function isOpenClawNativeGoogleTool(toolName: string): boolean {
  return OPENCLAW_NATIVE_GOOGLE_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

function toAgentToolResult(result: ToolExecResult): AgentToolResult {
  return {
    content: [{ type: 'text', text: result.content }],
    details: {
      success: result.success,
      durationMs: result.durationMs,
    },
  };
}

function createNativeTool(params: {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  executor: ToolExecutor;
  logger: Logger;
}): Record<string, unknown> {
  const { name, description, schema, executor, logger } = params;
  return {
    name,
    label: name,
    description,
    parameters: schema,
    execute: async (_toolCallId: string, args: Record<string, unknown>): Promise<AgentToolResult> => {
      const result = await executor.execute(name, JSON.stringify(args ?? {}));
      logger.info(`ClawTalk: native tool ${name} -> ${result.success ? 'ok' : 'error'}`);
      return toAgentToolResult(result);
    },
  };
}

const GOOGLE_NATIVE_TOOLS: Array<{ name: string; description: string; schema: Record<string, unknown> }> = [
  {
    name: 'google_docs_create',
    description: 'Create a Google Doc with optional initial content.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        folder_id: { type: 'string' },
        profile: { type: 'string' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'google_docs_append',
    description: 'Append text to a Google Doc.',
    schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        text: { type: 'string' },
        tab_id: { type: 'string' },
        profile: { type: 'string' },
      },
      required: ['doc_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'google_docs_read',
    description: 'Read text from a Google Doc.',
    schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        max_chars: { type: 'number' },
        profile: { type: 'string' },
      },
      required: ['doc_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'google_docs_auth_status',
    description: 'Check Google Docs OAuth readiness.',
    schema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'google_docs_list_tabs',
    description: 'List tabs in a Google Doc.',
    schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        profile: { type: 'string' },
      },
      required: ['doc_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'google_docs_add_tab',
    description: 'Create a tab in a Google Doc.',
    schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        title: { type: 'string' },
        index: { type: 'number' },
        parent_tab_id: { type: 'string' },
        profile: { type: 'string' },
      },
      required: ['doc_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'google_docs_update_tab',
    description: 'Update a tab in a Google Doc.',
    schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        tab_id: { type: 'string' },
        title: { type: 'string' },
        index: { type: 'number' },
        parent_tab_id: { type: 'string' },
        profile: { type: 'string' },
      },
      required: ['doc_id', 'tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'google_docs_delete_tab',
    description: 'Delete a tab from a Google Doc.',
    schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        tab_id: { type: 'string' },
        profile: { type: 'string' },
      },
      required: ['doc_id', 'tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'google_drive_files',
    description: 'List/search/move Google Drive files.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'move'] },
        folder_id: { type: 'string' },
        page_size: { type: 'number' },
        query: { type: 'string' },
        parent_id: { type: 'string' },
        file_id: { type: 'string' },
        target_folder_id: { type: 'string' },
        profile: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

export function registerOpenClawNativeGoogleTools(params: {
  api: PluginApi;
  executor: ToolExecutor;
  logger: Logger;
}): void {
  const enabled = resolveOpenClawNativeGoogleToolsEnabled(
    process.env.CLAWTALK_OPENCLAW_NATIVE_GOOGLE_TOOLS_ENABLED,
  );
  if (!enabled) {
    params.logger.info('ClawTalk: native OpenClaw Google tools disabled by CLAWTALK_OPENCLAW_NATIVE_GOOGLE_TOOLS_ENABLED.');
    return;
  }

  if (typeof params.api.registerTool !== 'function') {
    params.logger.warn('ClawTalk: runtime API does not expose registerTool; native Google tool bridge unavailable.');
    return;
  }

  for (const tool of GOOGLE_NATIVE_TOOLS) {
    params.api.registerTool(createNativeTool({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      executor: params.executor,
      logger: params.logger,
    }));
  }
  params.logger.info(`ClawTalk: registered ${GOOGLE_NATIVE_TOOLS.length} native OpenClaw Google tools.`);
}

