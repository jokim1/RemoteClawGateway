/**
 * Slack Event Proxy — Gateway as the Slack Events API entry point.
 *
 * Instead of OpenClaw receiving Slack events and asking Gateway whether to hand
 * them off, Gateway receives ALL Slack events first and decides:
 *   - ClawTalk-owned channels → process via the existing ingress pipeline
 *   - Everything else → forward the raw event to OpenClaw's HTTP webhook
 *
 * This eliminates the need for any code changes in OpenClaw. The only
 * requirement is that OpenClaw runs Slack in HTTP mode so it can receive
 * forwarded events from Gateway.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
// @ts-ignore — undici types not installed; available at runtime via Node.js
import { request as undiciRequest } from 'undici';
import type { TalkStore } from './talk-store.js';
import type { Logger } from './types.js';
import {
  inspectSlackOwnership,
  routeSlackIngressEvent,
  parseSlackIngressEvent,
} from './slack-ingress.js';
import type { SlackIngressDeps } from './slack-ingress.js';
import { sendJson } from './http.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlackEventProxyDeps = {
  store: TalkStore;
  logger: Logger;
  getConfig: () => Record<string, unknown>;
  /** Full URL of OpenClaw's Slack HTTP webhook, e.g. http://127.0.0.1:3000/slack/events */
  openclawWebhookUrl: string;
  /** Build the deps object needed by routeSlackIngressEvent */
  buildIngressDeps: () => SlackIngressDeps;
};

type SlackEventsApiPayload = {
  token?: string;
  type: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: {
    type: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    event_ts?: string;
    files?: unknown[];
  };
  event_id?: string;
  event_time?: number;
};

// ---------------------------------------------------------------------------
// Slack request signature verification
// ---------------------------------------------------------------------------

const SLACK_SIGNATURE_VERSION = 'v0';
const SLACK_TIMESTAMP_TOLERANCE_S = 60 * 5; // 5 minutes

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: Buffer,
  signature: string,
): boolean {
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SLACK_TIMESTAMP_TOLERANCE_S) return false;

  const sigBasestring = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody.toString('utf-8')}`;
  const mySignature = `${SLACK_SIGNATURE_VERSION}=` +
    createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  if (mySignature.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
}

// ---------------------------------------------------------------------------
// Raw body reader (preserves bytes for signature verification)
// ---------------------------------------------------------------------------

function readRawBody(req: IncomingMessage, maxBytes = 512 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Config resolution helpers
// ---------------------------------------------------------------------------

export function resolveSlackSigningSecret(cfg: Record<string, unknown>): string | undefined {
  const envSecret = process.env.GATEWAY_SLACK_SIGNING_SECRET?.trim()
    || process.env.SLACK_SIGNING_SECRET?.trim();
  if (envSecret) return envSecret;

  const gw = cfg.gateway && typeof cfg.gateway === 'object'
    ? cfg.gateway as Record<string, unknown> : null;
  const gwSlack = gw?.slack && typeof gw.slack === 'object'
    ? gw.slack as Record<string, unknown> : null;
  const gwSecret = gwSlack?.signingSecret;
  if (typeof gwSecret === 'string' && gwSecret.trim()) return gwSecret.trim();

  const channels = cfg.channels && typeof cfg.channels === 'object'
    ? cfg.channels as Record<string, unknown> : null;
  const chSlack = channels?.slack && typeof channels.slack === 'object'
    ? channels.slack as Record<string, unknown> : null;
  const chSecret = chSlack?.signingSecret;
  if (typeof chSecret === 'string' && chSecret.trim()) return chSecret.trim();

  const accounts = chSlack?.accounts;
  if (accounts && typeof accounts === 'object') {
    for (const acc of Object.values(accounts as Record<string, unknown>)) {
      if (acc && typeof acc === 'object') {
        const s = (acc as Record<string, unknown>).signingSecret;
        if (typeof s === 'string' && s.trim()) return s.trim();
      }
    }
  }

  return undefined;
}

export function resolveOpenClawWebhookUrl(cfg: Record<string, unknown>): string {
  const envUrl = process.env.GATEWAY_SLACK_OPENCLAW_WEBHOOK_URL?.trim();
  if (envUrl) return envUrl;

  const gw = cfg.gateway && typeof cfg.gateway === 'object'
    ? cfg.gateway as Record<string, unknown> : null;
  const gwSlack = gw?.slack && typeof gw.slack === 'object'
    ? gw.slack as Record<string, unknown> : null;
  const cfgUrl = gwSlack?.openclawWebhookUrl;
  if (typeof cfgUrl === 'string' && cfgUrl.trim()) return cfgUrl.trim();

  const openclawPort = process.env.OPENCLAW_HTTP_PORT?.trim() || '3000';
  return `http://127.0.0.1:${openclawPort}/slack/events`;
}

// ---------------------------------------------------------------------------
// Convert raw Slack Events API payload to SlackIngressEvent body
// ---------------------------------------------------------------------------

function buildEventIdFromSlack(payload: SlackEventsApiPayload): string {
  const evt = payload.event;
  if (!evt) return `slack:unknown:${Date.now()}`;
  const channelId = evt.channel ?? 'unknown';
  const ts = evt.ts ?? evt.event_ts ?? String(Date.now());
  return `slack:default:${channelId}:${ts}`;
}

function slackPayloadToIngressBody(payload: SlackEventsApiPayload): Record<string, unknown> | null {
  const evt = payload.event;
  if (!evt?.channel || !evt?.text) return null;

  return {
    eventId: buildEventIdFromSlack(payload),
    accountId: 'default',
    channelId: evt.channel,
    threadTs: evt.thread_ts,
    messageTs: evt.ts,
    userId: evt.user,
    text: evt.text,
  };
}

