/**
 * Job Scheduler
 *
 * Periodically checks active jobs across all talks and executes
 * those that are due. Each run uses the Talk's context (system prompt,
 * pinned messages, context.md) to give the job full conversation awareness.
 *
 * Schedules supported:
 *   - Simple intervals: "every 1h", "every 30m", "every 6h"
 *   - Weekly: "every Monday at 5pm", "every Monday PST at 5pm", "every Monday at 5pm PST"
 *   - Daily: "daily 9am", "daily 14:00"
 *   - Daily with day constraint: "daily 10am weekdays", "10am weekdays", "9am weekends"
 *   - Daily with timezone: "10am IST weekdays", "daily 9am PST", "10am Asia/Kolkata"
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

/** Default debounce for event-driven jobs. */
export const EVENT_JOB_DEBOUNCE_MS = 5_000;

/** Maximum time for a single job execution (25 min).
 *  Must exceed OpenClaw's embedded agent timeout (agents.defaults.timeoutSeconds,
 *  currently 1200s / 20 min) so we don't abort while the agent is working. */
const JOB_TIMEOUT_MS = 1_500_000;

/** Talks with a currently running job — prevents concurrent runs. */
const runningTalks = new Set<string>();

export interface JobSchedulerOptions {
  store: TalkStore;
  gatewayOrigin: string;
  authToken: string | undefined;
  logger: Logger;
  registry: ToolRegistry;
  executor: ToolExecutor;
  jobTimeoutMs?: number;
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

// ---------------------------------------------------------------------------
// Timezone support
// ---------------------------------------------------------------------------

/** Common timezone abbreviations → IANA timezone names. */
const TZ_ABBREVIATIONS: Record<string, string> = {
  // US
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  MST: 'America/Denver', MDT: 'America/Denver',
  CST: 'America/Chicago', CDT: 'America/Chicago',
  EST: 'America/New_York', EDT: 'America/New_York',
  AKST: 'America/Anchorage', AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  // Europe
  GMT: 'Europe/London', BST: 'Europe/London',
  CET: 'Europe/Berlin', CEST: 'Europe/Berlin',
  EET: 'Europe/Helsinki', EEST: 'Europe/Helsinki',
  // Asia
  IST: 'Asia/Kolkata',
  JST: 'Asia/Tokyo',
  KST: 'Asia/Seoul',
  CST_ASIA: 'Asia/Shanghai', // Use "CST_ASIA" or IANA name for China
  SGT: 'Asia/Singapore',
  HKT: 'Asia/Hong_Kong',
  // Oceania
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
  ACST: 'Australia/Adelaide', ACDT: 'Australia/Adelaide',
  AWST: 'Australia/Perth',
  NZST: 'Pacific/Auckland', NZDT: 'Pacific/Auckland',
  // Universal
  UTC: 'UTC',
};

/**
 * Resolve a timezone token to an IANA timezone name.
 * Accepts abbreviations (PST, IST) or IANA names (America/Los_Angeles).
 * Returns null if unrecognized.
 */
export function resolveTimezone(token: string): string | null {
  // Check abbreviation map (case-insensitive)
  const upper = token.toUpperCase();
  if (TZ_ABBREVIATIONS[upper]) return TZ_ABBREVIATIONS[upper];

  // Check if it's a valid IANA timezone by trying to use it
  try {
    Intl.DateTimeFormat('en-US', { timeZone: token });
    return token;
  } catch {
    return null;
  }
}

/**
 * Get current time components in a specific timezone.
 */
function getTimeInTimezone(tz: string): { hour: number; minute: number; dayOfWeek: number; year: number; month: number; day: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric', minute: 'numeric',
    year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => {
    const p = parts.find(p => p.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };

  const weekdayStr = parts.find(p => p.type === 'weekday')?.value ?? '';
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    hour: get('hour'),
    minute: get('minute'),
    dayOfWeek: dowMap[weekdayStr] ?? 0,
    year: get('year'),
    month: get('month'),
    day: get('day'),
  };
}

// ---------------------------------------------------------------------------
// Daily schedule parsing
// ---------------------------------------------------------------------------

interface DailySchedule {
  hour: number;
  minute: number;
  days: 'all' | 'weekdays' | 'weekends';
  timezone?: string; // IANA timezone name
}

interface WeeklySchedule {
  dayOfWeek: number; // 0=Sun
  hour: number;
  minute: number;
  timezone?: string; // IANA timezone name
}

/**
 * Parse a daily schedule string into structured form.
 * Accepts: "daily 9am", "10am weekdays", "10am IST weekdays", "10am Asia/Kolkata weekdays"
 * Timezone token can appear before or after the day constraint.
 * Returns null if not a daily format.
 */
export function parseDailySchedule(schedule: string): DailySchedule | null {
  // Match: [daily] time [am/pm] [tokens...]
  // Tokens can be timezone and/or day constraint in any order
  const match = schedule.match(/^(?:daily\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(.*)$/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2] ?? '0', 10);
  const ampm = match[3]?.toLowerCase();
  const remainder = match[4]?.trim() ?? '';

  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  if (hour > 23 || minute > 59) return null;

  // Parse remaining tokens: could be timezone, day constraint, or both
  let days: 'all' | 'weekdays' | 'weekends' = 'all';
  let timezone: string | undefined;

  if (remainder) {
    const tokens = remainder.split(/\s+/);
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (lower === 'weekdays' || lower === 'weekends') {
        days = lower;
      } else {
        const resolved = resolveTimezone(token);
        if (resolved) {
          timezone = resolved;
        } else {
          return null; // Unrecognized token
        }
      }
    }
  }

