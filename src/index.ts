import type { IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import type { PluginApi, ClawTalkPluginConfig, Logger } from './types.js';
import type { EventReplyTarget } from './event-dispatcher.js';
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
import { EventDispatcher } from './event-dispatcher.js';
import { handleFileUpload } from './file-upload.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolExecutor } from './tool-executor.js';
import { registerCommands } from './commands.js';
import {
  handleSlackIngress,
  handleSlackMessageReceivedHook,
  handleSlackMessageSendingHook,
} from './slack-ingress.js';

// ---------------------------------------------------------------------------
// Node.js 25 fetch fix — replace built-in undici connector to fix Tailscale IP
// connectivity (100.64.0.0/10 CGNAT range). Without this, fetch() to the
// gateway origin fails with ECONNREFUSED on Tailscale IPs.
// ---------------------------------------------------------------------------
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Agent, setGlobalDispatcher, buildConnector } = require('undici');
  const connector = buildConnector({});
  setGlobalDispatcher(new Agent({
    connect: (opts: Record<string, unknown>, cb: Function) => connector(opts, cb),
  }));
} catch {
  // undici not installed — fetch uses Node's built-in connector
}

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
  '/api/events/slack',
]);

// ============================================================================
// Rate Limiter (for pairing endpoint)
// ============================================================================

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string, maxAttempts = 5, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    // Prevent unbounded map growth between cleanup cycles
    if (!entry && rateLimitMap.size >= 10_000) return false;
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

function resolvePairPassword(pluginCfg: ClawTalkPluginConfig): string | undefined {
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
        log.info(`ClawTalk: detected Tailscale hostname: ${url}`);
        _cachedFunnelUrl = url;
        return url;
      }
    }
    log.info('ClawTalk: no Tailscale DNS name found');
  } catch (err) {
    log.info(`ClawTalk: Tailscale detection failed: ${err}`);
  }

  _cachedFunnelUrl = null;
  return null;
}

/**
 * Resolve the gateway's self-origin for internal calls (scheduler, dispatcher).
 * Reads gateway.bind and gateway.port from config. If bind is "tailnet",
 * resolves the Tailscale IPv4 via `tailscale status --json`.
 */
