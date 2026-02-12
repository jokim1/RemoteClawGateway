/**
 * Job Scheduler
 *
 * Periodically checks active jobs across all talks and executes
 * those that are due. Each run uses the Talk's context (system prompt,
 * pinned messages, context.md) to give the job full conversation awareness.
 *
 * Schedules supported:
 *   - Simple intervals: "every 1h", "every 30m", "every 6h"
 *   - Daily: "daily 9am", "daily 14:00"
 *   - Cron-like: "0 9 * * 1-5" (weekdays at 9am)
 */

import { randomUUID } from 'node:crypto';
import type { TalkStore } from './talk-store.js';
import type { TalkJob, JobReport, Logger } from './types.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ToolExecutor } from './tool-executor.js';
import { composeSystemPrompt } from './system-prompt.js';
import { runToolLoopNonStreaming } from './tool-loop.js';

/** How often the scheduler checks for due jobs. */
const CHECK_INTERVAL_MS = 60_000; // 1 minute

/** Maximum time for a single job execution. */
const JOB_TIMEOUT_MS = 120_000; // 2 minutes

/** Talks with a currently running job — prevents concurrent runs. */
const runningTalks = new Set<string>();

export interface JobSchedulerOptions {
  store: TalkStore;
  gatewayOrigin: string;
  authToken: string | undefined;
  logger: Logger;
  registry: ToolRegistry;
  executor: ToolExecutor;
}

/**
 * Start the job scheduler. Returns a cleanup function to stop it.
 */
export function startJobScheduler(opts: JobSchedulerOptions): () => void {
  const { store, logger } = opts;

  const interval = setInterval(() => {
    checkAndRunJobs(opts).catch(err => {
      logger.warn(`JobScheduler: tick error: ${err}`);
    });
  }, CHECK_INTERVAL_MS);
  interval.unref();

  logger.info('JobScheduler: started');

  return () => {
    clearInterval(interval);
    logger.info('JobScheduler: stopped');
  };
}

// ---------------------------------------------------------------------------
// Schedule parsing
// ---------------------------------------------------------------------------

/**
 * Parse a one-off schedule ("in Xh", "in Xm", "at 3pm", "at 14:00")
 * into a target timestamp. Returns null if not a one-off format.
 */
export function parseOneOff(schedule: string, createdAt: number): number | null {
  // "in Xh", "in X hours", "in Xm", "in X minutes"
  const inMatch = schedule.match(/^in\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/i);
  if (inMatch) {
    const value = parseInt(inMatch[1], 10);
    const unit = inMatch[2].toLowerCase();
    const delayMs = unit.startsWith('h') ? value * 3_600_000 : value * 60_000;
    return createdAt + delayMs;
  }

  // "at 3pm", "at 14:00", "at 3:30pm"
  const atMatch = schedule.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (atMatch) {
    let hour = parseInt(atMatch[1], 10);
    const minute = parseInt(atMatch[2] ?? '0', 10);
    const ampm = atMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    // If the target time has already passed today, schedule for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  return null;
}

/**
 * Parse a human-readable schedule into a millisecond interval.
 * Returns null if the schedule can't be parsed as a simple interval.
 */
export function parseIntervalMs(schedule: string): number | null {
  const match = schedule.match(/^every\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('m')) return value * 60_000;
  if (unit.startsWith('h')) return value * 3_600_000;
  if (unit.startsWith('d')) return value * 86_400_000;
  return null;
}

/**
 * Check if a job is due to run based on its schedule and lastRunAt.
 */
export function isJobDue(job: TalkJob): boolean {
  if (!job.active) return false;

  const now = Date.now();

  // One-off schedules: "in 1h", "at 3pm"
  const oneOffTarget = parseOneOff(job.schedule, job.createdAt);
  if (oneOffTarget !== null) {
    return now >= oneOffTarget && !job.lastRunAt;
  }

  // Simple interval schedules: "every Xh", "every Xm"
  const intervalMs = parseIntervalMs(job.schedule);
  if (intervalMs !== null) {
    const lastRun = job.lastRunAt ?? job.createdAt;
    return now - lastRun >= intervalMs;
  }

  // Daily schedule: "daily 9am", "daily 14:00"
  const dailyMatch = job.schedule.match(/^daily\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1], 10);
    const minute = parseInt(dailyMatch[2] ?? '0', 10);
    const ampm = dailyMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const today = new Date();
    const targetToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute, 0, 0);
    const targetMs = targetToday.getTime();

    // Has this job run today (since the target time)?
    const lastRun = job.lastRunAt ?? 0;
    return now >= targetMs && lastRun < targetMs;
  }

  // Cron-like: basic 5-field cron "min hour dom month dow"
  // For now, support simple cases; full cron can be added later
  const cronParts = job.schedule.trim().split(/\s+/);
  if (cronParts.length === 5) {
    return isCronDue(cronParts, job.lastRunAt ?? 0);
  }

  return false;
}

/**
 * Basic 5-field cron check. Supports *, numeric values, and ranges (1-5).
 */
