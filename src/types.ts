/**
 * Type definitions for RemoteClaw Gateway Plugin
 *
 * Matches the real moltbot plugin API.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface PluginApi {
  id: string;
  config: Record<string, any>;
  pluginConfig: Record<string, any> | undefined;
  runtime: {
    config: {
      loadConfig: () => Record<string, any>;
    };
  };
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  registerHttpHandler: (
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  ) => void;
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

export interface RemoteClawPluginConfig {
  providers?: Record<string, ProviderBillingConfig>;
  voice?: VoicePluginConfig;
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

export type { IncomingMessage, ServerResponse };
