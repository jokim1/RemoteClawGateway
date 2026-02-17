# ClawTalkGateway

OpenClaw plugin that adds HTTP endpoints for ClawTalk (terminal client) and ClawTalkMobile (iOS app). Provides provider discovery, rate-limit tracking, voice I/O, Talks (persistent conversations), scheduled jobs, and mobile pairing. API keys stay on the server.

## Source Files

```
src/
  index.ts            Plugin entry, route dispatch, rate limiter, pairing handler, Tailscale detection
  types.ts            TypeScript interfaces (PluginApi, RemoteClawPluginConfig, HandlerContext, etc.)
  http.ts             Utilities: sendJson(), readJsonBody(), handleCors()
  auth.ts             Bearer token auth, localhost fallback, timing-safe compare, resolveGatewayToken()
  providers.ts        GET /api/providers — auto-detect configured LLM providers + billing overrides
  rate-limits.ts      GET /api/rate-limits — usage from OpenClaw internals or proxy-captured headers
  proxy.ts            HTTP proxy on port 18793 capturing Anthropic rate-limit headers
  voice.ts            Voice endpoints: capabilities, transcribe (multi-provider STT), synthesize (multi-provider TTS)
  voice-stream.ts     WebSocket live voice streaming
  realtime-voice.ts   Real-time voice conversation (OpenAI, Cartesia+Deepgram, ElevenLabs, Gemini)
  talks.ts            Talks route handler — CRUD, messages, pins, jobs
  talk-store.ts       File-based persistent storage for Talks (~/.moltbot/plugins/remoteclaw/)
  talk-chat.ts        Talk-aware chat with context injection and system prompts
  system-prompt.ts    Composes system prompts from Talk metadata, context, pins, and jobs
  context-updater.ts  Updates Talk context markdown after new messages
  job-scheduler.ts    Cron-based job scheduler — checks every 60s, runs due jobs with full Talk context
```

## Routes

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/api/pair` | Pairing password (rate-limited) | index.ts |
| GET | `/api/providers` | Bearer token | providers.ts |
| GET | `/api/rate-limits` | Bearer token | rate-limits.ts |
| GET | `/api/voice/capabilities` | Bearer token | voice.ts |
| POST | `/api/voice/transcribe` | Bearer token | voice.ts |
| POST | `/api/voice/synthesize` | Bearer token | voice.ts |
| POST | `/api/voice/stt/provider` | Bearer token | voice.ts |
| POST | `/api/voice/tts/provider` | Bearer token | voice.ts |
| GET | `/api/voice/stream` | Bearer token | voice-stream.ts |
| GET | `/api/realtime-voice/capabilities` | Bearer token | realtime-voice.ts |
| GET | `/api/realtime-voice/stream` | Bearer token | realtime-voice.ts |
| POST | `/api/talks` | Bearer token | talks.ts |
| GET | `/api/talks` | Bearer token | talks.ts |
| GET | `/api/talks/:id` | Bearer token | talks.ts |
| PATCH | `/api/talks/:id` | Bearer token | talks.ts |
| DELETE | `/api/talks/:id` | Bearer token | talks.ts |
| GET | `/api/talks/:id/messages` | Bearer token | talks.ts |
| POST | `/api/talks/:id/chat` | Bearer token | talk-chat.ts |
| POST | `/api/talks/:id/pin` | Bearer token | talks.ts |
| DELETE | `/api/talks/:id/pin/:msgId` | Bearer token | talks.ts |
| POST | `/api/talks/:id/jobs` | Bearer token | talks.ts |
| GET | `/api/talks/:id/jobs` | Bearer token | talks.ts |
| PATCH | `/api/talks/:id/jobs/:jobId` | Bearer token | talks.ts |
| DELETE | `/api/talks/:id/jobs/:jobId` | Bearer token | talks.ts |
| GET | `/api/talks/:id/reports` | Bearer token | talks.ts |

## Auth

- If `CLAWDBOT_GATEWAY_TOKEN` or `config.gateway.auth.token` is set: requires `Authorization: Bearer <token>`
- If no token configured: only allows localhost (127.0.0.1 / ::1)
- Exception: `/api/pair` authenticates via password in request body, not bearer token

## Pairing

Disabled by default. Enabled when `pairPassword` is set (config or `CLAWDBOT_PAIR_PASSWORD` env var).

Flow: ClawTalkMobile sends `POST /api/pair` with `{"password":"..."}` → gateway returns `{name, gatewayURL, port, authToken, agentID}`.

- Rate limited: 5 attempts per IP per 60s, cleanup every 5 min
- Timing-safe password comparison
- Auto-detects Tailscale Funnel URL via `tailscale status --json` for HTTPS gatewayURL
- Falls back to `externalUrl` config or request Host header

## Plugin Config (moltbot.plugin.json)

```yaml
plugins:
  remoteclaw:
    pairPassword: "secret"          # Enables /api/pair
    externalUrl: "https://..."      # Override gateway URL in pair response
    name: "Home Server"             # Friendly name in pair response
    proxyPort: 18793                # Rate-limit capture proxy port
    providers:
      anthropic:
        billing: "subscription"
        plan: "Max Pro"
        monthlyPrice: 200
    voice:
      stt: { model: "whisper-1" }
      tts: { model: "tts-1", defaultVoice: "nova" }
```

## Build

```bash
npm install
npm run build    # tsc → dist/
npm run dev      # tsc --watch
npm test         # run tests
```

Requires Node 20+. Voice features require at minimum `OPENAI_API_KEY`.

## Execution Modes

Each Talk has an `executionMode` that controls how chat requests are routed through OpenClaw:

- **`openclaw`** (default) — Session key uses `agent:<agentId>:` prefix, which activates OpenClaw's embedded agent. OpenClaw replaces the gateway's tools array with its own (Read, Write, exec). The `x-openclaw-agent-id` header is sent. Gateway-installed tools are not callable.
- **`full_control`** — Session key uses `talk:clawtalk:talk:<id>:chat` prefix (no `agent:` prefix), bypassing OpenClaw's agent. The gateway acts as a transparent LLM proxy. Gateway-installed tools (google_docs_append, etc.) are callable. The `x-openclaw-agent-id` header is suppressed; model routing uses the `model` param instead.

Session key construction lives in `talk-chat.ts`: `buildTalkSessionKey()` for openclaw, `buildFullControlTalkSessionKey()` for full_control.

Job scheduler always uses `job:` prefix session keys (`buildTalkJobSessionKey()`) regardless of execution mode — jobs run in transparent proxy mode.

Old values (`inherit`, `sandboxed`, `unsandboxed`) are lazily migrated on load in `talk-store.ts` and accepted from stale clients in `talks.ts`.

## Key Patterns

- Plugin registers via `api.registerHttpHandler()` returning `boolean` (true = handled)
- Handler context (`HandlerContext`) bundles req/res/url/cfg/pluginCfg/logger
- Rate-limit data: tries OpenClaw's internal `loadProviderUsageSummary()` (dynamic import), falls back to proxy-captured Anthropic headers
- Proxy runs as singleton with hot-reload guard to prevent double-binding
- All intervals use `.unref()` to avoid blocking process exit
- Talk data stored as flat files under `~/.moltbot/plugins/remoteclaw/talks/<id>/`

## Related Projects

- **ClawTalk** — Terminal TUI client
- **ClawTalkMobile** — iOS client
- **OpenClaw** — The host server this plugin extends
