import type { TalkMeta } from './types.js';
import type { ToolInfo } from './tool-registry.js';

export type ExecutionMode = 'openclaw' | 'full_control';
export type ExecutionModeLabel = 'openclaw_agent' | 'clawtalk_proxy';
export type FilesystemAccess = 'workspace_sandbox' | 'full_host_access';
export type NetworkAccess = 'restricted' | 'full_outbound';

export interface ExecutionModeOption {
  value: ExecutionMode;
  label: ExecutionModeLabel;
  title: string;
  description: string;
}

export const EXECUTION_MODE_OPTIONS: ExecutionModeOption[] = [
  {
    value: 'openclaw',
    label: 'openclaw_agent',
    title: 'OpenClaw Agent',
    description: 'OpenClaw agent runtime, tools, and session behavior.',
  },
  {
    value: 'full_control',
    label: 'clawtalk_proxy',
    title: 'ClawTalk Proxy',
    description: 'Sends prompts directly with minimal OpenClaw runtime mediation.',
  },
];

const HOST_FILESYSTEM_TOOLS = new Set([
  'shell_exec',
  'exec',
  'manage_tools',
]);

const NETWORK_TOOLS = new Set([
  'shell_exec',
  'web_fetch_extract',
  'google_docs_create',
  'google_docs_append',
  'google_docs_read',
  'google_docs_auth_status',
  'google_docs_list_tabs',
  'google_docs_add_tab',
  'google_docs_update_tab',
  'google_docs_delete_tab',
  'google_drive_files',
  'pdf_extract_text',
]);

const BROWSER_TOOL_NAME_RE = /(browser|chrome|tab|playwright|puppeteer|relay|snapshot|navigate)/i;
const BROWSER_INTENT_RE =
  /\b(browser|tab|chrome|take over|control (my )?browser|attach(ed)? tab|openclaw browser relay)\b/i;

export function normalizeExecutionModeInput(raw: unknown): ExecutionMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'openclaw') return 'openclaw';
  if (value === 'full_control') return 'full_control';
  if (value === 'openclaw_agent') return 'openclaw';
  if (value === 'clawtalk_proxy' || value === 'raw_proxy') return 'full_control';
  if (value === 'unsandboxed') return 'full_control';
  if (value === 'inherit' || value === 'sandboxed') return 'openclaw';
  return undefined;
}

export function normalizeFilesystemAccessInput(raw: unknown): FilesystemAccess | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'workspace_sandbox' || value === 'workspace' || value === 'sandbox') {
    return 'workspace_sandbox';
  }
  if (value === 'full_host_access' || value === 'full_host' || value === 'full') {
    return 'full_host_access';
  }
  return undefined;
}

export function normalizeNetworkAccessInput(raw: unknown): NetworkAccess | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'restricted') return 'restricted';
  if (value === 'full_outbound' || value === 'full') return 'full_outbound';
  return undefined;
}

export function resolveExecutionMode(talk: Pick<TalkMeta, 'executionMode'>): ExecutionMode {
  return talk.executionMode === 'full_control' ? 'full_control' : 'openclaw';
}

export function resolveFilesystemAccess(talk: Pick<TalkMeta, 'filesystemAccess'>): FilesystemAccess {
  return talk.filesystemAccess === 'workspace_sandbox' ? 'workspace_sandbox' : 'full_host_access';
}

export function resolveNetworkAccess(talk: Pick<TalkMeta, 'networkAccess'>): NetworkAccess {
  return talk.networkAccess === 'restricted' ? 'restricted' : 'full_outbound';
}

export function executionModeLabel(mode: ExecutionMode): ExecutionModeLabel {
  return mode === 'full_control' ? 'clawtalk_proxy' : 'openclaw_agent';
}

export function isBrowserIntent(message: string): boolean {
  return BROWSER_INTENT_RE.test(message);
}

export function isBrowserTool(toolName: string): boolean {
  return BROWSER_TOOL_NAME_RE.test(toolName);
}

