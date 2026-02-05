import { parseIntervalMs, isJobDue } from '../job-scheduler';
import type { TalkJob } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<TalkJob> = {}): TalkJob {
  return {
    id: 'job-1',
    schedule: 'every 1h',
    prompt: 'Check the weather',
    active: true,
    createdAt: Date.now() - 7_200_000, // 2 hours ago by default
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseIntervalMs
// ---------------------------------------------------------------------------

describe('parseIntervalMs', () => {
  it('parses "every 1h" to 3600000', () => {
    expect(parseIntervalMs('every 1h')).toBe(3_600_000);
  });

  it('parses "every 30m" to 1800000', () => {
    expect(parseIntervalMs('every 30m')).toBe(1_800_000);
  });

  it('parses "every 30min" to 1800000', () => {
    expect(parseIntervalMs('every 30min')).toBe(1_800_000);
  });

  it('parses "every 30mins" to 1800000', () => {
    expect(parseIntervalMs('every 30mins')).toBe(1_800_000);
  });

  it('parses "every 30minutes" to 1800000', () => {
    expect(parseIntervalMs('every 30minutes')).toBe(1_800_000);
  });

  it('parses "every 2hr" to 7200000', () => {
    expect(parseIntervalMs('every 2hr')).toBe(7_200_000);
  });

  it('parses "every 6h" to 21600000', () => {
    expect(parseIntervalMs('every 6h')).toBe(21_600_000);
  });

  it('parses "every 1d" to 86400000', () => {
    expect(parseIntervalMs('every 1d')).toBe(86_400_000);
  });

  it('parses "every 2days" to 172800000', () => {
    expect(parseIntervalMs('every 2days')).toBe(172_800_000);
  });

  it('returns null for "daily 9am" (not an interval)', () => {
    expect(parseIntervalMs('daily 9am')).toBeNull();
  });

  it('returns null for "blah"', () => {
    expect(parseIntervalMs('blah')).toBeNull();
  });

  it('returns null for cron expression "0 9 * * 1-5"', () => {
    expect(parseIntervalMs('0 9 * * 1-5')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isJobDue — interval schedules
// ---------------------------------------------------------------------------

describe('isJobDue (interval schedules)', () => {
  it('returns true when lastRunAt is older than the interval', () => {
    const job = makeJob({
      schedule: 'every 1h',
      lastRunAt: Date.now() - 7_200_000, // 2 hours ago
    });
    expect(isJobDue(job)).toBe(true);
  });

  it('returns false when lastRunAt is within the interval', () => {
    const job = makeJob({
      schedule: 'every 1h',
      lastRunAt: Date.now() - 1_800_000, // 30 minutes ago
    });
    expect(isJobDue(job)).toBe(false);
  });

  it('returns false for inactive jobs regardless of timing', () => {
    const job = makeJob({
      schedule: 'every 1h',
      active: false,
      lastRunAt: Date.now() - 7_200_000,
    });
    expect(isJobDue(job)).toBe(false);
  });

  it('falls back to createdAt when lastRunAt is absent', () => {
    const job = makeJob({
      schedule: 'every 1h',
      createdAt: Date.now() - 7_200_000, // 2 hours ago
      lastRunAt: undefined,
    });
    expect(isJobDue(job)).toBe(true);
  });

  it('returns false when createdAt is recent and no lastRunAt', () => {
    const job = makeJob({
      schedule: 'every 1h',
      createdAt: Date.now() - 60_000, // 1 minute ago
      lastRunAt: undefined,
    });
    expect(isJobDue(job)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isJobDue — daily schedules
// ---------------------------------------------------------------------------

describe('isJobDue (daily schedules)', () => {
  it('returns true when now is past the daily target and no run today', () => {
    // Build a target time that is 2 hours in the past today
    const twoHoursAgo = new Date();
    twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);
    twoHoursAgo.setMinutes(0, 0, 0);

    const hour = twoHoursAgo.getHours();
    const schedule = hour < 12 ? `daily ${hour}am` : `daily ${hour === 12 ? 12 : hour - 12}pm`;

    const job = makeJob({
      schedule,
      lastRunAt: Date.now() - 86_400_000 * 2, // 2 days ago
    });
    expect(isJobDue(job)).toBe(true);
  });

  it('returns false when lastRunAt is after today\'s target time', () => {
    // Build a target time 2 hours in the past today
    const twoHoursAgo = new Date();
    twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);
    twoHoursAgo.setMinutes(0, 0, 0);

    const hour = twoHoursAgo.getHours();
    const schedule = hour < 12 ? `daily ${hour}am` : `daily ${hour === 12 ? 12 : hour - 12}pm`;

    // lastRunAt is 1 hour ago — which is AFTER the 2-hours-ago target
    const job = makeJob({
      schedule,
      lastRunAt: Date.now() - 3_600_000,
    });
    expect(isJobDue(job)).toBe(false);
  });

  it('returns false when the target time has not been reached yet today', () => {
    // Target is 2 hours in the future
    const twoHoursLater = new Date();
    twoHoursLater.setHours(twoHoursLater.getHours() + 2);
    twoHoursLater.setMinutes(0, 0, 0);

    const hour = twoHoursLater.getHours();
    // Use 24-hour format to avoid am/pm edge cases
    const schedule = `daily ${hour}:00`;

    const job = makeJob({
      schedule,
      lastRunAt: undefined,
    });
    expect(isJobDue(job)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isJobDue — cron schedules
// ---------------------------------------------------------------------------

describe('isJobDue (cron schedules)', () => {
  it('returns true for "* * * * *" (every minute) with no recent run', () => {
    const job = makeJob({
      schedule: '* * * * *',
      lastRunAt: Date.now() - 120_000, // 2 minutes ago
    });
    expect(isJobDue(job)).toBe(true);
  });

  it('returns false for cron that already ran this minute', () => {
    const job = makeJob({
      schedule: '* * * * *',
      lastRunAt: Date.now(), // just now (same minute)
    });
    expect(isJobDue(job)).toBe(false);
  });

  it('returns true for a cron matching the current time fields', () => {
    const now = new Date();
    const min = now.getMinutes();
    const hour = now.getHours();
    // Specific cron that matches right now
    const schedule = `${min} ${hour} * * *`;

    const job = makeJob({
      schedule,
      lastRunAt: Date.now() - 86_400_000, // ran yesterday
    });
    expect(isJobDue(job)).toBe(true);
  });

  it('returns false for a cron that does not match the current minute', () => {
    const now = new Date();
    // Pick a minute that is definitely not the current one
    const otherMin = (now.getMinutes() + 30) % 60;
    const schedule = `${otherMin} * * * *`;

    const job = makeJob({
      schedule,
      lastRunAt: Date.now() - 86_400_000,
    });
    expect(isJobDue(job)).toBe(false);
  });

  it('supports day-of-week ranges in cron (e.g., 1-5 for weekdays)', () => {
    const now = new Date();
    const dow = now.getDay(); // 0=Sun, 6=Sat
    const min = now.getMinutes();
    const hour = now.getHours();

    // Build a cron that includes today's DOW
    const schedule = `${min} ${hour} * * ${dow}`;
    const job = makeJob({
      schedule,
      lastRunAt: Date.now() - 86_400_000,
    });
    expect(isJobDue(job)).toBe(true);

    // Build one that excludes today's DOW
    const otherDow = (dow + 3) % 7;
    const excludeSchedule = `${min} ${hour} * * ${otherDow}`;
    const excludeJob = makeJob({
      schedule: excludeSchedule,
      lastRunAt: Date.now() - 86_400_000,
    });
    expect(isJobDue(excludeJob)).toBe(false);
  });

  it('returns false for inactive job with cron schedule', () => {
    const job = makeJob({
      schedule: '* * * * *',
      active: false,
      lastRunAt: Date.now() - 120_000,
    });
    expect(isJobDue(job)).toBe(false);
  });
});
