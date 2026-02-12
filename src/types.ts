/**
 * Type definitions for RemoteClaw Gateway Plugin
 *
 * Matches the real moltbot plugin API.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
}

export interface PluginApi {
  id: string;
  config: Record<string, any>;
  pluginConfig: Record<string, any> | undefined;
  runtime: {
    config: {
      loadConfig: () => Record<string, any>;
    };
  };
  logger: Logger;
  registerHttpHandler: (
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  ) => void;
}

export interface HandlerContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  cfg: Record<string, any>;
  pluginCfg: RemoteClawPluginConfig;
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
}

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
  type?: 'once' | 'recurring';  // default 'recurring' for backwards compat
  schedule: string;
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
  createdAt: number;
  updatedAt: number;
}

export interface RemoteClawPluginConfig {
  proxyPort?: number;
  providers?: Record<string, ProviderBillingConfig>;
  voice?: VoicePluginConfig;
  realtimeVoice?: RealtimeVoicePluginConfig;
  pairPassword?: string;
  externalUrl?: string;
  name?: string;
  dataDir?: string;
  uploadDir?: string;
}

export type { IncomingMessage, ServerResponse };