export type ToolBlockedReasonCode =
  | 'blocked_not_installed'
  | 'blocked_allowlist'
  | 'blocked_denylist'
  | 'blocked_execution_mode'
  | 'blocked_filesystem'
  | 'blocked_network'
  | 'blocked_tool_mode';

export interface ToolAvailabilityState extends ToolInfo {
  enabled: boolean;
  reasonCode?: ToolBlockedReasonCode;
  reason?: string;
}

function deriveToolBlockedReason(
  toolName: string,
  executionMode: ExecutionMode,
  filesystemAccess: FilesystemAccess,
  networkAccess: NetworkAccess,
  toolMode: 'off' | 'confirm' | 'auto',
  allowSet: Set<string>,
  denySet: Set<string>,
  isInstalled?: (toolName: string) => boolean,
): { code: ToolBlockedReasonCode; reason: string } | null {
  const key = toolName.toLowerCase();
  if (isInstalled && !isInstalled(key)) {
    return {
      code: 'blocked_not_installed',
      reason: 'Not installed in Tool Catalog.',
    };
  }
  if (denySet.has(key)) {
    return { code: 'blocked_denylist', reason: 'Blocked by Talk deny-list.' };
  }
  if (allowSet.size > 0 && !allowSet.has(key)) {
    return { code: 'blocked_allowlist', reason: 'Not included in Talk allow-list.' };
  }
  if (executionMode === 'full_control' && isBrowserTool(key)) {
    return {
      code: 'blocked_execution_mode',
      reason: 'Browser control requires Execution Mode: OpenClaw Agent.',
    };
  }
  if (filesystemAccess === 'workspace_sandbox' && HOST_FILESYSTEM_TOOLS.has(key)) {
    return {
      code: 'blocked_filesystem',
      reason: 'Blocked by Filesystem Access: Workspace Sandbox.',
    };
  }
  if (networkAccess === 'restricted' && NETWORK_TOOLS.has(key)) {
    return {
      code: 'blocked_network',
      reason: 'Blocked by Network Access: Restricted.',
    };
  }
  if (toolMode === 'off') {
    return {
      code: 'blocked_tool_mode',
      reason: 'Blocked by Tool Approval: Off.',
    };
  }
  return null;
}

export function evaluateToolAvailability(
  allTools: ToolInfo[],
  talk: Pick<TalkMeta, 'executionMode' | 'filesystemAccess' | 'networkAccess' | 'toolsAllow' | 'toolsDeny' | 'toolMode'>,
  options?: {
    isInstalled?: (toolName: string) => boolean;
  },
): ToolAvailabilityState[] {
  const executionMode = resolveExecutionMode(talk);
  const filesystemAccess = resolveFilesystemAccess(talk);
  const networkAccess = resolveNetworkAccess(talk);
  const toolMode = talk.toolMode === 'off' || talk.toolMode === 'confirm' || talk.toolMode === 'auto'
    ? talk.toolMode
    : 'auto';
  const allowSet = new Set((talk.toolsAllow ?? []).map((name) => name.toLowerCase()));
  const denySet = new Set((talk.toolsDeny ?? []).map((name) => name.toLowerCase()));

  return allTools.map((tool) => {
    const blocked = deriveToolBlockedReason(
      tool.name,
      executionMode,
      filesystemAccess,
      networkAccess,
      toolMode,
      allowSet,
      denySet,
      options?.isInstalled,
    );
    if (!blocked) return { ...tool, enabled: true };
    return {
      ...tool,
      enabled: false,
      reasonCode: blocked.code,
      reason: blocked.reason,
    };
  });
}

export function filterEnabledToolsByPolicy(
  tools: ToolInfo[],
  talk: Pick<TalkMeta, 'executionMode' | 'filesystemAccess' | 'networkAccess' | 'toolsAllow' | 'toolsDeny'>,
): ToolInfo[] {
  return evaluateToolAvailability(tools, talk)
    .filter((tool) => tool.enabled)
    .map(({ name, description, builtin }) => ({ name, description, builtin }));
}
