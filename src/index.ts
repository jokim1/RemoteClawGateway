import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import Busboy from 'busboy';

import type {
  PluginApi,
  ProviderBillingConfig,
  VoicePluginConfig,
  RemoteClawPluginConfig,
  UsageSummary,
  ProviderUsageSnapshot,
} from './types.js';

// ============================================================================
// Helpers
// ============================================================================

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.end(JSON.stringify(body));
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = (req.headers.authorization ?? '').trim();
  if (!raw.toLowerCase().startsWith('bearer ')) return undefined;
  const token = raw.slice(7).trim();
  return token || undefined;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ============================================================================
// Auth
// ============================================================================

function resolveGatewayToken(cfg: Record<string, any>): string | undefined {
  return (
    cfg.gateway?.auth?.token ??
    process.env.CLAWDBOT_GATEWAY_TOKEN ??
    undefined
  );
}

function authorize(req: IncomingMessage, cfg: Record<string, any>): boolean {
  const expectedToken = resolveGatewayToken(cfg);
  if (!expectedToken) {
    const remote = req.socket?.remoteAddress ?? '';
    return (
      remote === '127.0.0.1' ||
      remote === '::1' ||
      remote.startsWith('::ffff:127.')
    );
  }
  const bearerToken = getBearerToken(req);
  if (!bearerToken) return false;
  return safeEqual(bearerToken, expectedToken);
}

// ============================================================================
// Usage loader — uses moltbot internals for rate-limit data
// ============================================================================

let _loadUsage: ((opts?: any) => Promise<UsageSummary>) | null = null;

function findMoltbotRoot(): string | null {
  const candidates = [
    '/usr/lib/node_modules/moltbot',
    '/usr/local/lib/node_modules/moltbot',
  ];
  for (const root of candidates) {
    if (existsSync(`${root}/dist/infra/provider-usage.load.js`)) {
      return root;
    }
  }
  return null;
}

async function ensureUsageLoader(
  log: PluginApi['logger']
): Promise<typeof _loadUsage> {
  if (_loadUsage) return _loadUsage;

  const root = findMoltbotRoot();
  if (!root) {
    log.warn('RemoteClaw: moltbot dist not found');
    return null;
  }

  try {
    const mod = await import(
      pathToFileURL(`${root}/dist/infra/provider-usage.load.js`).href
    );
    if (typeof mod.loadProviderUsageSummary === 'function') {
      _loadUsage = mod.loadProviderUsageSummary;
      log.info('RemoteClaw: usage loader initialized via import()');
      return _loadUsage;
    }
    log.warn(`RemoteClaw: module loaded, keys: ${Object.keys(mod).join(', ')}`);
  } catch (err) {
    log.info(`RemoteClaw: import() approach failed: ${err}`);
  }

  try {
    const mod = await import(
      pathToFileURL(`${root}/dist/infra/provider-usage.js`).href
    );
    if (typeof mod.loadProviderUsageSummary === 'function') {
      _loadUsage = mod.loadProviderUsageSummary;
      log.info('RemoteClaw: usage loader initialized via barrel import');
      return _loadUsage;
    }
  } catch (err) {
    log.info(`RemoteClaw: barrel import failed: ${err}`);
  }

  log.info('RemoteClaw: falling back to subprocess strategy');
  _loadUsage = createSubprocessUsageLoader(root, log);
  return _loadUsage;
}

function createSubprocessUsageLoader(
  moltbotRoot: string,
  log: PluginApi['logger']
): (opts?: any) => Promise<UsageSummary> {
  return async () => {
    try {
      const script = `
        import { loadProviderUsageSummary } from "${moltbotRoot}/dist/infra/provider-usage.load.js";
        const result = await loadProviderUsageSummary();
        process.stdout.write(JSON.stringify(result));
      `;
      const output = execSync(
        `node --input-type=module -e '${script.replace(/'/g, "'\\''")}'`,
        {
          timeout: 10000,
          env: process.env,
          encoding: 'utf-8',
        }
      );
      return JSON.parse(output.trim());
    } catch (err) {
      log.warn(`RemoteClaw: subprocess fetch failed: ${err}`);
      return { updatedAt: Date.now(), providers: [] };
    }
  };
}

