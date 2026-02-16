/**
 * Plugin Commands
 *
 * Registers OpenClaw plugin commands for ClawTalk management.
 * These commands are available via the OpenClaw command system.
 */

import type { PluginApi } from './types.js';
import type { TalkStore } from './talk-store.js';
import { getSlackIngressTalkRuntimeSnapshot } from './slack-ingress.js';

export function registerCommands(api: PluginApi, talkStore: TalkStore): void {
  // /talks — list active talks
  api.registerCommand({
    name: 'talks',
    description: 'List active talks with IDs, model, and activity',
    usage: '/talks',
    handler: (ctx) => {
      const talks = talkStore.listTalks();
      if (talks.length === 0) {
        ctx.reply('No active talks.');
        return;
      }

      const lines = talks.map((t, i) => {
        const title = t.topicTitle || '(untitled)';
        const model = t.model || 'default';
        const age = formatAge(t.updatedAt);
        const jobCount = t.jobs.filter(j => j.active).length;
        const pinCount = t.pinnedMessageIds.length;
        const extras: string[] = [];
        if (jobCount > 0) extras.push(`${jobCount} job${jobCount > 1 ? 's' : ''}`);
        if (pinCount > 0) extras.push(`${pinCount} pin${pinCount > 1 ? 's' : ''}`);
        const extrasStr = extras.length > 0 ? ` [${extras.join(', ')}]` : '';
        return `  ${i + 1}. ${title} (${model}) — ${age}${extrasStr}`;
      });

      ctx.reply(`Active talks (${talks.length}):\n${lines.join('\n')}`);
    },
  });

  // /talk-status <id> — show talk metadata
  api.registerCommand({
    name: 'talk-status',
    description: 'Show delivery health and metadata for one talk',
    usage: '/talk-status <talk-id>  (example: /talk-status 6f7ac93e-78ac-45a9-8f78-c5976838edb7)',
    handler: async (ctx) => {
      const talkId = ctx.args[0];
      if (!talkId) {
        ctx.reply('Usage: /talk-status <talk-id>');
        return;
      }

      const talk = talkStore.getTalk(talkId);
      if (!talk) {
        ctx.reply(`Talk not found: ${talkId}`);
        return;
      }

      const lines = [
        `Talk: ${talk.topicTitle || '(untitled)'}`,
        `ID: ${talk.id}`,
        `Model: ${talk.model || 'default'}`,
        `Created: ${new Date(talk.createdAt).toLocaleString()}`,
        `Updated: ${new Date(talk.updatedAt).toLocaleString()}`,
        `Pins: ${talk.pinnedMessageIds.length}`,
        `Automations: ${talk.jobs.length} (${talk.jobs.filter(j => j.active).length} active)`,
        `Agents: ${(talk.agents ?? []).length}`,
      ];

      if (talk.objective) {
        lines.push(`Objectives: ${talk.objective.slice(0, 200)}`);
      }

      const slackRuntime = getSlackIngressTalkRuntimeSnapshot(talk.id);
      const recent = slackRuntime.recentEvents[0];
      lines.push(
        `Channel Delivery: inflight=${slackRuntime.inflight} delivered=${slackRuntime.counters.delivered} ` +
        `failed=${slackRuntime.counters.failed} retries=${slackRuntime.counters.retries}`,
      );
      lines.push('Tip: if failed > 0, check gateway endpoint /api/events/slack/status?talkId=<talk-id>');
      if (recent) {
        lines.push(
          `Last Channel Event: ${recent.state} channel=${recent.channelId} attempt=${recent.attempt + 1}` +
          `${recent.lastError ? ` error="${recent.lastError.slice(0, 120)}"` : ''}`,
        );
      }

      ctx.reply(lines.join('\n'));
    },
  });

  // /jobs — list all active automations across talks
  api.registerCommand({
    name: 'jobs',
    description: 'List active automations across all talks',
    usage: '/jobs',
    handler: (ctx) => {
      const activeJobs = talkStore.getAllActiveJobs();
      if (activeJobs.length === 0) {
        ctx.reply('No active automations.');
        return;
      }

      const lines = activeJobs.map(({ talkId, job }) => {
        const talk = talkStore.getTalk(talkId);
        const talkName = talk?.topicTitle || talkId.slice(0, 8);
        const lastRun = job.lastRunAt
          ? `last: ${formatAge(job.lastRunAt)} (${job.lastStatus ?? 'unknown'})`
          : 'never run';
        const promptPreview = job.prompt.length > 60
          ? job.prompt.slice(0, 60) + '...'
          : job.prompt;
        return `  [${talkName}] "${job.schedule}" — ${promptPreview} (${lastRun})`;
      });

      ctx.reply(`Active automations (${activeJobs.length}):\n${lines.join('\n')}`);
    },
  });

  api.logger.info('ClawTalk: registered plugin commands (/talks, /talk-status, /jobs)');
}

/** Format a timestamp as a human-readable age string. */
function formatAge(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
