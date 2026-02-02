import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginApi, RemoteClawPluginConfig } from './types.js';
import { sendJson, readJsonBody, handleCors } from './http.js';
import { authorize, resolveGatewayToken, safeEqual } from './auth.js';
import { handleProviders } from './providers.js';
import { handleRateLimits, warmUsageLoader } from './rate-limits.js';
import {
  handleVoiceCapabilities,
  handleVoiceTranscribe,
  handleVoiceSynthesize,
  resolveVoiceAvailability,
} from './voice.js';
import { startProxy } from './proxy.js';

const ROUTES = new Set([
  '/api/pair',
  '/api/providers',
  '/api/rate-limits',
  '/api/voice/capabilities',
  '/api/voice/transcribe',
  '/api/voice/synthesize',
]);

// ============================================================================
// Rate Limiter (for pairing endpoint)
// ============================================================================

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string, maxAttempts = 5, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > maxAttempts;
}

// Cleanup stale entries every 5 minutes
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);
rateLimitCleanup.unref();

// ============================================================================
// Pair Password
// ============================================================================

function resolvePairPassword(pluginCfg: RemoteClawPluginConfig): string | undefined {
  return pluginCfg.pairPassword ?? process.env.CLAWDBOT_PAIR_PASSWORD ?? undefined;
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

    // Start the rate-limit capture proxy
    startProxy(pluginCfg.proxyPort ?? 18793, api.logger);

    // Eagerly warm up the usage loader in background
    warmUsageLoader(api.logger);

    // Log voice availability
    const { sttAvailable, ttsAvailable } = resolveVoiceAvailability(pluginCfg.voice);
    if (sttAvailable || ttsAvailable) {
      api.logger.info(`RemoteClaw: voice enabled (STT: ${sttAvailable}, TTS: ${ttsAvailable})`);
    }

    api.registerHttpHandler(
      async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        const url = new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? 'localhost'}`,
        );

        if (!ROUTES.has(url.pathname)) return false;
        if (handleCors(req, res)) return true;

        // =================================================================
        // POST /api/pair — unauthenticated pairing endpoint
        // =================================================================
        if (url.pathname === '/api/pair') {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Allow', 'POST, OPTIONS');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Method Not Allowed');
            return true;
          }

          const pairPassword = resolvePairPassword(pluginCfg);
          if (!pairPassword) {
            sendJson(res, 404, { error: 'Pairing not configured' });
            return true;
          }

          const clientIP = req.socket?.remoteAddress ?? 'unknown';
          if (isRateLimited(clientIP)) {
            sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
            return true;
          }

          let body: { password?: string };
          try {
            body = await readJsonBody(req) as { password?: string };
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON body' });
            return true;
          }

          if (!body.password || typeof body.password !== 'string') {
            sendJson(res, 400, { error: 'Missing password' });
            return true;
          }

          if (!safeEqual(body.password, pairPassword)) {
            sendJson(res, 403, { error: 'Invalid password' });
            return true;
          }

          const pairCfg = api.runtime.config.loadConfig();
          const gatewayToken = resolveGatewayToken(pairCfg);

          let gatewayURL: string;
          let port: number;
          if (pluginCfg.externalUrl) {
            gatewayURL = pluginCfg.externalUrl;
            try {
              const parsed = new URL(pluginCfg.externalUrl);
              port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
            } catch {
              port = 18789;
            }
          } else {
            const host = req.headers.host ?? 'localhost:18789';
            const hostPort = host.includes(':') ? parseInt(host.split(':').pop()!, 10) : 80;
            port = hostPort;
            gatewayURL = `http://${host}`;
          }

          sendJson(res, 200, {
            name: pluginCfg.name ?? 'Gateway',
            gatewayURL,
            port,
            authToken: gatewayToken ?? '',
            agentID: 'mobileclaw',
          });
          return true;
        }

        // Auth (all other routes require authorization)
        const cfg = api.runtime.config.loadConfig();
        if (!authorize(req, cfg)) {
          sendJson(res, 401, {
            error: { message: 'Unauthorized', type: 'unauthorized' },
          });
          return true;
        }

        const ctx = { req, res, url, cfg, pluginCfg, logger: api.logger };

        switch (url.pathname) {
          case '/api/providers':
            await handleProviders(ctx);
            break;
          case '/api/rate-limits':
            await handleRateLimits(ctx);
            break;
          case '/api/voice/capabilities':
            await handleVoiceCapabilities(ctx);
            break;
          case '/api/voice/transcribe':
            await handleVoiceTranscribe(ctx);
            break;
          case '/api/voice/synthesize':
            await handleVoiceSynthesize(ctx);
            break;
        }

        return true;
      },
    );
  },
};

export default plugin;