  return { hour, minute, days, timezone };
}

const WEEKDAY_TO_DOW: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/**
 * Parse a weekly schedule string.
 * Accepts:
 *   - "every Monday at 5pm"
 *   - "every Monday PST at 5pm"
 *   - "every Monday at 5pm PST"
 */
export function parseWeeklySchedule(schedule: string): WeeklySchedule | null {
  const match = schedule.match(/^every\s+([a-z]+)\s+(.+)$/i);
  if (!match) return null;

  const dayToken = match[1].toLowerCase();
  const dayOfWeek = WEEKDAY_TO_DOW[dayToken];
  if (dayOfWeek === undefined) return null;

  let remainder = match[2].trim();
  if (!remainder) return null;

  let timezoneToken: string | undefined;
  let timeToken: string | undefined;

  // Pattern A: "<timezone> at <time>"
  const atSeparator = remainder.toLowerCase().indexOf(' at ');
  if (atSeparator > 0) {
    timezoneToken = remainder.slice(0, atSeparator).trim();
    timeToken = remainder.slice(atSeparator + 4).trim();
  } else if (remainder.toLowerCase().startsWith('at ')) {
    // Pattern B: "at <time> [timezone]"
    remainder = remainder.slice(3).trim();
    const pieces = remainder.split(/\s+/);
    if (pieces.length >= 2) {
      const maybeTimezone = pieces[pieces.length - 1];
      if (resolveTimezone(maybeTimezone)) {
        timezoneToken = maybeTimezone;
        timeToken = pieces.slice(0, -1).join(' ');
      } else {
        timeToken = remainder;
      }
    } else {
      timeToken = remainder;
    }
  } else {
    return null;
  }

  if (!timeToken) return null;

  const timeMatch = timeToken.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!timeMatch) return null;
  let hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2] ?? '0', 10);
  const ampm = timeMatch[3]?.toLowerCase();

  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  let timezone: string | undefined;
  if (timezoneToken) {
    const resolved = resolveTimezone(timezoneToken);
    if (!resolved) return null;
    timezone = resolved;
  }

  return { dayOfWeek, hour, minute, timezone };
}

// ---------------------------------------------------------------------------
// Event trigger parsing
// ---------------------------------------------------------------------------

