/**
 * Type definitions for ClawTalk Gateway Plugin
 *
 * Matches the real openclaw plugin API.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
}

export interface PluginCommandContext {
  args: string[];
  rawArgs: string;
  reply: (text: string) => void;
}

export interface PluginCommandDefinition {
  name: string;
  description: string;
  usage?: string;
  handler: (ctx: PluginCommandContext) => void | Promise<void>;
}

export interface PluginServiceContext {
  logger: Logger;
}

export interface PluginService {
  id: string;
  start: (ctx: PluginServiceContext) => void | Promise<void>;
  stop: (ctx: PluginServiceContext) => void | Promise<void>;
}

export interface PluginApi {
  id: string;
  config: Record<string, any>;
  pluginConfig: Record<string, any> | undefined;
  runtime: {
    config: {
      loadConfig: () => Record<string, any>;
    };
    state?: {
      resolveStateDir: () => string;
    };
  };
  logger: Logger;
  registerHttpHandler: (
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  ) => void;
  registerTool?: (tool: Record<string, unknown>, opts?: Record<string, unknown>) => void;
  registerCommand: (cmd: PluginCommandDefinition) => void;
  registerService: (svc: PluginService) => void;
  on: (hookName: string, handler: (...args: any[]) => unknown | Promise<unknown>) => void;
}

export interface HandlerContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  cfg: Record<string, any>;
  pluginCfg: ClawTalkPluginConfig;
  logger: Logger;
}

export interface ProviderBillingConfig {
  billing?: 'api' | 'subscription';
  plan?: string;
  monthlyPrice?: number;
}

export interface VoicePluginConfig {
  stt?: {
    provider?: string;
    model?: string;
  };
  tts?: {
    provider?: string;
    model?: string;
    defaultVoice?: string;
  };
}

export interface RealtimeVoicePluginConfig {
  defaultProvider?: 'openai' | 'cartesia' | 'elevenlabs' | 'deepgram' | 'gemini';
  openai?: {
    model?: string;
    voice?: string;
  };
  cartesia?: {
    model?: string;
    voice?: string;
  };
}

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetAt?: number;
}

export interface ProviderUsageSnapshot {
  provider: string;
  displayName?: string;
  windows: UsageWindow[];
  error?: string;
}

export interface UsageSummary {
  updatedAt: number;
  providers: ProviderUsageSnapshot[];
}

export interface RateLimitWindow {
  utilization: number; // 0–1 fraction
  resetsAt: number;    // Unix timestamp (seconds)
  status: string;      // "allowed" | "rate_limited"
}

export interface CachedRateLimitData {
  provider: string;
  status?: string;               // overall unified status
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// Talk types
// ---------------------------------------------------------------------------

export type AgentRole = 'analyst' | 'critic' | 'strategist' | 'devils-advocate' | 'synthesizer' | 'editor';

export interface TalkAgent {
  name: string;
  model: string;
  role: AgentRole;
  isPrimary: boolean;
  /** Optional OpenClaw agent ID for explicit gateway routing. */
  openClawAgentId?: string;
}

export interface TalkDirective {
  id: string;
  text: string;
  active: boolean;
  createdAt: number;
}

export type Directive = TalkDirective;

export type PlatformPermission = 'read' | 'write' | 'read+write';

export interface TalkPlatformBinding {
  id: string;
  platform: string;    // e.g. "slack", "posthog", "monday"
  scope: string;       // e.g. "#team-product", "analytics", "all boards"
  /** Optional Slack account/workspace identifier from OpenClaw config. */
  accountId?: string;
  /** Optional human-friendly scope label (for example "#general"). */
  displayScope?: string;
  permission: PlatformPermission;
  createdAt: number;
}

export type PlatformBinding = TalkPlatformBinding;

export interface TalkPlatformBehavior {
  id: string;
  /** Foreign key to TalkPlatformBinding.id. */
  platformBindingId: string;
  /**
   * Inbound response mode for this binding.
   * - off: never auto-respond
   * - mentions: respond when bot is explicitly mentioned
   * - all: respond to all inbound messages on this binding
   */
  responseMode?: 'off' | 'mentions' | 'all';
  /** Backward compatibility with older clients. Prefer responseMode. */
  autoRespond?: boolean;
  /** Optional talk agent name override for this binding. */
  agentName?: string;
  /**
   * Optional instruction for inbound messages on this binding.
   * If omitted, auto-response is disabled for this binding.
   */
  onMessagePrompt?: string;
  /**
   * Controls whether Slack messages are mirrored into Talk history.
   * - off: no Slack mirroring to Talk
   * - inbound: mirror inbound Slack messages only
   * - full: mirror inbound + assistant Slack responses
   */
  mirrorToTalk?: 'off' | 'inbound' | 'full';
  /**
   * Delivery routing for Slack auto-responses.
   * - thread: reply in inbound thread when available
   * - channel: always post at top-level channel
   * - adaptive: channel post for study updates, thread reply for advice/help
   */
  deliveryMode?: 'thread' | 'channel' | 'adaptive';
  /**
   * Optional response policy gates applied before model invocation.
   */
  responsePolicy?: {
    /**
     * - judgment: model decides if/how to respond
     * - study_entries_only: only respond when message looks like study/work log
     * - advice_or_study: respond for advice/help requests or study/work logs
     */
    triggerPolicy?: 'judgment' | 'study_entries_only' | 'advice_or_study';
    /** Optional sender allow-list (display name and/or sender id). */
    allowedSenders?: string[];
    /** Reserved for future scoring-based gating. */
    minConfidence?: number;
  };
  createdAt: number;
  updatedAt: number;
}