// ============================================================================
// Detect configured providers
// ============================================================================

function detectConfiguredProviders(cfg: Record<string, any>): string[] {
  const providers = new Set<string>();

  const customProviders = cfg.models?.providers ?? {};
  for (const key of Object.keys(customProviders)) {
    providers.add(key.toLowerCase());
  }

  const profiles = cfg.auth?.profiles ?? {};
  for (const [, profile] of Object.entries(profiles)) {
    const p = profile as Record<string, any>;
    if (typeof p?.provider === 'string') {
      providers.add(p.provider.toLowerCase());
    }
  }

  const defaultModel = cfg.agents?.defaults?.model?.primary;
  if (typeof defaultModel === 'string') {
    const slash = defaultModel.indexOf('/');
    if (slash > 0) providers.add(defaultModel.slice(0, slash).toLowerCase());
  }

  const allowedModels = cfg.agents?.defaults?.models ?? {};
  for (const key of Object.keys(allowedModels)) {
    const slash = key.indexOf('/');
    if (slash > 0) providers.add(key.slice(0, slash).toLowerCase());
  }

  const agentList = cfg.agents?.list ?? [];
  for (const agent of agentList) {
    const model = agent?.model;
    if (typeof model === 'string') {
      const slash = model.indexOf('/');
      if (slash > 0) providers.add(model.slice(0, slash).toLowerCase());
    }
  }

  if (process.env.ANTHROPIC_API_KEY) providers.add('anthropic');
  if (process.env.OPENAI_API_KEY) providers.add('openai');
  if (process.env.DEEPSEEK_API_KEY) providers.add('deepseek');
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)
    providers.add('google');

  return Array.from(providers).sort();
}

// ============================================================================
// Format usage snapshot into spec format
// ============================================================================

function formatSnapshot(snapshot: ProviderUsageSnapshot): Record<string, any> {
  const result: Record<string, any> = { provider: snapshot.provider };
  const windows = snapshot.windows ?? [];

  const sessionWindow = windows.find(
    (w) => w.label === '5h' || w.label === 'session'
  );
  const weeklyWindow = windows.find(
    (w) => w.label === 'Week' || w.label === '7d' || w.label === 'weekly'
  );

  if (sessionWindow) {
    result.session = {
      used: Math.round(sessionWindow.usedPercent),
      limit: 100,
      resetsAt: sessionWindow.resetAt
        ? new Date(sessionWindow.resetAt).toISOString()
        : undefined,
    };
  }

  if (weeklyWindow) {
    result.weekly = {
      used: Math.round(weeklyWindow.usedPercent),
      limit: 100,
      resetsAt: weeklyWindow.resetAt
        ? new Date(weeklyWindow.resetAt).toISOString()
        : undefined,
    };
  }

  if (!sessionWindow && !weeklyWindow && windows.length > 0) {
    const first = windows[0]!;
    result.session = {
      used: Math.round(first.usedPercent),
      limit: 100,
      resetsAt: first.resetAt
        ? new Date(first.resetAt).toISOString()
        : undefined,
    };
  }

  if (snapshot.error) {
    result.error = snapshot.error;
  }

  return result;
}

// ============================================================================
// Voice helpers
// ============================================================================

const TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_TEXT_LENGTH = 4096;

function parseMultipart(
  req: IncomingMessage,
  contentType: string
): Promise<{ audioBuffer: Buffer; language: string }> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    });

    const chunks: Buffer[] = [];
    let lang = 'en';

    busboy.on('file', (_fieldname: string, stream: NodeJS.ReadableStream) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    });

    busboy.on('field', (fieldname: string, value: string) => {
      if (fieldname === 'language') lang = value;
    });

    busboy.on('finish', () => {
      resolve({ audioBuffer: Buffer.concat(chunks), language: lang });
    });
    busboy.on('error', (err: Error) => reject(err));

    req.pipe(busboy);
  });
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Call OpenAI Whisper API directly for STT.
 * Uses OPENAI_API_KEY from environment.
 */
