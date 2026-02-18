import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from './types.js';

function isLocalHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:') return false;
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function ensureAnthropicBaseUrl(cfg: Record<string, unknown>, targetBaseUrl: string): boolean {
  const models = (cfg.models && typeof cfg.models === 'object')
    ? cfg.models as Record<string, unknown>
    : null;
  const providers = (models?.providers && typeof models.providers === 'object')
    ? models.providers as Record<string, unknown>
    : null;
  const anthropic = (providers?.anthropic && typeof providers.anthropic === 'object')
    ? providers.anthropic as Record<string, unknown>
    : null;
  if (!anthropic) return false;

  const current = anthropic.baseUrl;
  if (!isLocalHttpUrl(current)) return false;
  if (String(current).trim() === targetBaseUrl) return false;
  anthropic.baseUrl = targetBaseUrl;
  return true;
}

async function patchJsonFile(filePath: string, patch: (obj: Record<string, unknown>) => boolean): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return false;
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  const changed = patch(obj);
  if (!changed) return false;

  const next = `${JSON.stringify(obj, null, 2)}\n`;
  if (next === raw) return false;

  const tmp = `${filePath}.tmp.${Date.now()}.${randomUUID()}`;
  try {
    await fs.writeFile(tmp, next, 'utf-8');
    await fs.rename(tmp, filePath);
  } catch {
    // Ignore transient filesystem races (agent dirs may appear/disappear during startup).
    try {
      await fs.unlink(tmp);
    } catch {
      // best-effort cleanup
    }
    return false;
  }
  return true;
}

export async function reconcileAnthropicProxyBaseUrls(proxyPort: number, logger: Logger): Promise<void> {
  const home = process.env.HOME?.trim();
  if (!home) return;

  const targetBaseUrl = `http://127.0.0.1:${proxyPort}`;
  let changedFiles = 0;

  const openclawConfigPath = path.join(home, '.openclaw', 'openclaw.json');
  if (await patchJsonFile(openclawConfigPath, (obj) => ensureAnthropicBaseUrl(obj, targetBaseUrl))) {
    changedFiles += 1;
  }

  const agentsRoot = path.join(home, '.openclaw', 'agents');
  let agentDirs: string[] = [];
  try {
    const entries = await fs.readdir(agentsRoot, { withFileTypes: true });
    agentDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    agentDirs = [];
  }

  for (const agentDir of agentDirs) {
    const modelsPath = path.join(agentsRoot, agentDir, 'agent', 'models.json');
    const changed = await patchJsonFile(modelsPath, (obj) => {
      const providers = (obj.providers && typeof obj.providers === 'object')
        ? obj.providers as Record<string, unknown>
        : null;
      const anthropic = (providers?.anthropic && typeof providers.anthropic === 'object')
        ? providers.anthropic as Record<string, unknown>
        : null;
      if (!anthropic) return false;
      const current = anthropic.baseUrl;
      if (!isLocalHttpUrl(current)) return false;
      if (String(current).trim() === targetBaseUrl) return false;
      anthropic.baseUrl = targetBaseUrl;
      return true;
    });
    if (changed) changedFiles += 1;
  }

  if (changedFiles > 0) {
    logger.info(`ClawTalk: reconciled Anthropic local baseUrl to ${targetBaseUrl} in ${changedFiles} file(s)`);
  }
}

function ensureResponsesEndpointEnabled(cfg: Record<string, unknown>): boolean {
  const gateway = (cfg.gateway && typeof cfg.gateway === 'object')
    ? cfg.gateway as Record<string, unknown>
    : (cfg.gateway = {}) as Record<string, unknown>;
  const http = (gateway.http && typeof gateway.http === 'object')
    ? gateway.http as Record<string, unknown>
    : (gateway.http = {}) as Record<string, unknown>;
  const endpoints = (http.endpoints && typeof http.endpoints === 'object')
    ? http.endpoints as Record<string, unknown>
    : (http.endpoints = {}) as Record<string, unknown>;
  const responses = (endpoints.responses && typeof endpoints.responses === 'object')
    ? endpoints.responses as Record<string, unknown>
    : (endpoints.responses = {}) as Record<string, unknown>;

  if (responses.enabled === true) return false;
  responses.enabled = true;
  return true;
}

export async function reconcileGatewayResponsesEndpoint(logger: Logger): Promise<void> {
  const home = process.env.HOME?.trim();
  if (!home) return;
  const openclawConfigPath = path.join(home, '.openclaw', 'openclaw.json');
  const changed = await patchJsonFile(openclawConfigPath, ensureResponsesEndpointEnabled);
  if (changed) {
    logger.info('ClawTalk: enabled gateway.http.endpoints.responses for function-calling passthrough.');
  }
}
