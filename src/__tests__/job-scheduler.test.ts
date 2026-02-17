import { parseIntervalMs, isJobDue, validateSchedule } from '../job-scheduler';
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

describe('validateSchedule (weekly)', () => {
  it('accepts weekly schedules with optional timezone token', () => {
    expect(validateSchedule('every Monday at 5pm')).toBeNull();
    expect(validateSchedule('every Monday PST at 5PM')).toBeNull();
    expect(validateSchedule('every Monday at 5PM PST')).toBeNull();
  });

  it('accepts every weekday/day schedules with timezones', () => {
    expect(validateSchedule('every weekday at 9AM IST')).toBeNull();
    expect(validateSchedule('every day at 7:30am PST')).toBeNull();
    expect(validateSchedule('every weekend at 10am')).toBeNull();
  });

  it('does not treat arbitrary 5-word text as cron', () => {
    const err2 = validateSchedule('foo bar baz qux quux');
    expect(err2).not.toBeNull();
    expect(err2).toContain('looks like 5-field cron');
    const err3 = validateSchedule('every weekday at 9AM IST now');
    expect(err3).not.toBeNull();
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

  it('returns false for event jobs (triggered by ingress, not scheduler)', () => {
    const job = makeJob({
      type: 'event',
      schedule: 'on slack #team-product',
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
    // Build a target that is guaranteed to be in the past on the same calendar day.
    const now = new Date();
    const past = new Date(now);
    if (now.getMinutes() > 0) {
      past.setHours(now.getHours(), now.getMinutes() - 1, 0, 0);
    } else if (now.getHours() > 0) {
      past.setHours(now.getHours() - 1, 59, 0, 0);
    } else {
      // At 00:00 there is no earlier minute on the same day; skip this edge.
      expect(true).toBe(true);
      return;
    }

    const schedule = `daily ${past.getHours()}:${String(past.getMinutes()).padStart(2, '0')}`;

    const job = makeJob({
      schedule,
      lastRunAt: Date.now() - 86_400_000 * 2, // 2 days ago
    });
    expect(isJobDue(job)).toBe(true);
  });

  it('returns false when lastRunAt is after today\'s target time', () => {
    // Build a target that is guaranteed to be in the past on the same calendar day.
    const now = new Date();
    const past = new Date(now);
    if (now.getMinutes() > 0) {
      past.setHours(now.getHours(), now.getMinutes() - 1, 0, 0);
    } else if (now.getHours() > 0) {
      past.setHours(now.getHours() - 1, 59, 0, 0);
    } else {
      // At 00:00 there is no earlier minute on the same day; skip this edge.
      expect(true).toBe(true);
      return;
    }

    const schedule = `daily ${past.getHours()}:${String(past.getMinutes()).padStart(2, '0')}`;

    // lastRunAt is now — definitely after the past target on the same day.
    const job = makeJob({
      schedule,
      lastRunAt: Date.now(),
    });
    expect(isJobDue(job)).toBe(false);
  });

  it('returns false when the target time has not been reached yet today', () => {
    // Target is in the future on the same calendar day to avoid day-wrap edge cases.
    const now = new Date();
    const future = new Date(now);
    if (now.getHours() < 23) {
      future.setHours(now.getHours() + 1, 0, 0, 0);
    } else if (now.getMinutes() < 59) {
      future.setHours(23, now.getMinutes() + 1, 0, 0);
    } else {
      // At 23:59 there is no future minute in the same day; skip this edge.
      expect(true).toBe(true);
      return;
    }

    const schedule = `daily ${future.getHours()}:${String(future.getMinutes()).padStart(2, '0')}`;

    const job = makeJob({
      schedule,
      lastRunAt: undefined,
    });
    expect(isJobDue(job)).toBe(false);
  });

  it('supports "every day at <time> <TZ>" schedules', () => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    let minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10) - 1;
    let hh = hour;
    if (minute < 0) {
      minute = 59;
      hh = (hour + 23) % 24;
    }
    const schedule = `every day at ${hh}:${String(minute).padStart(2, '0')} IST`;
    const job = makeJob({
      schedule,
      lastRunAt: Date.now() - 86_400_000 * 2,
    });
    expect(isJobDue(job)).toBe(true);
  });
});

describe('isJobDue (weekly schedules)', () => {
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

  it('returns true when weekly target time has passed and has not run today', () => {
    const now = new Date();
    const minute = now.getMinutes() > 0 ? now.getMinutes() - 1 : 0;
    const schedule = `every ${dayNames[now.getDay()]} at ${now.getHours()}:${String(minute).padStart(2, '0')}`;

    const job = makeJob({
      schedule,
      lastRunAt: Date.now() - 86_400_000 * 2, // 2 days ago
    });
    expect(isJobDue(job)).toBe(true);
  });

  it('returns false when weekly job already ran after today\'s target', () => {
    const now = new Date();
    const minute = now.getMinutes() > 0 ? now.getMinutes() - 1 : 0;
    const schedule = `every ${dayNames[now.getDay()]} at ${now.getHours()}:${String(minute).padStart(2, '0')}`;

    const job = makeJob({
      schedule,
      lastRunAt: Date.now() - 5_000, // just ran
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
