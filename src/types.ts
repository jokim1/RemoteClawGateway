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
  registerCommand: (cmd: PluginCommandDefinition) => void;
  registerService: (svc: PluginService) => void;
  on: (hookName: string, handler: (...args: any[]) => void | Promise<void>) => void;
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
  permission: PlatformPermission;
  createdAt: number;
}

export type PlatformBinding = TalkPlatformBinding;

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
  active: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: string;
}

export interface JobReport {
  id: string;
  jobId: string;
  talkId: string;
  runAt: number;
  status: 'success' | 'error';
  summary: string;
  fullOutput: string;
  tokenUsage?: { input: number; output: number };
}

export interface TalkMeta {
  id: string;
  topicTitle?: string;
  objective?: string;
  model?: string;
  pinnedMessageIds: string[];
  jobs: TalkJob[];
  agents?: TalkAgent[];
  directives?: TalkDirective[];
  platformBindings?: TalkPlatformBinding[];
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
