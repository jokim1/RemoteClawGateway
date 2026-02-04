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

export interface RemoteClawPluginConfig {
  proxyPort?: number;
  providers?: Record<string, ProviderBillingConfig>;
  voice?: VoicePluginConfig;
  realtimeVoice?: RealtimeVoicePluginConfig;
  pairPassword?: string;
  externalUrl?: string;
  name?: string;
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

export type { IncomingMessage, ServerResponse };
