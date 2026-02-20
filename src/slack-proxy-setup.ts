/**
 * Slack Event Proxy — Setup detection and guided onboarding.
 *
 * Checks whether the Slack Event Proxy is fully configured and provides
 * clear, actionable instructions when setup steps are missing.
 */

import type { TalkStore } from './talk-store.js';
import type { Logger, PlatformBinding } from './types.js';
import { resolveSlackSigningSecret, resolveOpenClawWebhookUrl } from './slack-event-proxy.js';

// ---------------------------------------------------------------------------
// Setup status types
// ---------------------------------------------------------------------------

export type SlackProxySetupStatus = {
  ready: boolean;
  slackBindingsDetected: boolean;
  signingSecretConfigured: boolean;
  openclawWebhookUrl: string;
  gatewayProxyUrl: string;
  /** Steps the user still needs to complete. Empty when fully configured. */
  pendingSteps: SlackProxySetupStep[];
};

export type SlackProxySetupStep = {
  id: string;
  title: string;
  instructions: string;
  url?: string;
};

// ---------------------------------------------------------------------------
// Detect Slack bindings in Talks
// ---------------------------------------------------------------------------

function isWritePermission(permission: PlatformBinding['permission']): boolean {
  return permission === 'write' || permission === 'read+write';
}

function talksHaveSlackBindings(store: TalkStore): boolean {
  for (const talk of store.listTalks()) {
    for (const binding of talk.platformBindings ?? []) {
      if (binding.platform.trim().toLowerCase() === 'slack' && isWritePermission(binding.permission)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resolve Gateway proxy URL from config/env
// ---------------------------------------------------------------------------

function resolveGatewayProxyUrl(cfg: Record<string, unknown>): string {
  // If there's an explicit external URL configured, use that
  const envUrl = process.env.CLAWTALK_SLACK_PROXY_URL?.trim();
  if (envUrl) return envUrl;

  const gw = cfg.gateway && typeof cfg.gateway === 'object'
    ? cfg.gateway as Record<string, unknown> : null;
  const gwSlack = gw?.slack && typeof gw.slack === 'object'
    ? gw.slack as Record<string, unknown> : null;
  const cfgUrl = gwSlack?.proxyUrl;
  if (typeof cfgUrl === 'string' && cfgUrl.trim()) return cfgUrl.trim();

  // Default: local address
  const gwHttp = gw?.http && typeof gw.http === 'object'
    ? gw.http as Record<string, unknown> : null;
  const port = typeof gwHttp?.port === 'number' ? gwHttp.port : 18789;
  return `http://127.0.0.1:${port}/slack/events`;
}

// ---------------------------------------------------------------------------
// Main setup check
// ---------------------------------------------------------------------------

export function checkSlackProxySetup(
  store: TalkStore,
  cfg: Record<string, unknown>,
): SlackProxySetupStatus {
  const hasSlackBindings = talksHaveSlackBindings(store);
  const signingSecret = resolveSlackSigningSecret(cfg);
  const signingSecretConfigured = !!signingSecret;
  const openclawWebhookUrl = resolveOpenClawWebhookUrl(cfg);
  const gatewayProxyUrl = resolveGatewayProxyUrl(cfg);

  const pendingSteps: SlackProxySetupStep[] = [];

  if (hasSlackBindings) {
    if (!signingSecretConfigured) {
      pendingSteps.push({
        id: 'signing_secret',
        title: 'Set your Slack Signing Secret',
        instructions: [
          '1. Go to https://api.slack.com/apps and select your app',
          '2. Click "Basic Information" in the sidebar',
          '3. Scroll to "App Credentials" and copy the "Signing Secret"',
          '4. Set it as an environment variable:',
          '',
          '   export SLACK_SIGNING_SECRET=<your-signing-secret>',
          '',
          '   Or add to openclaw.json:',
          '   { "channels": { "slack": { "signingSecret": "<your-signing-secret>" } } }',
        ].join('\n'),
        url: 'https://api.slack.com/apps',
      });
    }

    pendingSteps.push({
      id: 'request_url',
      title: 'Update your Slack app Request URL',
      instructions: [
        '1. Go to https://api.slack.com/apps and select your app',
        '2. Click "Event Subscriptions" in the sidebar',
        '3. Enable Events if not already enabled',
        `4. Set the Request URL to your Gateway's external address:`,
        '',
        `   ${gatewayProxyUrl}`,
        '',
        '   If running locally, use ngrok or a similar tunnel:',
        '   ngrok http 18789',
        '   Then use the ngrok URL + /slack/events as the Request URL.',
        '',
        '5. Slack will send a verification challenge — Gateway handles this automatically.',
        '6. Click "Save Changes"',
      ].join('\n'),
      url: 'https://api.slack.com/apps',
    });
  }

  return {
    ready: hasSlackBindings && signingSecretConfigured && pendingSteps.length <= 1,
    slackBindingsDetected: hasSlackBindings,
    signingSecretConfigured,
    openclawWebhookUrl,
    gatewayProxyUrl,
    pendingSteps,
  };
}

// ---------------------------------------------------------------------------
// Startup log — prints setup status and instructions to the console
// ---------------------------------------------------------------------------

const DIVIDER = '─'.repeat(68);

export function logSlackProxySetupStatus(
  store: TalkStore,
  cfg: Record<string, unknown>,
  logger: Logger,
): SlackProxySetupStatus {
  const status = checkSlackProxySetup(store, cfg);

  if (!status.slackBindingsDetected) {
    logger.debug('ClawTalk: no Slack bindings detected — Slack event proxy not needed');
    return status;
  }

  if (status.pendingSteps.length === 0) {
    logger.info('ClawTalk: Slack event proxy is fully configured ✓');
    return status;
  }

  // Count only the steps that are truly pending (request_url is always shown as info)
  const blockers = status.pendingSteps.filter(s => s.id !== 'request_url');
  if (blockers.length === 0 && status.signingSecretConfigured) {
    logger.info(
      `ClawTalk: Slack event proxy ready — ensure your Slack app Request URL points to: ${status.gatewayProxyUrl}`,
    );
    return status;
  }

  logger.warn('');
  logger.warn(DIVIDER);
  logger.warn('  ClawTalk Slack Event Proxy — Setup Required');
  logger.warn(DIVIDER);
  logger.warn('');
  logger.warn(
    '  Talks with Slack bindings were detected. To route Slack messages',
  );
  logger.warn(
    '  through ClawTalk, complete the following setup steps:',
  );
  logger.warn('');

  for (let i = 0; i < status.pendingSteps.length; i++) {
    const step = status.pendingSteps[i];
    const prefix = `  Step ${i + 1}: `;
    logger.warn(`${prefix}${step.title}`);
    logger.warn('');
    for (const line of step.instructions.split('\n')) {
      logger.warn(`    ${line}`);
    }
    logger.warn('');
  }

  logger.warn(DIVIDER);
  logger.warn(
    '  Setup status: GET /api/events/slack/proxy-setup',
  );
  logger.warn(DIVIDER);
  logger.warn('');

  return status;
}
