/**
 * Talk Store
 *
 * Persistent storage for Talks — metadata, message history (JSONL),
 * and AI-maintained context documents. All writes are async
 * (fire-and-forget for non-critical paths, awaited for critical ones).
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
import type { TalkMeta, TalkMessage, TalkJob, JobReport, Logger } from './types.js';

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME || '~',
  '.moltbot',
  'plugins',
  'remoteclaw',
);

/** Validate that a talk ID is safe for use as a directory name. */
function isValidId(id: string): boolean {
  return /^[\w-]+$/.test(id) && !id.includes('..');
}

export class TalkStore {
  private readonly talksDir: string;
  private readonly talks: Map<string, TalkMeta> = new Map();
  private readonly logger: Logger;

  constructor(dataDir: string | undefined, logger: Logger) {
    this.talksDir = path.join(dataDir || DEFAULT_DATA_DIR, 'talks');
    this.logger = logger;
    this.ensureDir();
    this.loadAll();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.talksDir)) {
      fs.mkdirSync(this.talksDir, { recursive: true });
    }
  }

  private loadAll(): void {
    try {
      const dirs = fs.readdirSync(this.talksDir);
      for (const dir of dirs) {
        if (!isValidId(dir)) continue;
        const metaPath = path.join(this.talksDir, dir, 'talk.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as TalkMeta;
            // Ensure arrays exist (for older files)
            meta.pinnedMessageIds ??= [];
            meta.jobs ??= [];
            this.talks.set(meta.id, meta);
          } catch (err) {
            this.logger.warn(`TalkStore: skipping corrupted talk ${dir}: ${err}`);
          }
        }
      }
      this.logger.info(`TalkStore: loaded ${this.talks.size} talks`);
    } catch (err) {
      this.logger.warn(`TalkStore: failed to read talks dir: ${err}`);
    }
  }

  // -------------------------------------------------------------------------
  // Talk CRUD
  // -------------------------------------------------------------------------

  createTalk(model?: string): TalkMeta {
    const id = randomUUID();
    const now = Date.now();
    const meta: TalkMeta = {
      id,
      model,
      pinnedMessageIds: [],
      jobs: [],
      createdAt: now,
      updatedAt: now,
    };
    this.talks.set(id, meta);
    this.persistMeta(meta);
    return meta;
  }

  getTalk(id: string): TalkMeta | null {
    return this.talks.get(id) ?? null;
  }

  listTalks(): TalkMeta[] {
    return Array.from(this.talks.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  updateTalk(id: string, updates: Partial<Pick<TalkMeta, 'topicTitle' | 'objective' | 'model'>>): TalkMeta | null {
    const meta = this.talks.get(id);
    if (!meta) return null;

    if (updates.topicTitle !== undefined) meta.topicTitle = updates.topicTitle;
    if (updates.objective !== undefined) meta.objective = updates.objective;
    if (updates.model !== undefined) meta.model = updates.model;
    meta.updatedAt = Date.now();

    this.persistMeta(meta);
    return meta;
  }

  deleteTalk(id: string): boolean {
    if (!this.talks.has(id)) return false;
    this.talks.delete(id);
    if (isValidId(id)) {
      const talkDir = path.join(this.talksDir, id);
      fsp.rm(talkDir, { recursive: true, force: true }).catch(() => {});
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Message history (JSONL)
  // -------------------------------------------------------------------------

  /** Append a message to the Talk's history file. */
  async appendMessage(talkId: string, msg: TalkMessage): Promise<void> {
    if (!isValidId(talkId)) return;
    const dir = path.join(this.talksDir, talkId);
    await fsp.mkdir(dir, { recursive: true });
    const line = JSON.stringify(msg) + '\n';
    await fsp.appendFile(path.join(dir, 'history.jsonl'), line, 'utf-8');

    // Touch the talk
    const meta = this.talks.get(talkId);
    if (meta) {
      meta.updatedAt = Date.now();
      this.persistMeta(meta);
    }
  }

  /** Read all messages from a Talk's history. */
  async getMessages(talkId: string): Promise<TalkMessage[]> {
    if (!isValidId(talkId)) return [];
    const historyPath = path.join(this.talksDir, talkId, 'history.jsonl');
    if (!fs.existsSync(historyPath)) return [];

    const messages: TalkMessage[] = [];
    const stream = fs.createReadStream(historyPath, 'utf-8');
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as TalkMessage);
      } catch {
        // skip malformed lines
      }
    }
    return messages;
  }

  /** Read the last N messages from history. */
  async getRecentMessages(talkId: string, limit: number): Promise<TalkMessage[]> {
    const all = await this.getMessages(talkId);
    return all.slice(-limit);
  }

  /** Get a specific message by ID. */
  async getMessage(talkId: string, messageId: string): Promise<TalkMessage | null> {
    const all = await this.getMessages(talkId);
    return all.find(m => m.id === messageId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Pin management
  // -------------------------------------------------------------------------

  addPin(talkId: string, messageId: string): boolean {
    const meta = this.talks.get(talkId);
    if (!meta) return false;
    if (meta.pinnedMessageIds.includes(messageId)) return false;
    meta.pinnedMessageIds.push(messageId);
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
    return true;
  }

  removePin(talkId: string, messageId: string): boolean {
    const meta = this.talks.get(talkId);
    if (!meta) return false;
    const idx = meta.pinnedMessageIds.indexOf(messageId);
    if (idx === -1) return false;
    meta.pinnedMessageIds.splice(idx, 1);
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
    return true;
  }

  // -------------------------------------------------------------------------
  // Context document
  // -------------------------------------------------------------------------

  async getContextMd(talkId: string): Promise<string> {
    if (!isValidId(talkId)) return '';
    const ctxPath = path.join(this.talksDir, talkId, 'context.md');
    try {
      return await fsp.readFile(ctxPath, 'utf-8');
    } catch {
      return '';
    }
  }

  async setContextMd(talkId: string, content: string): Promise<void> {
    if (!isValidId(talkId)) return;
    const dir = path.join(this.talksDir, talkId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'context.md'), content, 'utf-8');
  }

  // -------------------------------------------------------------------------
  // Job management
  // -------------------------------------------------------------------------

  addJob(talkId: string, schedule: string, prompt: string): TalkJob | null {
    const meta = this.talks.get(talkId);
    if (!meta) return null;

    const job: TalkJob = {
      id: randomUUID(),
      schedule,
      prompt,
      active: true,
      createdAt: Date.now(),
    };

    meta.jobs.push(job);
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
    return job;
  }

  getJob(talkId: string, jobId: string): TalkJob | null {
    const meta = this.talks.get(talkId);
    if (!meta) return null;
    return meta.jobs.find(j => j.id === jobId) ?? null;
  }

  listJobs(talkId: string): TalkJob[] {
    const meta = this.talks.get(talkId);
    return meta?.jobs ?? [];
  }

  updateJob(talkId: string, jobId: string, updates: Partial<Pick<TalkJob, 'active' | 'schedule' | 'prompt' | 'lastRunAt' | 'lastStatus'>>): TalkJob | null {
    const meta = this.talks.get(talkId);
    if (!meta) return null;
    const job = meta.jobs.find(j => j.id === jobId);
    if (!job) return null;

    if (updates.active !== undefined) job.active = updates.active;
    if (updates.schedule !== undefined) job.schedule = updates.schedule;
    if (updates.prompt !== undefined) job.prompt = updates.prompt;
    if (updates.lastRunAt !== undefined) job.lastRunAt = updates.lastRunAt;
    if (updates.lastStatus !== undefined) job.lastStatus = updates.lastStatus;
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
    return job;
  }

  deleteJob(talkId: string, jobId: string): boolean {
    const meta = this.talks.get(talkId);
    if (!meta) return false;
    const idx = meta.jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return false;
    meta.jobs.splice(idx, 1);
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
    return true;
  }

  /** Get all active jobs across all talks. */
  getAllActiveJobs(): Array<{ talkId: string; job: TalkJob }> {
    const result: Array<{ talkId: string; job: TalkJob }> = [];
    for (const [talkId, meta] of this.talks) {
      for (const job of meta.jobs) {
        if (job.active) result.push({ talkId, job });
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Job reports (JSONL)
  // -------------------------------------------------------------------------

  async appendReport(talkId: string, report: JobReport): Promise<void> {
    if (!isValidId(talkId)) return;
    const dir = path.join(this.talksDir, talkId);
    await fsp.mkdir(dir, { recursive: true });
    const line = JSON.stringify(report) + '\n';
    await fsp.appendFile(path.join(dir, 'reports.jsonl'), line, 'utf-8');
  }

  async getReports(talkId: string, jobId?: string): Promise<JobReport[]> {
    if (!isValidId(talkId)) return [];
    const reportsPath = path.join(this.talksDir, talkId, 'reports.jsonl');
    if (!fs.existsSync(reportsPath)) return [];

    const reports: JobReport[] = [];
    const stream = fs.createReadStream(reportsPath, 'utf-8');
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const report = JSON.parse(line) as JobReport;
        if (!jobId || report.jobId === jobId) {
          reports.push(report);
        }
      } catch {
        // skip malformed lines
      }
    }
    return reports;
  }

  async getRecentReports(talkId: string, limit: number, jobId?: string): Promise<JobReport[]> {
    const all = await this.getReports(talkId, jobId);
    return all.slice(-limit);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private persistMeta(meta: TalkMeta): void {
    if (!isValidId(meta.id)) return;
    const dir = path.join(this.talksDir, meta.id);
    fsp.mkdir(dir, { recursive: true })
      .then(() => fsp.writeFile(path.join(dir, 'talk.json'), JSON.stringify(meta, null, 2)))
      .catch((err) => this.logger.warn(`TalkStore: persist failed for ${meta.id}: ${err}`));
  }
}