async function transcribeViaOpenAI(
  audioBuffer: Buffer,
  language: string,
  model: string,
): Promise<{ text: string; language?: string; duration?: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const blob = new Blob([audioBuffer], { type: 'audio/wav' });
  const formData = new FormData();
  formData.append('file', blob, 'recording.wav');
  formData.append('model', model);
  formData.append('language', language);
  formData.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI STT error (${response.status}): ${body.slice(0, 200)}`);
  }

  const result = await response.json() as { text: string; language?: string; duration?: number };
  return result;
}

/**
 * Call OpenAI TTS API directly for speech synthesis.
 * Uses OPENAI_API_KEY from environment.
 */
async function synthesizeViaOpenAI(
  text: string,
  voice: string,
  model: string,
  speed?: number,
): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const body: Record<string, unknown> = {
    model,
    input: text,
    voice,
    response_format: 'mp3',
  };
  if (speed !== undefined) body.speed = speed;

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenAI TTS error (${response.status}): ${errBody.slice(0, 200)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================================
// Plugin
// ============================================================================

const plugin = {
  id: 'remoteclaw',
  name: 'RemoteClaw',
  description:
    'Exposes /api/providers, /api/rate-limits, and /api/voice/* HTTP endpoints for the RemoteClaw TUI client.',

  register(api: PluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as RemoteClawPluginConfig;

    api.logger.info('RemoteClaw plugin loaded');

    // Eagerly warm up the usage loader in background
    ensureUsageLoader(api.logger).catch(() => {});

    // Check if voice is available (OpenAI key present or voice configured)
    const voiceCfg = pluginCfg.voice;
    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
    const sttAvailable = !!(voiceCfg?.stt?.provider || hasOpenAIKey);
    const ttsAvailable = !!(voiceCfg?.tts?.provider || hasOpenAIKey);

    if (sttAvailable || ttsAvailable) {
      api.logger.info(`RemoteClaw: voice enabled (STT: ${sttAvailable}, TTS: ${ttsAvailable})`);
    }

    // -------------------------------------------------------------------
    // Combined HTTP handler
    // -------------------------------------------------------------------

    api.registerHttpHandler(
      async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        const url = new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? 'localhost'}`
        );

        // Only handle our routes
        const path = url.pathname;
        if (
          path !== '/api/providers' &&
          path !== '/api/rate-limits' &&
          path !== '/api/voice/capabilities' &&
          path !== '/api/voice/transcribe' &&
          path !== '/api/voice/synthesize'
        ) {
          return false;
        }

        // CORS preflight
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.end();
          return true;
        }

        // Auth
        const cfg = api.runtime.config.loadConfig();
        if (!authorize(req, cfg)) {
          sendJson(res, 401, {
            error: { message: 'Unauthorized', type: 'unauthorized' },
          });
          return true;
        }

        // =================================================================
        // GET /api/providers
        // =================================================================
        if (path === '/api/providers' && req.method === 'GET') {
          const configuredProviders = detectConfiguredProviders(cfg);
          const billingOverrides = pluginCfg.providers ?? {};

          const providers = configuredProviders.map((id) => {
            const override = billingOverrides[id];
            if (override) {
              const billing: Record<string, any> = {
                mode: override.billing ?? 'api',
              };
              if (override.plan) billing.plan = override.plan;
              if (override.monthlyPrice !== undefined)
                billing.monthlyPrice = override.monthlyPrice;
              return { id, billing };
            }
            return { id, billing: { mode: 'api' as const } };
          });

          sendJson(res, 200, { providers });
          return true;
        }

        // =================================================================
        // GET /api/rate-limits
        // =================================================================
        if (path === '/api/rate-limits' && req.method === 'GET') {
          const providerFilter = url.searchParams.get('provider') ?? undefined;

          const loader = await ensureUsageLoader(api.logger);
          if (!loader) {
            sendJson(res, 200, { error: 'usage_loader_unavailable' });
            return true;
          }

          try {
            const summary = await loader();
            const snapshots = summary.providers ?? [];

            const filtered = providerFilter
              ? snapshots.filter(
                  (s) =>
                    s.provider.toLowerCase() === providerFilter.toLowerCase()
                )
              : snapshots;

            if (filtered.length === 0) {
              sendJson(res, 200, {});
              return true;
            }

            if (providerFilter && filtered.length === 1) {
              sendJson(res, 200, formatSnapshot(filtered[0]!));
              return true;
            }

            sendJson(res, 200, {
              rateLimits: filtered.map(formatSnapshot),
            });
          } catch (err) {
            api.logger.warn(`RemoteClaw: rate-limits fetch error: ${String(err)}`);
            sendJson(res, 200, {});
          }
          return true;
        }

        // =================================================================
        // GET /api/voice/capabilities
        // =================================================================
        if (path === '/api/voice/capabilities' && req.method === 'GET') {
          sendJson(res, 200, {
            stt: {
              available: sttAvailable,
              ...(sttAvailable && {
                provider: voiceCfg?.stt?.provider ?? 'openai',
                model: voiceCfg?.stt?.model ?? 'whisper-1',
                maxDurationSeconds: 120,
                maxFileSizeMB: 25,
              }),
            },
            tts: {
              available: ttsAvailable,
              ...(ttsAvailable && {
                provider: voiceCfg?.tts?.provider ?? 'openai',
                model: voiceCfg?.tts?.model ?? 'tts-1',
                voices: TTS_VOICES,
                defaultVoice: voiceCfg?.tts?.defaultVoice ?? 'nova',
              }),
            },
          });
          return true;
        }

        // =================================================================
        // POST /api/voice/transcribe
        // =================================================================
        if (path === '/api/voice/transcribe' && req.method === 'POST') {
          if (!sttAvailable) {
            sendJson(res, 503, { error: 'No STT provider configured' });
            return true;
          }

          const contentType = (req.headers['content-type'] as string) ?? '';
          if (!contentType.includes('multipart/form-data')) {
            sendJson(res, 400, { error: 'Expected multipart/form-data' });
            return true;
          }

          let parsed: { audioBuffer: Buffer; language: string };
          try {
            parsed = await parseMultipart(req, contentType);
          } catch (err) {
            api.logger.error(`RemoteClaw: multipart parse failed: ${err}`);
            sendJson(res, 400, { error: 'Failed to parse audio upload' });
            return true;
          }

          if (parsed.audioBuffer.length < 100) {
            sendJson(res, 400, { error: 'No audio data received' });
            return true;
          }

          if (parsed.audioBuffer.length > MAX_FILE_SIZE) {
            sendJson(res, 413, { error: 'Audio file too large (max 25MB)' });
            return true;
          }

          try {
            const model = voiceCfg?.stt?.model ?? 'whisper-1';
            const result = await transcribeViaOpenAI(
              parsed.audioBuffer,
              parsed.language,
              model,
            );

            sendJson(res, 200, {
              text: result.text,
              language: result.language ?? parsed.language,
              duration: result.duration,
            });
          } catch (err) {
            api.logger.error(`RemoteClaw: STT failed: ${err}`);
            sendJson(res, 500, {
              error: err instanceof Error ? err.message : 'Transcription failed',
            });
          }
          return true;
        }

        // =================================================================
        // POST /api/voice/synthesize
        // =================================================================
        if (path === '/api/voice/synthesize' && req.method === 'POST') {
          if (!ttsAvailable) {
            sendJson(res, 503, { error: 'No TTS provider configured' });
            return true;
          }

          let body: { text?: string; voice?: string; speed?: number };
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON body' });
            return true;
          }

          if (!body.text || !body.text.trim()) {
            sendJson(res, 400, { error: 'Missing or empty text' });
            return true;
          }

          if (body.text.length > MAX_TEXT_LENGTH) {
            sendJson(res, 413, { error: `Text too long (max ${MAX_TEXT_LENGTH} chars)` });
            return true;
          }

          const voice = body.voice ?? voiceCfg?.tts?.defaultVoice ?? 'nova';
          const model = voiceCfg?.tts?.model ?? 'tts-1';

          try {
            const audioBuffer = await synthesizeViaOpenAI(
              body.text,
              voice,
              model,
              body.speed,
            );

            res.statusCode = 200;
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Length', audioBuffer.length);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(audioBuffer);
          } catch (err) {
            api.logger.error(`RemoteClaw: TTS failed: ${err}`);
            sendJson(res, 500, {
              error: err instanceof Error ? err.message : 'Synthesis failed',
            });
          }
          return true;
        }

        // Method not allowed for our routes
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, POST, OPTIONS');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Method Not Allowed');
        return true;
      }
    );
  },
};

export default plugin;