function isCronDue(parts: string[], lastRunAt: number): boolean {
  const now = new Date();
  const currentMin = now.getMinutes();
  const currentHour = now.getHours();
  const currentDom = now.getDate();
  const currentMonth = now.getMonth() + 1;
  const currentDow = now.getDay(); // 0=Sun

  if (!cronFieldMatches(parts[0], currentMin)) return false;
  if (!cronFieldMatches(parts[1], currentHour)) return false;
  if (!cronFieldMatches(parts[2], currentDom)) return false;
  if (!cronFieldMatches(parts[3], currentMonth)) return false;
  if (!cronFieldMatches(parts[4], currentDow)) return false;

  // Don't re-run within the same minute
  const lastRunDate = new Date(lastRunAt);
  if (lastRunDate.getFullYear() === now.getFullYear() &&
      lastRunDate.getMonth() === now.getMonth() &&
      lastRunDate.getDate() === now.getDate() &&
      lastRunDate.getHours() === now.getHours() &&
      lastRunDate.getMinutes() === now.getMinutes()) {
    return false;
  }

  return true;
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;

  // Comma-separated values: "1,3,5"
  const parts = field.split(',');
  for (const part of parts) {
    // Range: "1-5"
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      if (value >= lo && value <= hi) return true;
      continue;
    }
    // Step: "*/5"
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      if (value % step === 0) return true;
      continue;
    }
    // Exact value
    if (parseInt(part, 10) === value) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function checkAndRunJobs(opts: JobSchedulerOptions): Promise<void> {
  const { store, logger } = opts;

  const activeJobs = store.getAllActiveJobs();
  if (activeJobs.length === 0) return;

  for (const { talkId, job } of activeJobs) {
    if (!isJobDue(job)) continue;
    if (runningTalks.has(talkId)) continue;

    runningTalks.add(talkId);
    executeJob(opts, talkId, job).finally(() => {
      runningTalks.delete(talkId);
    });
  }
}

async function executeJob(
  opts: JobSchedulerOptions,
  talkId: string,
  job: TalkJob,
): Promise<void> {
  const { store, gatewayOrigin, authToken, logger, registry, executor } = opts;
  const runAt = Date.now();

  logger.info(`JobScheduler: executing job ${job.id} for talk ${talkId}: "${job.prompt}"`);

  try {
    // Compose system prompt from Talk context
    const meta = store.getTalk(talkId);
    if (!meta) {
      logger.warn(`JobScheduler: talk ${talkId} not found, skipping job`);
      return;
    }

    const contextMd = await store.getContextMd(talkId);
    const pinnedMessages = await Promise.all(
      meta.pinnedMessageIds.map(id => store.getMessage(talkId, id)),
    );

    const systemPrompt = composeSystemPrompt({
      meta,
      contextMd,
      pinnedMessages: pinnedMessages.filter(Boolean) as any[],
      registry,
    });

    // Build the job execution prompt
    const jobPrompt = `You are running a scheduled background job for this conversation.

Job schedule: ${job.schedule}
Job task: ${job.prompt}

You have tools available — use them if the task requires actions (file ops, web requests, etc.).
Provide a concise report of your findings or actions. Start with a one-line summary, then provide details if needed. Be direct and actionable.`;

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: jobPrompt });

    // Run the tool loop (non-streaming for background jobs)
    const model = meta.model ?? 'moltbot';
    const tools = registry.getToolSchemas();

    const result = await runToolLoopNonStreaming({
      messages,
      model,
      tools,
      gatewayOrigin,
      authToken,
      executor,
      logger,
      timeoutMs: JOB_TIMEOUT_MS,
    });

    const fullOutput = result.fullContent.trim();
    const summary = fullOutput.split('\n')[0].slice(0, 200);

    const report: JobReport = {
      id: randomUUID(),
      jobId: job.id,
      talkId,
      runAt,
      status: 'success',
      summary,
      fullOutput,
      tokenUsage: result.usage ? {
        input: result.usage.prompt_tokens,
        output: result.usage.completion_tokens,
      } : undefined,
    };

    await store.appendReport(talkId, report);
    store.updateJob(talkId, job.id, { lastRunAt: runAt, lastStatus: 'success' });

    // Auto-deactivate one-off jobs after execution
    if (job.type === 'once') {
      store.updateJob(talkId, job.id, { active: false });
      logger.info(`JobScheduler: one-off job ${job.id} completed and deactivated — "${summary}"`);
    } else {
      logger.info(`JobScheduler: job ${job.id} completed — "${summary}"`);
    }
  } catch (err) {
    const cause = err instanceof Error && (err as any).cause ? ` (cause: ${(err as any).cause})` : '';
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`JobScheduler: job ${job.id} failed: ${errorMsg}${cause}`);

    const report: JobReport = {
      id: randomUUID(),
      jobId: job.id,
      talkId,
      runAt,
      status: 'error',
      summary: `Error: ${errorMsg.slice(0, 200)}`,
      fullOutput: errorMsg,
    };

    await store.appendReport(talkId, report).catch(() => {});
    store.updateJob(talkId, job.id, { lastRunAt: runAt, lastStatus: 'error' });
  }
}