/**
 * Parse an event trigger schedule ("on <scope>").
 * Returns the scope string, or null if not an event trigger format.
 */
export function parseEventTrigger(schedule: string): string | null {
  const match = schedule.match(/^on\s+(.+)$/i);
  if (!match) return null;
  const scope = match[1].trim();
  return scope || null;
}

/**
 * Validate that a schedule string matches a recognized format.
 * Returns null if valid, or an error message describing the problem.
 */
export function validateSchedule(schedule: string): string | null {
  if (!schedule || typeof schedule !== 'string' || !schedule.trim()) {
    return 'Schedule must be a non-empty string';
  }
  const s = schedule.trim();

  // Event trigger: "on <scope>"
  if (parseEventTrigger(s) !== null) return null;

  // One-off: "in Xh", "at 3pm", etc.
  if (parseOneOff(s, Date.now()) !== null) return null;

  // Interval: "every Xh", "every Xm", "every Xd"
  if (parseIntervalMs(s) !== null) return null;

  // Weekly: "every Monday at 5pm", optionally with timezone token.
  if (parseWeeklySchedule(s) !== null) return null;

  // Daily (with optional day constraint): "daily 9am", "daily 14:00", "daily 10am weekdays",
  // "10am weekdays", "9am weekends"
  if (parseDailySchedule(s) !== null) return null;

  // Cron: 5 space-separated fields
  if (s.split(/\s+/).length === 5) return null;

  return `Unrecognized schedule format: "${s}". Supported: "on <scope>" (event), "every Xh/Xm/Xd", "every Monday [TZ] at 5pm", "daily 9am", "10am IST weekdays", "in Xh/Xm", "at 3pm/14:00", or 5-field cron`;
}

/**
 * Check if a job is due to run based on its schedule and lastRunAt.
 */
export function isJobDue(job: TalkJob): boolean {
  if (!job.active) return false;
  if (job.type === 'event' || /^on\s+/i.test(job.schedule)) return false;

  // Event-driven jobs are never "due" on the cron loop — they fire via EventDispatcher
  if (parseEventTrigger(job.schedule) !== null) return false;

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

  // Weekly schedules: "every Monday at 5pm", with optional timezone
  const weekly = parseWeeklySchedule(job.schedule);
  if (weekly) {
    if (weekly.timezone) {
      const tz = getTimeInTimezone(weekly.timezone);
      if (tz.dayOfWeek !== weekly.dayOfWeek) return false;
      const targetReached = tz.hour > weekly.hour || (tz.hour === weekly.hour && tz.minute >= weekly.minute);
      if (!targetReached) return false;

      const tzDayKey = `${tz.year}-${tz.month}-${tz.day}`;
      const lastRun = job.lastRunAt ?? 0;
      if (lastRun > 0) {
        const lastRunDate = new Date(lastRun);
        const lastRunParts = new Intl.DateTimeFormat('en-US', {
          timeZone: weekly.timezone,
          year: 'numeric', month: 'numeric', day: 'numeric',
        }).formatToParts(lastRunDate);
        const getLR = (type: string) => lastRunParts.find(p => p.type === type)?.value ?? '';
        const lastRunDayKey = `${getLR('year')}-${getLR('month')}-${getLR('day')}`;
        if (lastRunDayKey === tzDayKey) return false;
      }

      return true;
    }

    const today = new Date();
    if (today.getDay() !== weekly.dayOfWeek) return false;
    const targetToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), weekly.hour, weekly.minute, 0, 0);
    const targetMs = targetToday.getTime();
    const lastRun = job.lastRunAt ?? 0;
    return now >= targetMs && lastRun < targetMs;
  }

  // Daily schedule: "daily 9am", "daily 14:00", "daily 10am weekdays", "10am IST weekdays"
  const daily = parseDailySchedule(job.schedule);
  if (daily) {
    if (daily.timezone) {
      // Timezone-aware check: get current time in the target timezone
      const tz = getTimeInTimezone(daily.timezone);

      // Check day constraint
      if (daily.days === 'weekdays' && (tz.dayOfWeek === 0 || tz.dayOfWeek === 6)) return false;
      if (daily.days === 'weekends' && tz.dayOfWeek >= 1 && tz.dayOfWeek <= 5) return false;

      // Check if target time has been reached in the target timezone
      const targetReached = tz.hour > daily.hour || (tz.hour === daily.hour && tz.minute >= daily.minute);
      if (!targetReached) return false;

      // Build a key for "today in target timezone" to prevent re-running
      const tzDayKey = `${tz.year}-${tz.month}-${tz.day}`;
      const lastRun = job.lastRunAt ?? 0;
      if (lastRun > 0) {
        // If last run was within the same calendar day in the target timezone, skip
        const lastRunDate = new Date(lastRun);
        const lastRunParts = new Intl.DateTimeFormat('en-US', {
          timeZone: daily.timezone,
          year: 'numeric', month: 'numeric', day: 'numeric',
        }).formatToParts(lastRunDate);
        const getLR = (type: string) => lastRunParts.find(p => p.type === type)?.value ?? '';
        const lastRunDayKey = `${getLR('year')}-${getLR('month')}-${getLR('day')}`;
        if (lastRunDayKey === tzDayKey) return false;
      }

      return true;
    }

    // No timezone — use server local time
    const today = new Date();
    const dow = today.getDay(); // 0=Sun

    // Check day constraint
    if (daily.days === 'weekdays' && (dow === 0 || dow === 6)) return false;
    if (daily.days === 'weekends' && dow >= 1 && dow <= 5) return false;

    const targetToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), daily.hour, daily.minute, 0, 0);
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