export type PlatformBehavior = TalkPlatformBehavior;

export interface ImageAttachmentMeta {
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCallInfo {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface TalkMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  model?: string;
  agentName?: string;
  agentRole?: AgentRole;
  attachment?: ImageAttachmentMeta;
  tool_calls?: ToolCallInfo[];
  tool_call_id?: string;
  tool_name?: string;
}

export interface TalkJob {
  id: string;
  type?: 'once' | 'recurring' | 'event';  // default 'recurring' for backwards compat
  schedule: string;  // time-based schedule OR "on <scope>" for event-driven
  prompt: string;
  output?: JobOutputDestination;
  active: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: string;
}

export interface JobOutputDestination {
  type: 'report_only' | 'talk' | 'slack';
  accountId?: string;
  channelId?: string;
  threadTs?: string;
}

export interface JobDeliveryResult {
  attempted: boolean;
  destination: string;
  success: boolean;
  error?: string;
}

export interface JobReport {
  id: string;
  jobId: string;
  talkId: string;
  runAt: number;
  status: 'success' | 'partial_success' | 'error';
  summary: string;
  fullOutput: string;
  delivery?: JobDeliveryResult;
  tokenUsage?: { input: number; output: number };
}

export type TalkStateCarryOverMode = 'none' | 'excess_only' | 'all';

export interface TalkStatePolicy {
  stream: string;
  timezone: string;
  weekStartDay: number; // 0=Sunday .. 6=Saturday
  rolloverHour: number; // 0..23
  rolloverMinute: number; // 0..59
  carryOverMode: TalkStateCarryOverMode;
  targetMinutes: number;
  updatedAt: number;
}

export interface TalkStateEvent {
  id: string;
  stream: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: number;
  recordedAt: number;
  idempotencyKey?: string;
  actor?: string;
}

export interface TalkStateSnapshot {
  stream: string;
  weekKey: string;
  weekStartAt: number;
  weekEndAt: number;
  totals: Record<string, number>;
  carryOver: Record<string, number>;
  completionTarget: number;
  completed: Record<string, boolean>;
  lastEventSequence: number;
  updatedAt: number;
  policy: TalkStatePolicy;
}

export type TalkDiagnosticStatus = 'open' | 'resolved' | 'dismissed';
export type TalkDiagnosticCategory = 'state' | 'filesystem' | 'tools' | 'routing' | 'slack' | 'intent' | 'other';

export interface TalkDiagnosticIssue {
  id: string;
  code: string;
  category: TalkDiagnosticCategory;
  title: string;
  message: string;
  status: TalkDiagnosticStatus;
  assumptionKey?: string;
  details?: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrences: number;
  resolvedAt?: number;
  dismissedAt?: number;
}

export interface TalkMeta {
  id: string;
  /** Monotonic gateway-authoritative metadata version for optimistic concurrency control. */
  talkVersion: number;
  /** Unique identifier for the latest metadata mutation. */
  changeId: string;
  /** Optional client/device identifier that initiated the latest metadata change. */
  lastModifiedBy?: string;
  /** Timestamp of the latest metadata mutation. */
  lastModifiedAt: number;
  topicTitle?: string;
  objective?: string;
  model?: string;
  /** Tool execution mode for this talk. */
  toolMode?: 'off' | 'confirm' | 'auto';
  /** Runtime selection for tool execution in this talk. */
  executionMode?: 'openclaw' | 'full_control';
  /** Filesystem policy for tool execution in this talk. */
  filesystemAccess?: 'workspace_sandbox' | 'full_host_access';
  /** Network egress policy for tool execution in this talk. */
  networkAccess?: 'restricted' | 'full_outbound';
  /** Optional allow-list of tool names for this talk (empty = all). */
  toolsAllow?: string[];
  /** Optional deny-list of tool names for this talk. */
  toolsDeny?: string[];
  /** Optional Google OAuth profile name for Google Docs/Drive tool calls in this talk. */
  googleAuthProfile?: string;
  /** Default state persistence backend policy for state_* operations. */
  stateBackend?: 'stream_store' | 'workspace_files';
  /** Optional default stream name used by state_* tools when stream is omitted. */
  defaultStateStream?: string;
  diagnostics?: TalkDiagnosticIssue[];
  pinnedMessageIds: string[];
  jobs: TalkJob[];
  agents?: TalkAgent[];
  directives?: TalkDirective[];
  platformBindings?: TalkPlatformBinding[];
  platformBehaviors?: TalkPlatformBehavior[];
  processing?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ClawTalkPluginConfig {
  proxyPort?: number;
  providers?: Record<string, ProviderBillingConfig>;
  voice?: VoicePluginConfig;
  realtimeVoice?: RealtimeVoicePluginConfig;
  pairPassword?: string;
  externalUrl?: string;
  name?: string;
  dataDir?: string;
  uploadDir?: string;
  llmCallTimeoutMs?: number;
  jobTimeoutMs?: number;
}

export type { IncomingMessage, ServerResponse };
