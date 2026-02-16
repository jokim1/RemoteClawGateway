# ClawTalkGateway

An [OpenClaw](https://github.com/jokim1/openclaw) plugin that powers [ClawTalk](https://github.com/jokim1/ClawTalk) (terminal) and [ClawTalkMobile](https://github.com/jokim1/ClawTalkMobile) (iOS).

Built by [Claude Opus 4.5](https://anthropic.com), [Claude Opus 4.6](https://anthropic.com), and [Joseph Kim](https://github.com/jokim1).

This plugin runs on your server alongside OpenClaw. It adds HTTP endpoints that ClawTalk clients use to discover providers, track rate limits, manage conversations (Talks), run scheduled jobs, and do voice input/output. Your API keys stay on the server — clients never see them.

## What it does

- **`/api/providers`** — lists available LLM providers and billing info
- **`/api/rate-limits`** — reports usage and rate-limit data for subscription plans (e.g. Anthropic Max)
- **`/api/talks`** — persistent conversation management (create, list, update, delete)
- **`/api/talks/:id/chat`** — talk-aware chat with context injection and system prompts
- **`/api/talks/:id/jobs`** — talk jobs (event, one-off, and recurring)
- **`/api/events/slack`** — Slack ingress ownership + async Talk response pipeline
- **`/api/voice/capabilities`** — reports whether speech-to-text and text-to-speech are available
- **`/api/voice/transcribe`** — accepts audio, returns transcribed text (OpenAI Whisper, Deepgram, or Groq)
- **`/api/voice/synthesize`** — accepts text, returns spoken audio (OpenAI TTS, Cartesia, or ElevenLabs)
- **`/api/voice/stream`** — WebSocket endpoint for live voice mode
- **`/api/realtime-voice/stream`** — real-time voice conversation (OpenAI, Cartesia+Deepgram, ElevenLabs, Gemini)
- **`/api/pair`** — lets ClawTalkMobile auto-configure by exchanging a pairing password for the full gateway config (disabled by default)

## Setup

### Step 1: Install the plugin

Copy or clone this repo into your OpenClaw plugins directory:

```bash
cd /path/to/openclaw/plugins
git clone https://github.com/jokim1/ClawTalkGateway.git remoteclaw
cd remoteclaw
npm install
npm run build
```

Then restart OpenClaw. You should see `RemoteClaw plugin loaded` in the logs.

### Step 2: Set an auth token (recommended)

If your server is accessible over the network, set a token so only you can use the endpoints.

Either set it in your OpenClaw config:

```yaml
gateway:
  auth:
    token: "pick-a-strong-random-token"
```

Or set an environment variable:

```bash
export CLAWDBOT_GATEWAY_TOKEN="pick-a-strong-random-token"
```

If no token is set, the plugin only allows requests from localhost (127.0.0.1 / ::1).

Use this same token when configuring ClawTalk on your local machine:

```bash
clawtalk config --gateway http://your-server:18789 --token pick-a-strong-random-token
```

### Step 3: Enable voice (optional)

Voice features are auto-detected from environment variables. Set the API keys for the providers you want to use:

**Speech-to-text (STT):**

| Provider | Env var | Notes |
|----------|---------|-------|
| OpenAI Whisper | `OPENAI_API_KEY` | Default STT provider |
| Deepgram | `DEEPGRAM_API_KEY` | Alternative STT |
| Groq | `GROQ_API_KEY` | Alternative STT |

**Text-to-speech (TTS):**

| Provider | Env var | Notes |
|----------|---------|-------|
| OpenAI TTS | `OPENAI_API_KEY` | Default TTS provider |
| Cartesia | `CARTESIA_API_KEY` | Alternative TTS |
| ElevenLabs | `ELEVENLABS_API_KEY` | Alternative TTS |

**Real-time voice (live conversation):**

| Provider | Env var(s) | Notes |
|----------|------------|-------|
| OpenAI | `OPENAI_API_KEY` | Default realtime provider |
| Cartesia + Deepgram | `CARTESIA_API_KEY` + `DEEPGRAM_API_KEY` | Both required |
| ElevenLabs | `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` | Both required |
| Gemini | `GOOGLE_API_KEY` or `GEMINI_API_KEY` | |

At minimum, set `OPENAI_API_KEY` to get basic voice working:

```bash
export OPENAI_API_KEY="sk-..."
```

The plugin auto-detects which keys are present and enables the corresponding providers. ClawTalk discovers voice support automatically.

You can customize the default voice models in your OpenClaw plugin config:

```yaml
plugins:
  remoteclaw:
    voice:
      stt:
        model: "whisper-1"       # default
      tts:
        model: "tts-1"           # default
        defaultVoice: "nova"     # default (options: alloy, echo, fable, onyx, nova, shimmer)
```

### Step 4: Configure provider billing (optional)

If you're on a subscription plan (e.g. Anthropic Max), tell the plugin so ClawTalk can show rate-limit bars instead of per-token pricing:

```yaml
plugins:
  remoteclaw:
    providers:
      anthropic:
        billing: "subscription"
        plan: "Max Pro"
        monthlyPrice: 200
      deepseek:
        billing: "api"
```

### Step 5: Enable ClawTalkMobile pairing (optional)

If you use [ClawTalkMobile](https://github.com/jokim1/ClawTalkMobile) (the iOS app), you can enable a pairing flow so new devices only need your server's Tailscale IP and a password — no manual token or URL entry.

Set a pairing password in your OpenClaw plugin config:

```yaml
plugins:
  remoteclaw:
    pairPassword: "pick-a-secret"
    name: "Home Server"           # optional — friendly name shown in the app
    externalUrl: "https://myhost.tail1234.ts.net"  # optional — see below
```

Or use an environment variable instead:

```bash
export CLAWDBOT_PAIR_PASSWORD="pick-a-secret"
```

**How it works:** The user opens ClawTalkMobile, taps Add Gateway, enters the server IP and the pairing password, and taps Connect. The gateway validates the password, then returns the full config (URL, auth token, agent ID). The app fills everything in automatically.

**`externalUrl`** — By default, the pairing response uses the URL the client connected to. Set `externalUrl` if you want clients to use a different address long-term, e.g. a Tailscale Funnel hostname (`https://myhost.tail1234.ts.net`) even when pairing happens over a direct Tailscale IP.

**Security:**
- The endpoint is **disabled by default**. It only activates when `pairPassword` is set.
- Passwords are compared using timing-safe equality.
- Rate limited to 5 attempts per IP per minute.

**Don't use ClawTalkMobile?** You don't need to do anything. Without a `pairPassword`, the `/api/pair` endpoint returns 404 and is invisible to clients.

## How it all fits together

```
Your machines                      Your server
┌──────────────┐                  ┌──────────────────────────────────┐
│  ClawTalk     │                 │  OpenClaw                         │
│  (terminal)   │───── HTTP ─────▶│  ├── /v1/chat/completions         │ ← chat (built into OpenClaw)
│               │                 │  ├── /v1/models                   │ ← model list (built in)
└──────────────┘                  │  │                                 │
                                  │  └── ClawTalkGateway plugin        │ ← this repo
┌──────────────┐                  │      ├── /api/pair                 │ ← mobile pairing (opt-in)
│  ClawTalkMobile│                │      ├── /api/providers            │
│  (iOS)        │───── HTTP ─────▶│      ├── /api/rate-limits          │
│               │                 │      ├── /api/talks                │ ← conversation management
└──────────────┘                  │      ├── /api/voice/*              │ ← voice I/O
                                  │      └── /api/realtime-voice/*     │ ← real-time voice
                                  └──────────────────────────────────┘
```

OpenClaw handles chat and model routing. This plugin adds the extra endpoints that ClawTalk clients need for provider info, rate limits, voice, conversations, and mobile pairing.

## API reference

All endpoints require authentication (bearer token or localhost) unless noted.

### GET /api/providers

Returns the list of configured LLM providers with billing info.

```json
{
  "providers": [
    { "id": "anthropic", "billing": { "mode": "subscription", "plan": "Max Pro", "monthlyPrice": 200 } },
    { "id": "deepseek", "billing": { "mode": "api" } },
    { "id": "openai", "billing": { "mode": "api" } }
  ]
}
```

Providers are auto-detected from OpenClaw's config and environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`).

### GET /api/rate-limits

Returns usage data for all providers. Optionally filter with `?provider=anthropic`.

```json
{
  "rateLimits": [
    {
      "provider": "anthropic",
      "session": { "used": 45, "limit": 100, "resetsAt": "2025-01-15T12:00:00.000Z" },
      "weekly": { "used": 12, "limit": 100, "resetsAt": "2025-01-20T00:00:00.000Z" }
    }
  ]
}
```

### Talks API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST /api/talks` | Create a new Talk |
| `GET /api/talks` | List all Talks |
| `PATCH /api/talks/:id` | Update Talk metadata (title, objective, model, directives, platform bindings) |
| `DELETE /api/talks/:id` | Delete a Talk |
| `GET /api/talks/:id/messages` | Get Talk message history |
| `POST /api/talks/:id/chat` | Send a message with Talk context |
| `POST /api/talks/:id/pin/:msgId` | Pin a message |
| `DELETE /api/talks/:id/pin/:msgId` | Unpin a message |
| `POST /api/talks/:id/jobs` | Create a Talk job (`on` event, one-off, or recurring) |
| `GET /api/talks/:id/jobs` | List jobs for a Talk |
| `PATCH /api/talks/:id/jobs/:jobId` | Update a job |
| `DELETE /api/talks/:id/jobs/:jobId` | Delete a job |
| `GET /api/talks/:id/reports` | Get job execution reports |
| `POST /api/events/slack` | Slack event claim/queue endpoint (backward-compatible manual ingress) |

#### Slack ingress env controls

- `CLAWTALK_INGRESS_RETRY_ATTEMPTS` (default `3`) — max processing attempts per claimed event.
- `CLAWTALK_INGRESS_RETRY_BASE_MS` (default `1000`) — base backoff for retries.
- `CLAWTALK_INGRESS_NOTIFY_FAILURE` (default `1`) — set `0` to suppress terminal failure notice message in Slack.
- `CLAWTALK_INGRESS_MAX_QUEUE` (default `1000`) — max in-memory queued Slack events before gateway returns `decision=pass`.
- `CLAWTALK_INGRESS_SUPPRESS_TTL_MS` (default `120000`) — suppression lease TTL for blocking OpenClaw outbound after a claim.
- `CLAWTALK_INGRESS_SUPPRESS_MAX_CANCELS` (default `3`) — max OpenClaw outbound sends canceled per claimed event.

### Voice endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET /api/voice/capabilities` | Voice feature availability |
| `POST /api/voice/transcribe` | Speech-to-text (multipart audio upload) |
| `POST /api/voice/synthesize` | Text-to-speech (returns audio/mpeg) |
| `GET /api/voice/stream` | WebSocket live voice mode |
| `POST /api/voice/stt/provider` | Switch STT provider |
| `POST /api/voice/tts/provider` | Switch TTS provider |
| `GET /api/realtime-voice/capabilities` | Real-time voice support info |
| `GET /api/realtime-voice/stream` | WebSocket real-time voice |

### POST /api/pair

Exchange a pairing password for the full gateway config. **Does not require bearer auth** — authentication is via the pairing password itself. Disabled (returns 404) unless `pairPassword` is configured.

- **Content-Type**: `application/json`
- **Body**: `{ "password": "your-pair-password" }`

```json
{
  "name": "Home Server",
  "gatewayURL": "http://100.64.0.1:18789",
  "port": 18789,
  "authToken": "your-gateway-token",
  "agentID": "mobileclaw"
}
```

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Missing password or bad JSON |
| 403 | Wrong password |
| 404 | Pairing not configured |
| 429 | Rate limited (5 attempts/min per IP) |

## Authentication

The plugin checks requests in this order:

1. If a token is configured (via config or `CLAWDBOT_GATEWAY_TOKEN` env var), the request must include `Authorization: Bearer <token>`
2. If no token is configured, only localhost requests are allowed

**Exception:** `/api/pair` does not use bearer auth. It authenticates via the pairing password in the request body, and is disabled entirely unless `pairPassword` is configured.

Token comparison uses timing-safe equality to prevent timing attacks.

## Requirements

- **Node.js 20+**
- **OpenClaw** running on the same machine
- **LLM provider API keys** — set on the server as env vars. The plugin auto-detects which are present:
  - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`
- **Voice API keys** (optional) — see [Step 3: Enable voice](#step-3-enable-voice-optional) for the full list

## Related projects

- **[ClawTalk](https://github.com/jokim1/ClawTalk)** — Terminal TUI client
- **[ClawTalkMobile](https://github.com/jokim1/ClawTalkMobile)** — iOS client
- **[OpenClaw](https://github.com/jokim1/openclaw)** — The host server

## Development

```bash
npm install
npm run build
npm run dev    # watch mode
npm test       # run tests
```

## License

MIT