export async function executeJob(
  opts: JobSchedulerOptions,
  talkId: string,
  job: TalkJob,
  /** Extra context injected before the job prompt (e.g. event trigger details). */
  triggerContext?: string,
): Promise<JobReport | null> {
  const { store, gatewayOrigin, authToken, logger, registry, executor } = opts;
  const runAt = Date.now();

  logger.info(`JobScheduler: executing job ${job.id} for talk ${talkId}: "${job.prompt}"`);

  store.setProcessing(talkId, true);
  try {
    // Compose system prompt from Talk context
    const meta = store.getTalk(talkId);
    if (!meta) {
      logger.warn(`JobScheduler: talk ${talkId} not found, skipping job`);
      return null;
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
    const triggerSection = triggerContext
      ? `\n${triggerContext}\n`
      : '';
    const jobKind = job.type === 'event' ? 'event-triggered' : 'scheduled';
    const jobPrompt = `You are running a ${jobKind} background job for this conversation.

Job schedule: ${job.schedule}${triggerSection}
Job task: ${job.prompt}

You have tools available — use them if the task requires actions (file ops, web requests, etc.).
Provide a concise report of your findings or actions. Start with a one-line summary, then provide details if needed. Be direct and actionable.`;

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: jobPrompt });

    // Run the tool loop (non-streaming for background jobs)
    const model = meta.model ?? 'openclaw';
    const tools = registry.getToolSchemas();

    const result = await runToolLoopNonStreaming({
      messages,
      model,
      tools,
      toolChoice: 'auto',
      gatewayOrigin,
      authToken,
      executor,
      logger,
      timeoutMs: opts.jobTimeoutMs ?? JOB_TIMEOUT_MS,
      defaultGoogleAuthProfile: meta.googleAuthProfile,
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

    return report;
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

    await store.appendReport(talkId, report).catch((reportErr) => {
      logger.error(`JobScheduler: failed to persist error report for job ${job.id}: ${reportErr}`);
    });
    store.updateJob(talkId, job.id, { lastRunAt: runAt, lastStatus: 'error' });
    return null;
  } finally {
    store.setProcessing(talkId, false);
  }
}
