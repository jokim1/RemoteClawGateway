import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TalkStore } from '../talk-store';
import type { Logger, TalkMessage, JobReport } from '../types';

let tmpDir: string;
let store: TalkStore;

const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'talkstore-test-'));
  store = new TalkStore(tmpDir, mockLogger);
  await store.init();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Talk CRUD
// ---------------------------------------------------------------------------

describe('Talk CRUD', () => {
  it('creates a talk with a UUID and timestamps', () => {
    const talk = store.createTalk('test-model');
    expect(talk.id).toMatch(/^[\da-f-]{36}$/);
    expect(talk.model).toBe('test-model');
    expect(talk.pinnedMessageIds).toEqual([]);
    expect(talk.jobs).toEqual([]);
    expect(talk.createdAt).toBeGreaterThan(0);
    expect(talk.updatedAt).toBeGreaterThan(0);
  });

  it('creates a talk without a model', () => {
    const talk = store.createTalk();
    expect(talk.model).toBeUndefined();
  });

  it('retrieves a created talk by ID', () => {
    const talk = store.createTalk();
    const fetched = store.getTalk(talk.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(talk.id);
  });

  it('returns null for unknown talk ID', () => {
    expect(store.getTalk('nonexistent')).toBeNull();
  });

  it('lists talks sorted by updatedAt (most recent first)', async () => {
    const t1 = store.createTalk();
    await new Promise(r => setTimeout(r, 10)); // Ensure different timestamp
    const t2 = store.createTalk();

    const list = store.listTalks();
    expect(list.length).toBe(2);
    // t2 was created second, so it has a later updatedAt
    expect(list[0].id).toBe(t2.id);
    expect(list[1].id).toBe(t1.id);
  });

  it('updates talk metadata', () => {
    const talk = store.createTalk();
    const updated = store.updateTalk(talk.id, {
      topicTitle: 'Sprint Planning',
      objective: 'Plan Q2 sprint',
      model: 'claude-sonnet',
    });
    expect(updated).not.toBeNull();
    expect(updated!.topicTitle).toBe('Sprint Planning');
    expect(updated!.objective).toBe('Plan Q2 sprint');
    expect(updated!.model).toBe('claude-sonnet');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(talk.updatedAt);
  });

  it('persists directives and platform bindings via updateTalk', () => {
    const talk = store.createTalk();
    const updated = store.updateTalk(talk.id, {
      directives: [{ text: 'Be concise', active: true }],
      platformBindings: [{ platform: 'slack', scope: '#team-product', permission: 'read+write' }],
    });

    expect(updated).not.toBeNull();
    expect(updated!.directives).toHaveLength(1);
    expect(updated!.directives?.[0].text).toBe('Be concise');
    expect(updated!.directives?.[0].active).toBe(true);
    expect(updated!.platformBindings).toHaveLength(1);
    expect(updated!.platformBindings?.[0].platform).toBe('slack');
    expect(updated!.platformBindings?.[0].scope).toBe('#team-product');
    expect(updated!.platformBindings?.[0].permission).toBe('read+write');
  });

  it('returns null when updating nonexistent talk', () => {
    expect(store.updateTalk('nonexistent', { topicTitle: 'x' })).toBeNull();
  });

  it('deletes a talk', () => {
    const talk = store.createTalk();
    expect(store.deleteTalk(talk.id)).toBe(true);
    expect(store.getTalk(talk.id)).toBeNull();
    expect(store.listTalks()).toHaveLength(0);
  });

  it('returns false when deleting nonexistent talk', () => {
    expect(store.deleteTalk('nonexistent')).toBe(false);
  });

  it('persists talks to disk and reloads them', async () => {
    const talk = store.createTalk('claude-opus');
    store.updateTalk(talk.id, { topicTitle: 'Persisted Talk' });

    // Wait for async writes to flush
    await new Promise(r => setTimeout(r, 100));

    // Create a new store from the same directory
    const store2 = new TalkStore(tmpDir, mockLogger);
    await store2.init();
    const loaded = store2.getTalk(talk.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.topicTitle).toBe('Persisted Talk');
    expect(loaded!.model).toBe('claude-opus');
  });
});

// ---------------------------------------------------------------------------
// Message history (JSONL)
// ---------------------------------------------------------------------------

describe('Message history', () => {
  function makeMsg(overrides: Partial<TalkMessage> = {}): TalkMessage {
    return {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it('appends and retrieves messages', async () => {
    const talk = store.createTalk();
    const msg1 = makeMsg({ content: 'First message' });
    const msg2 = makeMsg({ role: 'assistant', content: 'Reply' });

    await store.appendMessage(talk.id, msg1);
    await store.appendMessage(talk.id, msg2);

    const messages = await store.getMessages(talk.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('First message');
    expect(messages[0].role).toBe('user');
    expect(messages[1].content).toBe('Reply');
    expect(messages[1].role).toBe('assistant');
  });

  it('returns empty array for talk with no messages', async () => {
    const talk = store.createTalk();
    expect(await store.getMessages(talk.id)).toEqual([]);
  });

  it('returns empty array for nonexistent talk', async () => {
    expect(await store.getMessages('nonexistent')).toEqual([]);
  });

  it('getRecentMessages returns last N messages', async () => {
    const talk = store.createTalk();
    for (let i = 0; i < 10; i++) {
      await store.appendMessage(talk.id, makeMsg({ content: `Message ${i}` }));
    }

    const recent = await store.getRecentMessages(talk.id, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toBe('Message 7');
    expect(recent[1].content).toBe('Message 8');
    expect(recent[2].content).toBe('Message 9');
  });

  it('getMessage finds a specific message by ID', async () => {
    const talk = store.createTalk();
    const target = makeMsg({ id: 'find-me', content: 'Special message' });
    await store.appendMessage(talk.id, makeMsg({ content: 'Other' }));
    await store.appendMessage(talk.id, target);

    const found = await store.getMessage(talk.id, 'find-me');
    expect(found).not.toBeNull();
    expect(found!.content).toBe('Special message');
  });

  it('getMessage returns null for unknown message ID', async () => {
    const talk = store.createTalk();
    await store.appendMessage(talk.id, makeMsg());
    expect(await store.getMessage(talk.id, 'nonexistent')).toBeNull();
  });

  it('updates talk timestamp when appending messages', async () => {
    const talk = store.createTalk();
    const originalUpdated = talk.updatedAt;
    await new Promise(r => setTimeout(r, 10));
    await store.appendMessage(talk.id, makeMsg());

    const updated = store.getTalk(talk.id);
    expect(updated!.updatedAt).toBeGreaterThan(originalUpdated);
  });

  it('skips invalid talk IDs', async () => {
    await store.appendMessage('../escape', makeMsg());
    expect(await store.getMessages('../escape')).toEqual([]);
  });

  it('survives malformed JSONL lines', async () => {
    const talk = store.createTalk();
    const talkDir = path.join(tmpDir, 'talks', talk.id);
    const historyPath = path.join(talkDir, 'history.jsonl');

    // Ensure the talk directory exists
    await fsp.mkdir(talkDir, { recursive: true });

    // Manually write some lines including a bad one
    const good = JSON.stringify(makeMsg({ content: 'Good line' }));
    await fsp.appendFile(historyPath, good + '\n');
    await fsp.appendFile(historyPath, 'not valid json\n');
    await fsp.appendFile(historyPath, JSON.stringify(makeMsg({ content: 'After bad' })) + '\n');

    const messages = await store.getMessages(talk.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Good line');
    expect(messages[1].content).toBe('After bad');
  });
});

// ---------------------------------------------------------------------------
// Pin management
// ---------------------------------------------------------------------------

describe('Pin management', () => {
  it('adds a pin', () => {
    const talk = store.createTalk();
    expect(store.addPin(talk.id, 'msg-1')).toBe(true);
    expect(store.getTalk(talk.id)!.pinnedMessageIds).toEqual(['msg-1']);
  });

  it('prevents duplicate pins', () => {
    const talk = store.createTalk();
    store.addPin(talk.id, 'msg-1');
    expect(store.addPin(talk.id, 'msg-1')).toBe(false);
    expect(store.getTalk(talk.id)!.pinnedMessageIds).toEqual(['msg-1']);
  });

  it('removes a pin', () => {
    const talk = store.createTalk();
    store.addPin(talk.id, 'msg-1');
    store.addPin(talk.id, 'msg-2');
    expect(store.removePin(talk.id, 'msg-1')).toBe(true);
    expect(store.getTalk(talk.id)!.pinnedMessageIds).toEqual(['msg-2']);
  });

  it('returns false when removing nonexistent pin', () => {
    const talk = store.createTalk();
    expect(store.removePin(talk.id, 'msg-1')).toBe(false);
  });

  it('returns false for operations on nonexistent talk', () => {
    expect(store.addPin('nonexistent', 'msg-1')).toBe(false);
    expect(store.removePin('nonexistent', 'msg-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Context document
// ---------------------------------------------------------------------------

describe('Context document', () => {
  it('returns empty string when no context exists', async () => {
    const talk = store.createTalk();
    expect(await store.getContextMd(talk.id)).toBe('');
  });

  it('writes and reads context.md', async () => {
    const talk = store.createTalk();
    const content = '# Context\n\nUser is building a REST API.';
    await store.setContextMd(talk.id, content);
    expect(await store.getContextMd(talk.id)).toBe(content);
  });

  it('overwrites existing context.md', async () => {
    const talk = store.createTalk();
    await store.setContextMd(talk.id, 'Version 1');
    await store.setContextMd(talk.id, 'Version 2');
    expect(await store.getContextMd(talk.id)).toBe('Version 2');
  });

  it('returns empty string for invalid talk IDs', async () => {
    expect(await store.getContextMd('../escape')).toBe('');
  });

  it('is a no-op for setContextMd with invalid talk ID', async () => {
    await store.setContextMd('../escape', 'Should not write');
    // No error thrown, but also nothing written
    expect(await store.getContextMd('../escape')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Job management
// ---------------------------------------------------------------------------

describe('Job management', () => {
  it('addJob creates a job with correct fields', () => {
    const talk = store.createTalk();
    const job = store.addJob(talk.id, '0 9 * * *', 'Summarize overnight messages');

    expect(job).not.toBeNull();
    expect(job!.id).toMatch(/^[\da-f-]{36}$/);
    expect(job!.schedule).toBe('0 9 * * *');
    expect(job!.prompt).toBe('Summarize overnight messages');
    expect(job!.active).toBe(true);
    expect(job!.createdAt).toBeGreaterThan(0);
    expect(job!.lastRunAt).toBeUndefined();
    expect(job!.lastStatus).toBeUndefined();
  });

  it('getJob retrieves by talkId and jobId', () => {
    const talk = store.createTalk();
    const job = store.addJob(talk.id, '*/5 * * * *', 'Check status');

    const fetched = store.getJob(talk.id, job!.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(job!.id);
    expect(fetched!.prompt).toBe('Check status');
  });

  it('getJob returns null for unknown jobId', () => {
    const talk = store.createTalk();
    store.addJob(talk.id, '0 * * * *', 'Some job');
    expect(store.getJob(talk.id, 'nonexistent')).toBeNull();
  });

  it('getJob returns null for unknown talkId', () => {
    expect(store.getJob('nonexistent', 'any-job-id')).toBeNull();
  });

  it('listJobs returns all jobs for a talk', () => {
    const talk = store.createTalk();
    store.addJob(talk.id, '0 9 * * *', 'Morning summary');
    store.addJob(talk.id, '0 17 * * *', 'Evening summary');
    store.addJob(talk.id, '*/30 * * * *', 'Status check');

    const jobs = store.listJobs(talk.id);
    expect(jobs).toHaveLength(3);
    expect(jobs.map(j => j.prompt)).toEqual([
      'Morning summary',
      'Evening summary',
      'Status check',
    ]);
  });

  it('listJobs returns empty array for talk with no jobs', () => {
    const talk = store.createTalk();
    expect(store.listJobs(talk.id)).toEqual([]);
  });

  it('listJobs returns empty array for nonexistent talk', () => {
    expect(store.listJobs('nonexistent')).toEqual([]);
  });

  it('updateJob updates active, schedule, prompt, lastRunAt, lastStatus', () => {
    const talk = store.createTalk();
    const job = store.addJob(talk.id, '0 9 * * *', 'Original prompt');

    const now = Date.now();
    const updated = store.updateJob(talk.id, job!.id, {
      active: false,
      schedule: '0 10 * * *',
      prompt: 'Updated prompt',
      lastRunAt: now,
      lastStatus: 'success',
    });

    expect(updated).not.toBeNull();
    expect(updated!.active).toBe(false);
    expect(updated!.schedule).toBe('0 10 * * *');
    expect(updated!.prompt).toBe('Updated prompt');
    expect(updated!.lastRunAt).toBe(now);
    expect(updated!.lastStatus).toBe('success');
  });

  it('updateJob with partial fields only changes specified fields', () => {
    const talk = store.createTalk();
    const job = store.addJob(talk.id, '0 9 * * *', 'Keep this prompt');

    const updated = store.updateJob(talk.id, job!.id, { active: false });

    expect(updated).not.toBeNull();
    expect(updated!.active).toBe(false);
    expect(updated!.schedule).toBe('0 9 * * *');
    expect(updated!.prompt).toBe('Keep this prompt');
  });

  it('updateJob returns null for unknown jobId', () => {
    const talk = store.createTalk();
    expect(store.updateJob(talk.id, 'nonexistent', { active: false })).toBeNull();
  });

  it('updateJob returns null for unknown talkId', () => {
    expect(store.updateJob('nonexistent', 'any-id', { active: false })).toBeNull();
  });

  it('deleteJob removes a job', () => {
    const talk = store.createTalk();
    const job = store.addJob(talk.id, '0 9 * * *', 'To be deleted');

    expect(store.deleteJob(talk.id, job!.id)).toBe(true);
    expect(store.getJob(talk.id, job!.id)).toBeNull();
    expect(store.listJobs(talk.id)).toHaveLength(0);
  });

  it('deleteJob returns false for unknown jobId', () => {
    const talk = store.createTalk();
    expect(store.deleteJob(talk.id, 'nonexistent')).toBe(false);
  });

  it('deleteJob returns false for unknown talkId', () => {
    expect(store.deleteJob('nonexistent', 'any-id')).toBe(false);
  });

  it('getAllActiveJobs returns active jobs across all talks', () => {
    const t1 = store.createTalk();
    const t2 = store.createTalk();

    const j1 = store.addJob(t1.id, '0 9 * * *', 'Active job 1');
    const j2 = store.addJob(t1.id, '0 17 * * *', 'Inactive job');
    store.updateJob(t1.id, j2!.id, { active: false });
    const j3 = store.addJob(t2.id, '*/10 * * * *', 'Active job 2');

    const active = store.getAllActiveJobs();
    expect(active).toHaveLength(2);

    const activeIds = active.map(a => a.job.id);
    expect(activeIds).toContain(j1!.id);
    expect(activeIds).toContain(j3!.id);

    // Verify talkId is correct
    const j1Entry = active.find(a => a.job.id === j1!.id);
    expect(j1Entry!.talkId).toBe(t1.id);
    const j3Entry = active.find(a => a.job.id === j3!.id);
    expect(j3Entry!.talkId).toBe(t2.id);
  });

  it('getAllActiveJobs returns empty array when no active jobs', () => {
    const talk = store.createTalk();
    const job = store.addJob(talk.id, '0 9 * * *', 'Will be deactivated');
    store.updateJob(talk.id, job!.id, { active: false });

    expect(store.getAllActiveJobs()).toEqual([]);
  });

  it('addJob to non-existent talk returns null', () => {
    expect(store.addJob('nonexistent', '0 9 * * *', 'Should fail')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Job reports (JSONL)
// ---------------------------------------------------------------------------

describe('Job reports', () => {
  function makeReport(overrides: Partial<JobReport> = {}): JobReport {
    return {
      id: `rpt-${Math.random().toString(36).slice(2, 8)}`,
      jobId: 'job-default',
      talkId: 'talk-default',
      runAt: Date.now(),
      status: 'success',
      summary: 'All good',
      fullOutput: 'Detailed output here',
      ...overrides,
    };
  }

  it('appendReport and getReports round-trip', async () => {
    const talk = store.createTalk();
    const r1 = makeReport({ talkId: talk.id, jobId: 'job-1', summary: 'Report 1' });
    const r2 = makeReport({ talkId: talk.id, jobId: 'job-2', summary: 'Report 2' });

    await store.appendReport(talk.id, r1);
    await store.appendReport(talk.id, r2);

    const reports = await store.getReports(talk.id);
    expect(reports).toHaveLength(2);
    expect(reports[0].summary).toBe('Report 1');
    expect(reports[0].jobId).toBe('job-1');
    expect(reports[1].summary).toBe('Report 2');
    expect(reports[1].jobId).toBe('job-2');
  });

  it('getReports with jobId filter', async () => {
    const talk = store.createTalk();
    await store.appendReport(talk.id, makeReport({ talkId: talk.id, jobId: 'job-A', summary: 'A1' }));
    await store.appendReport(talk.id, makeReport({ talkId: talk.id, jobId: 'job-B', summary: 'B1' }));
    await store.appendReport(talk.id, makeReport({ talkId: talk.id, jobId: 'job-A', summary: 'A2' }));

    const jobAReports = await store.getReports(talk.id, 'job-A');
    expect(jobAReports).toHaveLength(2);
    expect(jobAReports[0].summary).toBe('A1');
    expect(jobAReports[1].summary).toBe('A2');

    const jobBReports = await store.getReports(talk.id, 'job-B');
    expect(jobBReports).toHaveLength(1);
    expect(jobBReports[0].summary).toBe('B1');
  });

  it('getRecentReports with limit', async () => {
    const talk = store.createTalk();
    for (let i = 0; i < 10; i++) {
      await store.appendReport(talk.id, makeReport({
        talkId: talk.id,
        jobId: 'job-1',
        summary: `Report ${i}`,
      }));
    }

    const recent = await store.getRecentReports(talk.id, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].summary).toBe('Report 7');
    expect(recent[1].summary).toBe('Report 8');
    expect(recent[2].summary).toBe('Report 9');
  });

  it('getRecentReports with limit and jobId filter', async () => {
    const talk = store.createTalk();
    for (let i = 0; i < 5; i++) {
      await store.appendReport(talk.id, makeReport({
        talkId: talk.id,
        jobId: 'job-X',
        summary: `X-${i}`,
      }));
      await store.appendReport(talk.id, makeReport({
        talkId: talk.id,
        jobId: 'job-Y',
        summary: `Y-${i}`,
      }));
    }

    const recent = await store.getRecentReports(talk.id, 2, 'job-X');
    expect(recent).toHaveLength(2);
    expect(recent[0].summary).toBe('X-3');
    expect(recent[1].summary).toBe('X-4');
  });

  it('reports for non-existent talk returns empty array', async () => {
    expect(await store.getReports('nonexistent')).toEqual([]);
  });

  it('reports for talk with no reports returns empty array', async () => {
    const talk = store.createTalk();
    expect(await store.getReports(talk.id)).toEqual([]);
  });

  it('appendReport preserves all report fields', async () => {
    const talk = store.createTalk();
    const report = makeReport({
      id: 'rpt-full',
      talkId: talk.id,
      jobId: 'job-full',
      runAt: 1700000000000,
      status: 'error',
      summary: 'Something broke',
      fullOutput: 'Stack trace...',
      tokenUsage: { input: 100, output: 200 },
    });

    await store.appendReport(talk.id, report);

    const reports = await store.getReports(talk.id);
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe('rpt-full');
    expect(reports[0].jobId).toBe('job-full');
    expect(reports[0].runAt).toBe(1700000000000);
    expect(reports[0].status).toBe('error');
    expect(reports[0].summary).toBe('Something broke');
    expect(reports[0].fullOutput).toBe('Stack trace...');
    expect(reports[0].tokenUsage).toEqual({ input: 100, output: 200 });
  });
});