// ---------------------------------------------------------------------------
// Forward raw Slack event to OpenClaw's HTTP webhook
// ---------------------------------------------------------------------------

async function forwardToOpenClaw(
  rawBody: Buffer,
  originalHeaders: Record<string, string>,
  openclawUrl: string,
  logger: Logger,
): Promise<{ status: number; body: unknown }> {
  try {
    const resp = await undiciRequest(openclawUrl, {
      method: 'POST',
      headers: {
        'content-type': originalHeaders['content-type'] || 'application/json',
        'x-slack-signature': originalHeaders['x-slack-signature'] || '',
        'x-slack-request-timestamp': originalHeaders['x-slack-request-timestamp'] || '',
      },
      body: rawBody,
      headersTimeout: 10_000,
      bodyTimeout: 30_000,
    });
    const text = await resp.body.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: resp.statusCode, body };
  } catch (err) {
    logger.warn(
      `SlackEventProxy: failed to forward to OpenClaw at ${openclawUrl}: ${String(err)}`,
    );
    return { status: 502, body: { error: 'Failed to reach OpenClaw' } };
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleSlackEventProxy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SlackEventProxyDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // 1. Read raw body (preserve bytes for signature verification + forwarding)
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch {
    sendJson(res, 400, { error: 'Failed to read request body' });
    return;
  }

  // 2. Verify Slack request signature
  const cfg = deps.getConfig();
  const signingSecret = resolveSlackSigningSecret(cfg);
  if (!signingSecret) {
    deps.logger.warn('SlackEventProxy: no signing secret configured — rejecting request');
    sendJson(res, 500, { error: 'Slack signing secret not configured' });
    return;
  }

  const slackSignature = (req.headers['x-slack-signature'] as string) ?? '';
  const slackTimestamp = (req.headers['x-slack-request-timestamp'] as string) ?? '';
  if (!verifySlackSignature(signingSecret, slackTimestamp, rawBody, slackSignature)) {
    deps.logger.warn('SlackEventProxy: invalid Slack signature — rejecting request');
    sendJson(res, 401, { error: 'Invalid Slack signature' });
    return;
  }

  // 3. Parse JSON payload
  let payload: SlackEventsApiPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8')) as SlackEventsApiPayload;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  // 4. Handle Slack URL verification challenge
  if (payload.type === 'url_verification') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ challenge: payload.challenge }));
    return;
  }

  const originalHeaders: Record<string, string> = {
    'content-type': (req.headers['content-type'] as string) ?? 'application/json',
    'x-slack-signature': slackSignature,
    'x-slack-request-timestamp': slackTimestamp,
  };

  // 5. Only route event_callback payloads; forward everything else to OpenClaw
  if (payload.type !== 'event_callback') {
    void forwardToOpenClaw(rawBody, originalHeaders, deps.openclawWebhookUrl, deps.logger);
    sendJson(res, 200, { ok: true, forwarded: true });
    return;
  }

  // 6. Skip bot messages to prevent reply loops
  if (payload.event?.bot_id || payload.event?.subtype === 'bot_message') {
    // Still forward to OpenClaw — it may have bot-message handling
    void forwardToOpenClaw(rawBody, originalHeaders, deps.openclawWebhookUrl, deps.logger);
    sendJson(res, 200, { ok: true, skipped: 'bot_message' });
    return;
  }

  // 7. Routing decision for message/mention events
  const eventType = payload.event?.type;
  const isMessage = eventType === 'message' || eventType === 'app_mention';

  if (isMessage && payload.event?.channel) {
    // Check if any ClawTalk Talk owns this channel
    const minimalEvent = {
      eventId: buildEventIdFromSlack(payload),
      channelId: payload.event.channel,
      accountId: 'default',
      text: payload.event.text ?? '',
    };

    const ownership = inspectSlackOwnership(minimalEvent, deps.store, deps.logger);

    if (ownership.decision === 'handled' && ownership.talkId) {
      // ── ClawTalk owns this message ──
      deps.logger.info(
        `SlackEventProxy: routing to ClawTalk talk=${ownership.talkId} ` +
        `channel=${payload.event.channel} event_id=${payload.event_id}`,
      );

      // Ack to Slack immediately (must respond within 3 seconds)
      sendJson(res, 200, { ok: true, routed: 'clawtalk', talkId: ownership.talkId });

      // Feed into the existing ingress pipeline (async, non-blocking)
      const ingressBody = slackPayloadToIngressBody(payload);
      if (ingressBody) {
        const parsed = parseSlackIngressEvent(ingressBody);
        if (parsed) {
          try {
            const ingressDeps = deps.buildIngressDeps();
            routeSlackIngressEvent(parsed, ingressDeps);
          } catch (err) {
            deps.logger.warn(
              `SlackEventProxy: ingress routing error for event_id=${payload.event_id}: ${String(err)}`,
            );
          }
        }
      }
      return;
    }
  }

  // ── Not ClawTalk-owned or not a message event → forward to OpenClaw ──
  deps.logger.debug(
    `SlackEventProxy: forwarding to OpenClaw event_type=${eventType ?? 'unknown'} ` +
    `channel=${payload.event?.channel ?? '-'} event_id=${payload.event_id ?? '-'}`,
  );

  // Fire-and-forget forward; ack Slack immediately
  void forwardToOpenClaw(rawBody, originalHeaders, deps.openclawWebhookUrl, deps.logger);
  sendJson(res, 200, { ok: true, routed: 'openclaw' });
}
