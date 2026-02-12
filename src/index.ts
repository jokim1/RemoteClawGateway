import type { IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import type { PluginApi, RemoteClawPluginConfig } from './types.js';
import { sendJson, readJsonBody, handleCors } from './http.js';
import { authorize, resolveGatewayToken, safeEqual } from './auth.js';
import { handleProviders } from './providers.js';
import { handleRateLimits, warmUsageLoader } from './rate-limits.js';
import {
  handleVoiceCapabilities,
  handleVoiceTranscribe,
  handleVoiceSynthesize,
  handleSTTProviderSwitch,
  handleTTSProviderSwitch,
  resolveVoiceAvailability,
} from './voice.js';
import { handleVoiceStreamUpgrade } from './voice-stream.js';
import {
  handleRealtimeVoiceCapabilities,
  handleRealtimeVoiceStreamUpgrade,
} from './realtime-voice.js';
import { startProxy } from './proxy.js';
import { TalkStore } from './talk-store.js';
import { handleTalks } from './talks.js';
import { handleTalkChat } from './talk-chat.js';
import { startJobScheduler } from './job-scheduler.js';
import { handleFileUpload } from './file-upload.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolExecutor } from './tool-executor.js';

const ROUTES = new Set([
  '/api/pair',
  '/api/providers',
  '/api/rate-limits',
  '/api/tools',
  '/api/voice/capabilities',
  '/api/voice/transcribe',
  '/api/voice/synthesize',
  '/api/voice/stream',
  '/api/voice/stt/provider',
  '/api/voice/tts/provider',
  '/api/realtime-voice/capabilities',
  '/api/realtime-voice/stream',
  '/api/files/upload',
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
// Tailscale Funnel auto-detection
// ============================================================================

let _cachedFunnelUrl: string | null | undefined; // undefined = not yet checked

function detectTailscaleFunnelUrl(log: PluginApi['logger']): string | null {
  if (_cachedFunnelUrl !== undefined) return _cachedFunnelUrl;

  try {
    const output = execSync('tailscale status --json', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const status = JSON.parse(output);
    const dnsName: string | undefined = status?.Self?.DNSName;
    if (dnsName) {
      // DNSName has a trailing dot (e.g. "host.tailnet.ts.net.") — strip it
      const hostname = dnsName.replace(/\.$/, '');
      if (hostname.includes('.')) {
        const url = `https://${hostname}`;
        log.info(`RemoteClaw: detected Tailscale hostname: ${url}`);
        _cachedFunnelUrl = url;
        return url;
      }
    }
    log.info('RemoteClaw: no Tailscale DNS name found');
  } catch (err) {
    log.info(`RemoteClaw: Tailscale detection failed: ${err}`);
  }

  _cachedFunnelUrl = null;
  return null;
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

    // Initialize Talk store
    const talkStore = new TalkStore(pluginCfg.dataDir, api.logger);

    // Initialize tool registry and executor
    const toolRegistry = new ToolRegistry(pluginCfg.dataDir, api.logger);
    const toolExecutor = new ToolExecutor(toolRegistry, api.logger);

    // Start job scheduler
    const cfg0 = api.runtime.config.loadConfig();
    const gatewayToken0 = resolveGatewayToken(cfg0);
    // For self-calls (job scheduler), always use 127.0.0.1 — never the
    // externalUrl, which is a client-facing URL that may not be reachable
    // from the server itself (e.g. Tailscale funnel HTTPS hairpin issues).
    const schedulerOrigin = 'http://127.0.0.1:18789';
    const stopScheduler = startJobScheduler({
      store: talkStore,
      gatewayOrigin: schedulerOrigin,
      authToken: gatewayToken0,
      logger: api.logger,
      registry: toolRegistry,
      executor: toolExecutor,
    });

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

        const isTalkRoute = url.pathname === '/api/talks' || url.pathname.startsWith('/api/talks/');
        if (!ROUTES.has(url.pathname) && !isTalkRoute) return false;
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
          const resolvedUrl = pluginCfg.externalUrl ?? detectTailscaleFunnelUrl(api.logger);
          if (resolvedUrl) {
            gatewayURL = resolvedUrl;
            try {
              const parsed = new URL(resolvedUrl);
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

        // WebSocket upgrade for voice streaming — handled separately
        if (url.pathname === '/api/voice/stream') {
          const host = req.headers.host ?? 'localhost:18789';
          const gatewayOrigin = `http://${host}`;
          const gatewayToken = resolveGatewayToken(cfg);
          handleVoiceStreamUpgrade(
            req, res, api.logger,
            pluginCfg.voice, gatewayOrigin, gatewayToken,
          );
          return true;
        }

        // WebSocket upgrade for realtime voice streaming
        if (url.pathname === '/api/realtime-voice/stream') {
          handleRealtimeVoiceStreamUpgrade(
            req, res, api.logger,
            pluginCfg.realtimeVoice,
          );
          return true;
        }

        const ctx = { req, res, url, cfg, pluginCfg, logger: api.logger };

        // Talk routes (dynamic path segments)
        if (isTalkRoute) {
          // POST /api/talks/:id/chat
          const chatMatch = url.pathname.match(/^\/api\/talks\/([\w-]+)\/chat$/);
          if (chatMatch) {
            const host = req.headers.host ?? 'localhost:18789';
            const gatewayOrigin = `http://${host}`;
            const gatewayToken = resolveGatewayToken(cfg);
            await handleTalkChat({
              req, res,
              talkId: chatMatch[1],
              store: talkStore,
              gatewayOrigin,
              authToken: gatewayToken,
              logger: api.logger,
              registry: toolRegistry,
              executor: toolExecutor,
            });
            return true;
          }
          // All other /api/talks/* CRUD routes
          await handleTalks(ctx, talkStore);
          return true;
        }

        // /api/tools routes (also match /api/tools/:name)
        if (url.pathname === '/api/tools' || url.pathname.startsWith('/api/tools/')) {
          const { handleToolRoutes } = await import('./talks.js');
          await handleToolRoutes(ctx, toolRegistry);
          return true;
        }

        switch (url.pathname) {
          case '/api/files/upload':
            await handleFileUpload(ctx, pluginCfg.uploadDir);
            break;
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
          case '/api/voice/stt/provider':
            await handleSTTProviderSwitch(ctx);
            break;
          case '/api/voice/tts/provider':
            await handleTTSProviderSwitch(ctx);
            break;
          case '/api/realtime-voice/capabilities':
            await handleRealtimeVoiceCapabilities(ctx);
            break;
        }

        return true;
      },
    );
  },
};

export default plugin;