function resolveGatewayOrigin(cfg: Record<string, any>, log: PluginApi['logger']): string {
  const port = cfg?.gateway?.port ?? 18789;
  const bind = cfg?.gateway?.bind;

  if (bind === 'tailnet' || bind === 'tailscale') {
    try {
      const output = execSync('tailscale ip -4', {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const ip = output.trim();
      if (ip) {
        const origin = `http://${ip}:${port}`;
        log.info(`ClawTalk: resolved gateway origin: ${origin}`);
        return origin;
      }
    } catch {
      // fall through to default
    }
  }

  if (bind && bind !== 'tailnet' && bind !== 'tailscale' && bind !== '0.0.0.0') {
    return `http://${bind}:${port}`;
  }

  return `http://127.0.0.1:${port}`;
}

// ============================================================================
// Platform reply — delivers event job output back to the originating platform
// ============================================================================

/**
 * Resolve the Slack bot token for a given account from the OpenClaw config.
 * Config values use template syntax like "${SLACK_KIMFAMILY_BOT_TOKEN}".
 */
function resolveSlackBotToken(cfg: Record<string, any>, accountId: string): string | undefined {
  const raw: string | undefined = cfg?.channels?.slack?.accounts?.[accountId]?.botToken;
  if (!raw) return undefined;

  // Resolve ${ENV_VAR} template
  const envMatch = raw.match(/^\$\{(.+)\}$/);
  if (envMatch) {
    return process.env[envMatch[1]] ?? undefined;
  }

  return raw;
}

/**
 * Create a replyToEvent callback that delivers messages to platforms.
 * Currently supports Slack via chat.postMessage.
 */
function createEventReplyHandler(
  getConfig: () => Record<string, any>,
  logger: Logger,
) {
  return async (target: EventReplyTarget, message: string): Promise<boolean> => {
    if (target.platform !== 'slack') {
      logger.warn(`EventReply: unsupported platform "${target.platform}"`);
      return false;
    }

    if (!target.platformChannelId || !target.accountId) {
      logger.warn('EventReply: missing channelId or accountId');
      return false;
    }

    const cfg = getConfig();
    const botToken = resolveSlackBotToken(cfg, target.accountId);
    if (!botToken) {
      logger.warn(`EventReply: no bot token for Slack account "${target.accountId}"`);
      return false;
    }

    try {
      const body: Record<string, unknown> = {
        channel: target.platformChannelId,
        text: message,
      };
      if (target.threadId) {
        body.thread_ts = target.threadId;
      }

      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const result = await res.json() as { ok: boolean; error?: string };
      if (!result.ok) {
        logger.warn(`EventReply: Slack API error: ${result.error}`);
        return false;
      }

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`EventReply: Slack post failed: ${msg}`);
      return false;
    }
  };
}

// ============================================================================
// Plugin
// ============================================================================

const plugin = {
  id: 'clawtalk',
  name: 'ClawTalk',
  description:
    'Exposes /api/providers, /api/rate-limits, and /api/voice/* HTTP endpoints for the ClawTalk TUI client.',

  register(api: PluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as ClawTalkPluginConfig;

    api.logger.info('ClawTalk plugin loaded');

    // Start the rate-limit capture proxy
    startProxy(pluginCfg.proxyPort ?? 18793, api.logger);

    // Eagerly warm up the usage loader in background
    warmUsageLoader(api.logger);

    // Initialize Talk store (async)
    const talkStore = new TalkStore(pluginCfg.dataDir, api.logger);
    talkStore.init().catch(err => api.logger.error(`TalkStore init failed: ${err}`));

    // Shared Slack reply path (direct Slack API).
    const replyHandler = createEventReplyHandler(
      () => api.runtime.config.loadConfig(),
      api.logger,
    );
    let slackIngressOrigin = 'http://127.0.0.1:18789';
    let slackIngressToken: string | undefined;
    const refreshSlackIngressRoute = () => {
      const cfg0 = api.runtime.config.loadConfig();
      slackIngressOrigin = resolveGatewayOrigin(cfg0, api.logger);
      slackIngressToken = resolveGatewayToken(cfg0);
    };
    const buildSlackIngressDeps = () => ({
      store: talkStore,
      gatewayOrigin: slackIngressOrigin,
      authToken: slackIngressToken,
      logger: api.logger,
      sendSlackMessage: async (params: {
        accountId?: string;
        channelId: string;
        threadTs?: string;
        message: string;
      }) =>
        replyHandler(
          {
            platform: 'slack',
            accountId: params.accountId,
            platformChannelId: params.channelId,
            threadId: params.threadTs,
          },
          params.message,
        ),
    });
    refreshSlackIngressRoute();

    // Initialize tool registry and executor
    const toolRegistry = new ToolRegistry(pluginCfg.dataDir, api.logger);
    const toolExecutor = new ToolExecutor(toolRegistry, api.logger);

    // Register job scheduler as a managed service
    let stopScheduler: (() => void) | null = null;
    api.registerService({
      id: 'clawtalk-job-scheduler',
      start: () => {
        const cfg0 = api.runtime.config.loadConfig();
        const gatewayToken0 = resolveGatewayToken(cfg0);
        const schedulerOrigin = resolveGatewayOrigin(cfg0, api.logger);
        stopScheduler = startJobScheduler({
          store: talkStore,
          gatewayOrigin: schedulerOrigin,
          authToken: gatewayToken0,
          logger: api.logger,
          registry: toolRegistry,
          executor: toolExecutor,
          jobTimeoutMs: pluginCfg.jobTimeoutMs,
        });
      },
      stop: () => {
        if (stopScheduler) {
          stopScheduler();
          stopScheduler = null;
        }
      },
    });

    // Initialize event dispatcher for event-driven jobs
    let eventDispatcher: EventDispatcher | null = null;
    api.registerService({
      id: 'clawtalk-event-dispatcher',
      start: () => {
        refreshSlackIngressRoute();
        eventDispatcher = new EventDispatcher({
          store: talkStore,
          gatewayOrigin: slackIngressOrigin,
          authToken: slackIngressToken,
          logger: api.logger,
          registry: toolRegistry,
          executor: toolExecutor,
          jobTimeoutMs: pluginCfg.jobTimeoutMs,
          replyToEvent: replyHandler,
        });
        api.logger.info('ClawTalk: event dispatcher started');
      },
      stop: () => {
        if (eventDispatcher) {
          eventDispatcher.cleanup();
          eventDispatcher = null;
          api.logger.info('ClawTalk: event dispatcher stopped');
        }
      },
    });

    // Listen for incoming platform messages (Slack, Telegram, etc.)
    api.on('message_received', (event: any, ctx: any) => {
      if (eventDispatcher) {
        eventDispatcher.handleMessageReceived(event, ctx).catch(err => {
          api.logger.warn(`ClawTalk: event dispatch error: ${err}`);
        });
      }
      handleSlackMessageReceivedHook(event, ctx, buildSlackIngressDeps()).catch(err => {
        api.logger.warn(`ClawTalk: slack ownership hook failed: ${err}`);
      });
    });

    api.on('message_sending', (event: any, ctx: any) => {
      return handleSlackMessageSendingHook(event, ctx, api.logger);
    });

    // Register lifecycle hooks
    api.on('gateway_start', () => {
      refreshSlackIngressRoute();
      api.logger.info('ClawTalk: gateway_start event received');
    });

    api.on('gateway_stop', () => {
      api.logger.info('ClawTalk: gateway_stop event received — cleaning up');
      if (stopScheduler) {
        stopScheduler();
        stopScheduler = null;
      }
      if (eventDispatcher) {
        eventDispatcher.cleanup();
        eventDispatcher = null;
      }
    });

    // Register plugin commands
    registerCommands(api, talkStore);

    // Log voice availability
    const { sttAvailable, ttsAvailable } = resolveVoiceAvailability(pluginCfg.voice);
    if (sttAvailable || ttsAvailable) {
      api.logger.info(`ClawTalk: voice enabled (STT: ${sttAvailable}, TTS: ${ttsAvailable})`);
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
            // Use the socket's local address for self-calls — the gateway may
            // bind to a specific IP (e.g. Tailscale) rather than 0.0.0.0.
            const selfAddr = req.socket?.localAddress ?? '127.0.0.1';
            const selfPort = req.socket?.localPort ?? 18789;
            const gatewayOrigin = `http://${selfAddr}:${selfPort}`;
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
          case '/api/events/slack': {
            const host = req.headers.host ?? 'localhost:18789';
            const gatewayOrigin = `http://${host}`;
            const gatewayToken = resolveGatewayToken(cfg);
            await handleSlackIngress(ctx, {
              store: talkStore,
              gatewayOrigin,
              authToken: gatewayToken,
              logger: api.logger,
              sendSlackMessage: async (params) =>
                replyHandler(
                  {
                    platform: 'slack',
                    accountId: params.accountId,
                    platformChannelId: params.channelId,
                    threadId: params.threadTs,
                  },
                  params.message,
                ),
            });
            break;
          }
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
