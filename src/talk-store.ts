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
import type {
  TalkMeta,
  TalkMessage,
  TalkJob,
  TalkAgent,
  TalkDirective,
  TalkPlatformBinding,
  TalkPlatformBehavior,
  JobReport,
  JobOutputDestination,
  Directive,
  PlatformBinding,
  PlatformBehavior,
  PlatformPermission,
  TalkStateCarryOverMode,
  TalkStateEvent,
  TalkStatePolicy,
  TalkStateSnapshot,
  TalkDiagnosticCategory,
  TalkDiagnosticIssue,
  TalkDiagnosticStatus,
  Logger,
} from './types.js';

type TalkMutationType =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'message_appended'
  | 'messages_deleted'
  | 'pin_added'
  | 'pin_removed'
  | 'job_added'
  | 'job_updated'
  | 'job_deleted'
  | 'agent_added'
  | 'agent_removed'
  | 'agents_set'
  | 'directives_set'
  | 'bindings_set'
  | 'behaviors_set'
  | 'state_updated'
  | 'diagnostic_opened'
  | 'diagnostic_updated';

export type TalkStoreChangeEvent = {
  type: TalkMutationType;
  talkId: string;
  talkVersion: number;
  changeId: string;
  timestamp: number;
  lastModifiedBy?: string;
};

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME || '~',
  '.openclaw',
  'plugins',
  'clawtalk',
);

/** Threshold below which getRecentMessages does a full load + slice. */
const SMALL_FILE_BYTES = 64 * 1024; // 64KB

/** TTL for context.md cache entries. */
const CONTEXT_CACHE_TTL_MS = 30_000;
const DEFAULT_STATE_STREAM = 'default';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STATE_POLICY_BASE = {
  timezone: 'America/Los_Angeles',
  weekStartDay: 1,
  rolloverHour: 0,
  rolloverMinute: 0,
  carryOverMode: 'excess_only' as TalkStateCarryOverMode,
  targetMinutes: 300,
};

/** Validate that a talk ID is safe for use as a directory name. */
function isValidId(id: string): boolean {
  return /^[\w-]+$/.test(id) && !id.includes('..');
}

function normalizePermission(raw: unknown): PlatformPermission {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'read' || value === 'write' || value === 'read+write') {
    return value;
  }
  return 'read+write';
}

function normalizeToolMode(raw: unknown): 'off' | 'confirm' | 'auto' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'off' || value === 'confirm' || value === 'auto') return value;
  return 'auto';
}

function normalizeResponseMode(raw: unknown): 'off' | 'mentions' | 'all' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'off' || value === 'mentions' || value === 'all') return value;
  return undefined;
}

function normalizeMirrorToTalk(raw: unknown): 'off' | 'inbound' | 'full' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'off' || value === 'inbound' || value === 'full') return value;
  return undefined;
}

function normalizeDeliveryMode(raw: unknown): 'thread' | 'channel' | 'adaptive' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'thread' || value === 'channel' || value === 'adaptive') return value;
  return undefined;
}

function normalizeTriggerPolicy(raw: unknown): 'judgment' | 'study_entries_only' | 'advice_or_study' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'judgment' || value === 'study_entries_only' || value === 'advice_or_study') return value;
  return undefined;
}

function normalizeAllowedSenders(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const value = entry.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeExecutionMode(raw: unknown): 'openclaw' | 'full_control' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'openclaw' || value === 'full_control') return value;
  // Migrate old values
  if (value === 'unsandboxed') return 'full_control';
  if (value === 'inherit' || value === 'sandboxed') return 'openclaw';
  return 'openclaw';
}

function normalizeFilesystemAccess(raw: unknown): 'workspace_sandbox' | 'full_host_access' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'workspace_sandbox' || value === 'workspace' || value === 'sandbox') return 'workspace_sandbox';
  if (value === 'full_host_access' || value === 'full_host' || value === 'full') return 'full_host_access';
  return 'full_host_access';
}

function normalizeNetworkAccess(raw: unknown): 'restricted' | 'full_outbound' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'restricted') return 'restricted';
  if (value === 'full_outbound' || value === 'full') return 'full_outbound';
  return 'full_outbound';
}

function normalizeStateBackend(raw: unknown): 'stream_store' | 'workspace_files' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'workspace_files' || value === 'workspace') return 'workspace_files';
  return 'stream_store';
}

function normalizeToolNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!name) continue;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function normalizeGoogleAuthProfile(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || undefined;
}

function normalizeStateStream(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return DEFAULT_STATE_STREAM;
  const normalized = value.replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || DEFAULT_STATE_STREAM;
}

function normalizeOptionalStateStream(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return normalizeStateStream(trimmed);
}

function normalizeCarryOverMode(raw: unknown): TalkStateCarryOverMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'none' || value === 'excess_only' || value === 'all') return value;
  return DEFAULT_STATE_POLICY_BASE.carryOverMode;
}

function normalizeStatePolicy(
  stream: string,
  raw: Partial<TalkStatePolicy> | undefined,
  now = Date.now(),
): TalkStatePolicy {
  return {
    stream: normalizeStateStream(stream),
    timezone:
      typeof raw?.timezone === 'string' && raw.timezone.trim()
        ? raw.timezone.trim()
        : DEFAULT_STATE_POLICY_BASE.timezone,
    weekStartDay:
      typeof raw?.weekStartDay === 'number' && Number.isInteger(raw.weekStartDay)
        ? Math.max(0, Math.min(6, raw.weekStartDay))
        : DEFAULT_STATE_POLICY_BASE.weekStartDay,
    rolloverHour:
      typeof raw?.rolloverHour === 'number' && Number.isInteger(raw.rolloverHour)
        ? Math.max(0, Math.min(23, raw.rolloverHour))
        : DEFAULT_STATE_POLICY_BASE.rolloverHour,
    rolloverMinute:
      typeof raw?.rolloverMinute === 'number' && Number.isInteger(raw.rolloverMinute)
        ? Math.max(0, Math.min(59, raw.rolloverMinute))
        : DEFAULT_STATE_POLICY_BASE.rolloverMinute,
    carryOverMode: normalizeCarryOverMode(raw?.carryOverMode),
    targetMinutes:
      typeof raw?.targetMinutes === 'number' && Number.isFinite(raw.targetMinutes) && raw.targetMinutes > 0
        ? Math.floor(raw.targetMinutes)
        : DEFAULT_STATE_POLICY_BASE.targetMinutes,
    updatedAt: typeof raw?.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
}

function formatWeekKeyFromPseudoUtc(startAt: number): string {
  const d = new Date(startAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function resolveWeekWindow(ts: number, policy: TalkStatePolicy): { weekKey: string; weekStartAt: number; weekEndAt: number } {
  const date = new Date(ts);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: policy.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const partMap = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(partMap.get('year') ?? '0');
  const month = Number(partMap.get('month') ?? '1');
  const day = Number(partMap.get('day') ?? '1');
  const hour = Number(partMap.get('hour') ?? '0');
  const minute = Number(partMap.get('minute') ?? '0');
  const second = Number(partMap.get('second') ?? '0');

  let pseudoNow = Date.UTC(year, month - 1, day, hour, minute, second);
  if (hour < policy.rolloverHour || (hour === policy.rolloverHour && minute < policy.rolloverMinute)) {
    pseudoNow -= DAY_MS;
  }
  const pseudoDate = new Date(pseudoNow);
  const pseudoWeekday = pseudoDate.getUTCDay();
  const daysSinceStart = (pseudoWeekday - policy.weekStartDay + 7) % 7;
  const weekStartDayAtMidnight = Date.UTC(
    pseudoDate.getUTCFullYear(),
    pseudoDate.getUTCMonth(),
    pseudoDate.getUTCDate(),
  ) - daysSinceStart * DAY_MS;
  const weekStartAt = weekStartDayAtMidnight + policy.rolloverHour * 60 * 60 * 1000 + policy.rolloverMinute * 60 * 1000;
  const weekEndAt = weekStartAt + 7 * DAY_MS;
  return {
    weekKey: formatWeekKeyFromPseudoUtc(weekStartAt),
    weekStartAt,
    weekEndAt,
  };
}

function normalizeKidKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  return value;
}

function normalizeDirectives(input: unknown): Directive[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  return input
    .filter((entry) => Boolean(entry && typeof entry === 'object'))
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const text = typeof row.text === 'string' ? row.text.trim() : '';
      if (!text) return null;
      const id =
        typeof row.id === 'string' && row.id.trim()
          ? row.id.trim()
          : randomUUID();
      return {
        id,
        text,
        active: row.active !== false,
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
      } satisfies Directive;
    })
    .filter((entry): entry is Directive => Boolean(entry));
}

function normalizeJobOutput(raw: unknown): JobOutputDestination {
  if (!raw || typeof raw !== 'object') {
    return { type: 'report_only' };
  }

  const row = raw as Record<string, unknown>;
  const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
  if (type === 'talk') {
    return { type: 'talk' };
  }

  if (type === 'slack') {
    const channelId = typeof row.channelId === 'string' ? row.channelId.trim() : '';
    const accountId = typeof row.accountId === 'string' ? row.accountId.trim() : '';
    const threadTs = typeof row.threadTs === 'string' ? row.threadTs.trim() : '';
    if (!channelId) return { type: 'report_only' };
    return {
      type: 'slack',
      channelId,
      ...(accountId ? { accountId } : {}),
      ...(threadTs ? { threadTs } : {}),
    };
  }

  return { type: 'report_only' };
}

function normalizeJob(raw: unknown): TalkJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;

  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const schedule = typeof row.schedule === 'string' ? row.schedule.trim() : '';
  const prompt = typeof row.prompt === 'string' ? row.prompt.trim() : '';
  if (!id || !schedule || !prompt) return null;

  const rawType = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
  const type: TalkJob['type'] =
    rawType === 'once' || rawType === 'recurring' || rawType === 'event'
      ? rawType
      : 'recurring';

  return {
    id,
    type,
    schedule,
    prompt,
    output: normalizeJobOutput(row.output),
    active: row.active !== false,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
    ...(typeof row.lastRunAt === 'number' ? { lastRunAt: row.lastRunAt } : {}),
    ...(typeof row.lastStatus === 'string' && row.lastStatus.trim()
      ? { lastStatus: row.lastStatus.trim() }
      : {}),
  };
}

function normalizeJobs(input: unknown): TalkJob[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(normalizeJob)
    .filter((job): job is TalkJob => Boolean(job));
}

function normalizePlatformBindings(input: unknown): PlatformBinding[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  return input
    .filter((entry) => Boolean(entry && typeof entry === 'object'))
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const platform = typeof row.platform === 'string' ? row.platform.trim() : '';
      const scope = typeof row.scope === 'string' ? row.scope.trim() : '';
      if (!platform || !scope) return null;
      const accountId = typeof row.accountId === 'string' ? row.accountId.trim() : '';
      const displayScope = typeof row.displayScope === 'string' ? row.displayScope.trim() : '';
      const id =
        typeof row.id === 'string' && row.id.trim()
          ? row.id.trim()
          : randomUUID();
      return {
        id,
        platform,
        scope,
        ...(accountId ? { accountId } : {}),
        ...(displayScope ? { displayScope } : {}),
        permission: normalizePermission(row.permission),
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
      } satisfies PlatformBinding;
    })
    .filter((entry): entry is PlatformBinding => Boolean(entry));
}

function normalizePlatformBehaviors(
  input: unknown,
  bindings?: TalkPlatformBinding[],
): PlatformBehavior[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const enforceBindingIds = Array.isArray(bindings);
  const bindingIds = new Set((bindings ?? []).map((binding) => binding.id));
  return input
    .filter((entry) => Boolean(entry && typeof entry === 'object'))
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const platformBindingId =
        typeof row.platformBindingId === 'string' ? row.platformBindingId.trim() : '';
      if (!platformBindingId) return null;
      if (enforceBindingIds && !bindingIds.has(platformBindingId)) return null;

      const agentName = typeof row.agentName === 'string' ? row.agentName.trim() : '';
      const onMessagePrompt = typeof row.onMessagePrompt === 'string' ? row.onMessagePrompt.trim() : '';
      const autoRespond = typeof row.autoRespond === 'boolean' ? row.autoRespond : undefined;
      const responseMode =
        normalizeResponseMode(row.responseMode) ??
        (autoRespond === false ? 'off' : autoRespond === true ? 'all' : undefined);
      const mirrorToTalk = normalizeMirrorToTalk(row.mirrorToTalk);
      const deliveryMode = normalizeDeliveryMode(row.deliveryMode);
      const responsePolicyRaw =
        row.responsePolicy && typeof row.responsePolicy === 'object'
          ? row.responsePolicy as Record<string, unknown>
          : undefined;
      const triggerPolicy = normalizeTriggerPolicy(responsePolicyRaw?.triggerPolicy);
      const allowedSenders = normalizeAllowedSenders(responsePolicyRaw?.allowedSenders);
      const minConfidence =
        typeof responsePolicyRaw?.minConfidence === 'number'
          ? responsePolicyRaw.minConfidence
          : undefined;
      if (
        !agentName &&
        !onMessagePrompt &&
        responseMode === undefined &&
        mirrorToTalk === undefined &&
        deliveryMode === undefined &&
        triggerPolicy === undefined &&
        allowedSenders === undefined &&
        minConfidence === undefined
      ) return null;

      const id =
        typeof row.id === 'string' && row.id.trim()
          ? row.id.trim()
          : randomUUID();

      return {
        id,
        platformBindingId,
        ...(responseMode !== undefined ? { responseMode } : {}),
        ...(mirrorToTalk !== undefined ? { mirrorToTalk } : {}),
        ...(agentName ? { agentName } : {}),
        ...(onMessagePrompt ? { onMessagePrompt } : {}),
        ...(deliveryMode !== undefined ? { deliveryMode } : {}),
        ...(
          triggerPolicy !== undefined || allowedSenders !== undefined || minConfidence !== undefined
            ? {
                responsePolicy: {
                  ...(triggerPolicy !== undefined ? { triggerPolicy } : {}),
                  ...(allowedSenders !== undefined ? { allowedSenders } : {}),
                  ...(minConfidence !== undefined ? { minConfidence } : {}),
                },
              }
            : {}
        ),
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : now,
      } satisfies PlatformBehavior;
    })
    .filter((entry): entry is PlatformBehavior => Boolean(entry));
}

function normalizeDiagnosticStatus(raw: unknown): TalkDiagnosticStatus {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'resolved') return 'resolved';
  if (value === 'dismissed') return 'dismissed';
  return 'open';
}

function normalizeDiagnosticCategory(raw: unknown): TalkDiagnosticCategory {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (
    value === 'state' ||
    value === 'filesystem' ||
    value === 'tools' ||
    value === 'routing' ||
    value === 'slack' ||
    value === 'intent'
  ) return value;
  return 'other';
}

function normalizeDiagnostics(input: unknown): TalkDiagnosticIssue[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const seen = new Set<string>();
  const normalized: TalkDiagnosticIssue[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : randomUUID();
    if (seen.has(id)) continue;
    seen.add(id);
    const code = typeof row.code === 'string' ? row.code.trim() : '';
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const message = typeof row.message === 'string' ? row.message.trim() : '';
    if (!code || !title || !message) continue;
    const status = normalizeDiagnosticStatus(row.status);
    const firstSeenAt = typeof row.firstSeenAt === 'number' && Number.isFinite(row.firstSeenAt)
      ? row.firstSeenAt
      : now;
    const lastSeenAt = typeof row.lastSeenAt === 'number' && Number.isFinite(row.lastSeenAt)
      ? row.lastSeenAt
      : firstSeenAt;
    const occurrences = typeof row.occurrences === 'number' && Number.isFinite(row.occurrences)
      ? Math.max(1, Math.floor(row.occurrences))
      : 1;
    const issue: TalkDiagnosticIssue = {
      id,
      code,
      category: normalizeDiagnosticCategory(row.category),
      title,
      message,
      status,
      firstSeenAt,
      lastSeenAt,
      occurrences,
      ...(typeof row.assumptionKey === 'string' && row.assumptionKey.trim()
        ? { assumptionKey: row.assumptionKey.trim() }
        : {}),
      ...(row.details && typeof row.details === 'object' && !Array.isArray(row.details)
        ? { details: row.details as Record<string, unknown> }
        : {}),
      ...(typeof row.resolvedAt === 'number' && Number.isFinite(row.resolvedAt)
        ? { resolvedAt: row.resolvedAt }
        : {}),
      ...(typeof row.dismissedAt === 'number' && Number.isFinite(row.dismissedAt)
        ? { dismissedAt: row.dismissedAt }
        : {}),
    };
    normalized.push(issue);
  }
  return normalized.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export class TalkStore {
  private readonly talksDir: string;
  private readonly talks: Map<string, TalkMeta> = new Map();
  private readonly logger: Logger;
  private readonly instanceId: string = randomUUID().slice(0, 8);
  private readonly changeListeners = new Set<(event: TalkStoreChangeEvent) => void>();
  private readonly stateLocks = new Map<string, Promise<unknown>>();

  // Caches
  private listTalksCache: TalkMeta[] | null = null;
  private contextCache = new Map<string, { content: string; expiresAt: number }>();

  onChange(listener: (event: TalkStoreChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emitChange(event: TalkStoreChangeEvent): void {
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn(`TalkStore: change listener failed: ${String(err)}`);
      }
    }
  }

  private touchMeta(
    meta: TalkMeta,
    type: TalkMutationType,
    options?: { modifiedBy?: string; skipVersionBump?: boolean },
  ): void {
    const now = Date.now();
    if (!options?.skipVersionBump) {
      meta.talkVersion = Math.max(1, Math.floor(meta.talkVersion || 0) + 1);
      meta.changeId = randomUUID();
      meta.lastModifiedAt = now;
      meta.lastModifiedBy = options?.modifiedBy || 'gateway';
    }
    meta.updatedAt = now;
    this.invalidateListCache();
    this.persistMeta(meta);
    this.emitChange({
      type,
      talkId: meta.id,
      talkVersion: meta.talkVersion,
      changeId: meta.changeId,
      timestamp: now,
      ...(meta.lastModifiedBy ? { lastModifiedBy: meta.lastModifiedBy } : {}),
    });
  }

  constructor(dataDir: string | undefined, logger: Logger) {
    this.talksDir = path.join(dataDir || DEFAULT_DATA_DIR, 'talks');
    this.logger = logger;
    // Constructor no longer calls sync loadAll — use init() instead
  }

  /** Async initialization — call this before using the store. */
  async init(): Promise<void> {
    await this.ensureDir();
    await this.loadAllAsync();
    await this.clearStaleProcessingFlags();
  }

  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.talksDir, { recursive: true });
  }

  private async loadAllAsync(): Promise<void> {
    try {
      this.talks.clear();
      this.invalidateListCache();
      const dirs = await fsp.readdir(this.talksDir);
      for (const dir of dirs) {
        if (!isValidId(dir)) continue;
        const metaPath = path.join(this.talksDir, dir, 'talk.json');
        try {
          const raw = await fsp.readFile(metaPath, 'utf-8');
          const meta = JSON.parse(raw) as TalkMeta;
          // Ensure arrays exist (for older files)
          meta.pinnedMessageIds ??= [];
          meta.jobs = normalizeJobs(meta.jobs);
          meta.agents ??= [];
          meta.directives = normalizeDirectives(meta.directives);
          meta.platformBindings = normalizePlatformBindings(meta.platformBindings);
          meta.platformBehaviors = normalizePlatformBehaviors(meta.platformBehaviors, meta.platformBindings);
          meta.toolMode = normalizeToolMode(meta.toolMode);
          meta.executionMode = normalizeExecutionMode(meta.executionMode);
          meta.filesystemAccess = normalizeFilesystemAccess(meta.filesystemAccess);
          meta.networkAccess = normalizeNetworkAccess(meta.networkAccess);
          meta.stateBackend = normalizeStateBackend(meta.stateBackend);
          meta.toolsAllow = normalizeToolNames(meta.toolsAllow);
          meta.toolsDeny = normalizeToolNames(meta.toolsDeny);
          meta.googleAuthProfile = normalizeGoogleAuthProfile(meta.googleAuthProfile);
          meta.defaultStateStream = normalizeOptionalStateStream(meta.defaultStateStream);
          meta.diagnostics = normalizeDiagnostics(meta.diagnostics);
          meta.talkVersion =
            typeof meta.talkVersion === 'number' && Number.isFinite(meta.talkVersion)
              ? Math.max(1, Math.floor(meta.talkVersion))
              : 1;
          meta.changeId =
            typeof meta.changeId === 'string' && meta.changeId.trim()
              ? meta.changeId
              : randomUUID();
          meta.lastModifiedAt =
            typeof meta.lastModifiedAt === 'number' && Number.isFinite(meta.lastModifiedAt)
              ? meta.lastModifiedAt
              : meta.updatedAt;
          if (meta.lastModifiedBy !== undefined && typeof meta.lastModifiedBy !== 'string') {
            delete meta.lastModifiedBy;
          }
          if (meta.processing === undefined) {
            meta.processing = false;
          }
          this.talks.set(meta.id, meta);
          this.invalidateListCache();
        } catch (err) {
          // File may not exist or be corrupted — skip it
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.logger.warn(`TalkStore: skipping corrupted talk ${dir}: ${err}`);
          }
        }
      }
      const slackBindings: string[] = [];
      for (const talk of this.talks.values()) {
        for (const binding of talk.platformBindings ?? []) {
          if (binding.platform.trim().toLowerCase() !== 'slack') continue;
          slackBindings.push(`${talk.id}:${binding.scope}:${binding.accountId ?? '-'}`);
        }
      }
      this.logger.info(
        `TalkStore[${this.instanceId}]: loaded ${this.talks.size} talks from ${this.talksDir} ` +
        `(slackBindings=${slackBindings.length}${slackBindings.length ? ` [${slackBindings.join(' | ')}]` : ''})`,
      );
    } catch (err) {
      this.logger.warn(`TalkStore: failed to read talks dir: ${err}`);
    }
  }

  /** Invalidate listTalks sorted cache. */
  private invalidateListCache(): void {
    this.listTalksCache = null;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  // -------------------------------------------------------------------------
  // Talk CRUD
  // -------------------------------------------------------------------------

  createTalk(model?: string): TalkMeta {
    const id = randomUUID();
    const now = Date.now();
    const meta: TalkMeta = {
      id,
      talkVersion: 1,
      changeId: randomUUID(),
      lastModifiedBy: 'gateway',
      lastModifiedAt: now,
      model,
      pinnedMessageIds: [],
      jobs: [],
      processing: false,
      directives: [],
      platformBindings: [],
      platformBehaviors: [],
      executionMode: 'openclaw',
      filesystemAccess: 'full_host_access',
      networkAccess: 'full_outbound',
      stateBackend: 'stream_store',
      toolMode: 'auto',
      toolsAllow: [],
      toolsDeny: [],
      diagnostics: [],
      createdAt: now,
      updatedAt: now,
    };
    this.talks.set(id, meta);
    this.touchMeta(meta, 'created', { modifiedBy: 'gateway', skipVersionBump: true });
    return meta;
  }

  getTalk(id: string): TalkMeta | null {
    return this.talks.get(id) ?? null;
  }

  getTalkVersion(id: string): number | null {
    const meta = this.talks.get(id);
    return meta ? meta.talkVersion : null;
  }

  listTalks(): TalkMeta[] {
    if (this.listTalksCache) return [...this.listTalksCache];
    const sorted = Array.from(this.talks.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
    this.listTalksCache = sorted;
    return [...sorted];
  }

  updateTalk(
    id: string,
    updates: Partial<
      Pick<
        TalkMeta,
        'topicTitle' | 'objective' | 'model' | 'agents' | 'directives' | 'platformBindings' | 'platformBehaviors' | 'toolMode' | 'executionMode' | 'filesystemAccess' | 'networkAccess' | 'stateBackend' | 'toolsAllow' | 'toolsDeny' | 'googleAuthProfile' | 'defaultStateStream'
      >
    >,
    options?: { modifiedBy?: string },
  ): TalkMeta | null {
    const meta = this.talks.get(id);
    if (!meta) return null;

    if (updates.topicTitle !== undefined) meta.topicTitle = updates.topicTitle;
    if (updates.objective !== undefined) meta.objective = updates.objective;
    if (updates.model !== undefined) meta.model = updates.model;
    if (updates.agents !== undefined) meta.agents = updates.agents;
    if (updates.directives !== undefined) meta.directives = normalizeDirectives(updates.directives);
    if (updates.platformBindings !== undefined) {
      meta.platformBindings = normalizePlatformBindings(updates.platformBindings);
      meta.platformBehaviors = normalizePlatformBehaviors(meta.platformBehaviors, meta.platformBindings);
    }
    if (updates.platformBehaviors !== undefined) {
      meta.platformBehaviors = normalizePlatformBehaviors(
        updates.platformBehaviors,
        meta.platformBindings,
      );
    }
    if (updates.toolMode !== undefined) {
      meta.toolMode = normalizeToolMode(updates.toolMode);
    }
    if (updates.executionMode !== undefined) {
      meta.executionMode = normalizeExecutionMode(updates.executionMode);
    }
    if (updates.filesystemAccess !== undefined) {
      meta.filesystemAccess = normalizeFilesystemAccess(updates.filesystemAccess);
    }
    if (updates.networkAccess !== undefined) {
      meta.networkAccess = normalizeNetworkAccess(updates.networkAccess);
    }
    if (updates.stateBackend !== undefined) {
      meta.stateBackend = normalizeStateBackend(updates.stateBackend);
    }
    if (updates.toolsAllow !== undefined) {
      meta.toolsAllow = normalizeToolNames(updates.toolsAllow);
    }
    if (updates.toolsDeny !== undefined) {
      meta.toolsDeny = normalizeToolNames(updates.toolsDeny);
    }
    if (updates.googleAuthProfile !== undefined) {
      meta.googleAuthProfile = normalizeGoogleAuthProfile(updates.googleAuthProfile);
    }
    if (updates.defaultStateStream !== undefined) {
      meta.defaultStateStream = normalizeOptionalStateStream(updates.defaultStateStream);
    }
    this.touchMeta(meta, 'updated', { modifiedBy: options?.modifiedBy });
    return meta;
  }

  resolveStateStream(
    talkId: string,
    explicitStream?: string,
  ): { ok: true; stream: string } | { ok: false; code: 'STATE_STREAM_REQUIRED' | 'STATE_BACKEND_WORKSPACE_FILES'; message: string } {
    const talk = this.talks.get(talkId);
    if (!talk) {
      return {
        ok: false,
        code: 'STATE_STREAM_REQUIRED',
        message: 'Talk not found',
      };
    }
    const backend = normalizeStateBackend(talk.stateBackend);
    if (backend === 'workspace_files') {
      return {
        ok: false,
        code: 'STATE_BACKEND_WORKSPACE_FILES',
        message: 'Talk stateBackend is workspace_files. Use file tools or switch talk.stateBackend to stream_store.',
      };
    }
    const explicit = normalizeOptionalStateStream(explicitStream);
    if (explicit) return { ok: true, stream: explicit };
    const talkDefault = normalizeOptionalStateStream(talk.defaultStateStream);
    if (talkDefault) return { ok: true, stream: talkDefault };
    return { ok: true, stream: DEFAULT_STATE_STREAM };
  }

  listDiagnostics(talkId: string): TalkDiagnosticIssue[] {
    const talk = this.talks.get(talkId);
    if (!talk) return [];
    return [...(talk.diagnostics ?? [])].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  openDiagnostic(
    talkId: string,
    input: {
      code: string;
      category: TalkDiagnosticCategory;
      title: string;
      message: string;
      assumptionKey?: string;
      details?: Record<string, unknown>;
    },
    options?: { modifiedBy?: string },
  ): { issue: TalkDiagnosticIssue; created: boolean } | null {
    const talk = this.talks.get(talkId);
    if (!talk) return null;
    const now = Date.now();
    const diagnostics = talk.diagnostics ?? [];
    const normalizedCode = input.code.trim();
    const normalizedAssumptionKey = input.assumptionKey?.trim();
    const existing = diagnostics.find((issue) =>
      issue.status === 'open' &&
      (
        (normalizedAssumptionKey && issue.assumptionKey === normalizedAssumptionKey) ||
        (!normalizedAssumptionKey && issue.code === normalizedCode)
      ));
    if (existing) {
      existing.lastSeenAt = now;
      existing.occurrences += 1;
      if (input.details && Object.keys(input.details).length > 0) {
        existing.details = { ...(existing.details ?? {}), ...input.details };
      }
      this.touchMeta(talk, 'diagnostic_updated', { modifiedBy: options?.modifiedBy });
      return { issue: existing, created: false };
    }

    const issue: TalkDiagnosticIssue = {
      id: randomUUID(),
      code: normalizedCode || 'unknown_issue',
      category: normalizeDiagnosticCategory(input.category),
      title: input.title.trim() || 'Issue detected',
      message: input.message.trim() || 'An issue was detected.',
      status: 'open',
      firstSeenAt: now,
      lastSeenAt: now,
      occurrences: 1,
      ...(normalizedAssumptionKey ? { assumptionKey: normalizedAssumptionKey } : {}),
      ...(input.details && Object.keys(input.details).length > 0 ? { details: input.details } : {}),
    };
    diagnostics.unshift(issue);
    talk.diagnostics = diagnostics;
    this.touchMeta(talk, 'diagnostic_opened', { modifiedBy: options?.modifiedBy });
    return { issue, created: true };
  }

  updateDiagnosticStatus(
    talkId: string,
    issueId: string,
    status: TalkDiagnosticStatus,
    options?: { modifiedBy?: string },
  ): TalkDiagnosticIssue | null {
    const talk = this.talks.get(talkId);
    if (!talk) return null;
    const diagnostics = talk.diagnostics ?? [];
    const issue = diagnostics.find((entry) => entry.id === issueId);
    if (!issue) return null;
    const now = Date.now();
    issue.status = normalizeDiagnosticStatus(status);
    issue.lastSeenAt = now;
    if (issue.status === 'resolved') {
      issue.resolvedAt = now;
      delete issue.dismissedAt;
    } else if (issue.status === 'dismissed') {
      issue.dismissedAt = now;
      delete issue.resolvedAt;
    } else {
      delete issue.resolvedAt;
      delete issue.dismissedAt;
    }
    this.touchMeta(talk, 'diagnostic_updated', { modifiedBy: options?.modifiedBy });
    return issue;
  }

  deleteTalk(id: string, options?: { modifiedBy?: string }): boolean {
    const existing = this.talks.get(id);
    if (!existing) return false;
    this.talks.delete(id);
    this.invalidateListCache();
    this.contextCache.delete(id);
    const now = Date.now();
    this.emitChange({
      type: 'deleted',
      talkId: id,
      talkVersion: existing.talkVersion + 1,
      changeId: randomUUID(),
      timestamp: now,
      ...(options?.modifiedBy ? { lastModifiedBy: options.modifiedBy } : {}),
    });
    if (isValidId(id)) {
      const talkDir = path.join(this.talksDir, id);
      fsp.rm(talkDir, { recursive: true, force: true }).catch((err) => {
        this.logger.error(`TalkStore: failed to delete talk directory ${id}: ${err}`);
      });
    }
    return true;
  }

  /** Set the processing flag without touching updatedAt (avoids re-triggering unread badge). */
  setProcessing(id: string, processing: boolean): void {
    const meta = this.talks.get(id);
    if (!meta) return;
    meta.processing = processing;
    this.invalidateListCache();
    this.persistMeta(meta);
  }

  /** Clear stale processing flags after startup/restart recovery. */
  async clearStaleProcessingFlags(): Promise<number> {
    let cleared = 0;
    for (const meta of this.talks.values()) {
      if (!meta.processing) continue;
      meta.processing = false;
      this.persistMeta(meta);
      cleared += 1;
    }
    if (cleared > 0) {
      this.invalidateListCache();
      this.logger.warn(`TalkStore: cleared stale processing flag for ${cleared} talk(s) on startup`);
    }
    return cleared;
  }

  // -------------------------------------------------------------------------
  // Message history (JSONL)
  // -------------------------------------------------------------------------

  /** Append a message to the Talk's history file. */
  async appendMessage(talkId: string, msg: TalkMessage, options?: { modifiedBy?: string }): Promise<void> {
    if (!isValidId(talkId)) return;
    const dir = path.join(this.talksDir, talkId);
    await fsp.mkdir(dir, { recursive: true });
    const line = JSON.stringify(msg) + '\n';
    await fsp.appendFile(path.join(dir, 'history.jsonl'), line, 'utf-8');

    // Touch the talk
    const meta = this.talks.get(talkId);
    if (meta) {
      this.touchMeta(meta, 'message_appended', { modifiedBy: options?.modifiedBy });
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

  /**
   * Read the last N messages from history.
   * For files < 64KB, does a full load + slice.
   * For larger files, reads backwards in chunks (tail-first).
   */
  async getRecentMessages(talkId: string, limit: number): Promise<TalkMessage[]> {
    if (!isValidId(talkId)) return [];
    const historyPath = path.join(this.talksDir, talkId, 'history.jsonl');

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(historyPath);
    } catch {
      return [];
    }

    // Small files: full load + slice (simpler, fast enough)
    if (stat.size < SMALL_FILE_BYTES) {
      const all = await this.getMessages(talkId);
      return all.slice(-limit);
    }

    // Large files: read backwards in chunks
    const fd = await fsp.open(historyPath, 'r');
    try {
      const messages: TalkMessage[] = [];
      const chunkSize = 16 * 1024; // 16KB chunks
      let position = stat.size;
      let trailing = '';

      while (position > 0 && messages.length < limit) {
        const readSize = Math.min(chunkSize, position);
        position -= readSize;
        const buf = Buffer.alloc(readSize);
        await fd.read(buf, 0, readSize, position);
        const chunk = buf.toString('utf-8') + trailing;
        trailing = '';

        const lines = chunk.split('\n');
        // First element may be a partial line (unless we're at the start of file)
        if (position > 0) {
          trailing = lines.shift()!;
        }

        // Process lines in reverse order
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            messages.unshift(JSON.parse(line) as TalkMessage);
            if (messages.length >= limit) break;
          } catch {
            // skip malformed lines
          }
        }
      }

      // Handle any remaining trailing data from the start of the file
      if (trailing.trim() && messages.length < limit) {
        try {
          messages.unshift(JSON.parse(trailing) as TalkMessage);
        } catch {
          // skip malformed
        }
      }

      return messages.slice(-limit);
    } finally {
      await fd.close();
    }
  }

  /**
   * Get a specific message by ID.
   * Streams JSONL line-by-line and stops on match instead of loading all.
   */
  async getMessage(talkId: string, messageId: string): Promise<TalkMessage | null> {
    if (!isValidId(talkId)) return null;
    const historyPath = path.join(this.talksDir, talkId, 'history.jsonl');
    if (!fs.existsSync(historyPath)) return null;

    const stream = fs.createReadStream(historyPath, 'utf-8');
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as TalkMessage;
          if (msg.id === messageId) {
            return msg;
          }
        } catch {
          // skip malformed lines
        }
      }
    } finally {
      stream.destroy();
    }
    return null;
  }

  /**
   * Delete messages by ID from a Talk's history.
   * Rewrites history.jsonl with surviving messages and cleans dangling pins.
   */
  async deleteMessages(
    talkId: string,
    messageIds: string[],
    options?: { modifiedBy?: string },
  ): Promise<{ deleted: number; remaining: number }> {
    if (!isValidId(talkId)) return { deleted: 0, remaining: 0 };
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      const existing = await this.getMessages(talkId);
      return { deleted: 0, remaining: existing.length };
    }

    const idSet = new Set(messageIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()));
    if (idSet.size === 0) {
      const existing = await this.getMessages(talkId);
      return { deleted: 0, remaining: existing.length };
    }

    const history = await this.getMessages(talkId);
    const remainingMessages = history.filter((msg) => !idSet.has(msg.id));
    const deleted = history.length - remainingMessages.length;
    const dir = path.join(this.talksDir, talkId);
    await fsp.mkdir(dir, { recursive: true });
    const historyPath = path.join(dir, 'history.jsonl');
    const content = remainingMessages.map((m) => JSON.stringify(m)).join('\n');
    await fsp.writeFile(historyPath, content ? `${content}\n` : '', 'utf-8');

    const meta = this.talks.get(talkId);
    if (meta) {
      const beforePins = meta.pinnedMessageIds.length;
      meta.pinnedMessageIds = meta.pinnedMessageIds.filter((id) => !idSet.has(id));
      if (deleted > 0 || meta.pinnedMessageIds.length !== beforePins) {
        this.touchMeta(meta, 'messages_deleted', { modifiedBy: options?.modifiedBy });
      }
    }

    return { deleted, remaining: remainingMessages.length };
  }

  // -------------------------------------------------------------------------
  // Pin management
  // -------------------------------------------------------------------------

  addPin(talkId: string, messageId: string, options?: { modifiedBy?: string }): boolean {
    const meta = this.talks.get(talkId);
    if (!meta) return false;
    if (meta.pinnedMessageIds.includes(messageId)) return false;
    meta.pinnedMessageIds.push(messageId);
    this.touchMeta(meta, 'pin_added', { modifiedBy: options?.modifiedBy });
    return true;
  }

  removePin(talkId: string, messageId: string, options?: { modifiedBy?: string }): boolean {
    const meta = this.talks.get(talkId);
    if (!meta) return false;
    const idx = meta.pinnedMessageIds.indexOf(messageId);
    if (idx === -1) return false;
    meta.pinnedMessageIds.splice(idx, 1);
    this.touchMeta(meta, 'pin_removed', { modifiedBy: options?.modifiedBy });
    return true;
  }

  // -------------------------------------------------------------------------
  // Context document (with TTL cache)
  // -------------------------------------------------------------------------

  async getContextMd(talkId: string): Promise<string> {
    if (!isValidId(talkId)) return '';

    // Check cache first
    const cached = this.contextCache.get(talkId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.content;
    }

    const ctxPath = path.join(this.talksDir, talkId, 'context.md');
    try {
      const content = await fsp.readFile(ctxPath, 'utf-8');
      this.contextCache.set(talkId, {
        content,
        expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS,
      });
      return content;
    } catch {
      return '';
    }
  }

  async setContextMd(talkId: string, content: string): Promise<void> {
    if (!isValidId(talkId)) return;
    const dir = path.join(this.talksDir, talkId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'context.md'), content, 'utf-8');
    // Invalidate cache
    this.contextCache.set(talkId, {
      content,
      expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS,
    });
  }

  // -------------------------------------------------------------------------
  // Job management
  // -------------------------------------------------------------------------

  addJob(
    talkId: string,
    schedule: string,
    prompt: string,
    type?: 'once' | 'recurring' | 'event',
    output?: JobOutputDestination,
    options?: { modifiedBy?: string },
  ): TalkJob | null {
    const meta = this.talks.get(talkId);
    if (!meta) return null;

    const job: TalkJob = {
      id: randomUUID(),
      type: type ?? 'recurring',
      schedule,
      prompt,
      output: normalizeJobOutput(output),
      active: true,
      createdAt: Date.now(),
    };

    meta.jobs.push(job);
    this.touchMeta(meta, 'job_added', { modifiedBy: options?.modifiedBy });
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

  updateJob(
    talkId: string,
    jobId: string,
    updates: Partial<Pick<TalkJob, 'active' | 'type' | 'schedule' | 'prompt' | 'output' | 'lastRunAt' | 'lastStatus'>>,
    options?: { modifiedBy?: string },
  ): TalkJob | null {
    const meta = this.talks.get(talkId);
    if (!meta) return null;
    const job = meta.jobs.find(j => j.id === jobId);
    if (!job) return null;

    if (updates.active !== undefined) job.active = updates.active;
    if (updates.type !== undefined) job.type = updates.type;
    if (updates.schedule !== undefined) job.schedule = updates.schedule;
    if (updates.prompt !== undefined) job.prompt = updates.prompt;
    if (updates.output !== undefined) job.output = normalizeJobOutput(updates.output);
    if (updates.lastRunAt !== undefined) job.lastRunAt = updates.lastRunAt;
    if (updates.lastStatus !== undefined) job.lastStatus = updates.lastStatus;
    this.touchMeta(meta, 'job_updated', { modifiedBy: options?.modifiedBy });
    return job;
  }

  deleteJob(talkId: string, jobId: string, options?: { modifiedBy?: string }): boolean {
    const meta = this.talks.get(talkId);
    if (!meta) return false;
    const idx = meta.jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return false;
    meta.jobs.splice(idx, 1);
    this.touchMeta(meta, 'job_deleted', { modifiedBy: options?.modifiedBy });
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
  // Agent management
  // -------------------------------------------------------------------------

  async addAgent(talkId: string, agent: TalkAgent, options?: { modifiedBy?: string }): Promise<TalkAgent> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    if (!meta.agents) meta.agents = [];
    meta.agents.push(agent);
    this.touchMeta(meta, 'agent_added', { modifiedBy: options?.modifiedBy });
    return agent;
  }

  async removeAgent(talkId: string, agentName: string, options?: { modifiedBy?: string }): Promise<void> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    const idx = (meta.agents ?? []).findIndex(a => a.name === agentName);
    if (idx === -1) throw new Error('Agent not found');
    meta.agents!.splice(idx, 1);
    this.touchMeta(meta, 'agent_removed', { modifiedBy: options?.modifiedBy });
  }

  listAgents(talkId: string): TalkAgent[] {
    const meta = this.talks.get(talkId);
    return meta?.agents ?? [];
  }

  async setAgents(talkId: string, agents: TalkAgent[], options?: { modifiedBy?: string }): Promise<void> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    meta.agents = agents;
    this.touchMeta(meta, 'agents_set', { modifiedBy: options?.modifiedBy });
  }

  // -------------------------------------------------------------------------
  // Directive management
  // -------------------------------------------------------------------------

  async setDirectives(talkId: string, directives: TalkDirective[], options?: { modifiedBy?: string }): Promise<void> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    meta.directives = directives;
    this.touchMeta(meta, 'directives_set', { modifiedBy: options?.modifiedBy });
  }

  // -------------------------------------------------------------------------
  // Platform binding management
  // -------------------------------------------------------------------------

  async setPlatformBindings(
    talkId: string,
    bindings: TalkPlatformBinding[],
    options?: { modifiedBy?: string },
  ): Promise<void> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    meta.platformBindings = normalizePlatformBindings(bindings);
    meta.platformBehaviors = normalizePlatformBehaviors(meta.platformBehaviors, meta.platformBindings);
    this.touchMeta(meta, 'bindings_set', { modifiedBy: options?.modifiedBy });
  }

  async setPlatformBehaviors(
    talkId: string,
    behaviors: TalkPlatformBehavior[],
    options?: { modifiedBy?: string },
  ): Promise<void> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    meta.platformBehaviors = normalizePlatformBehaviors(behaviors, meta.platformBindings);
    this.touchMeta(meta, 'behaviors_set', { modifiedBy: options?.modifiedBy });
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

  async getRecentReports(talkId: string, limit: number, jobId?: string, since?: number): Promise<JobReport[]> {
    let all = await this.getReports(talkId, jobId);
    if (since) {
      all = all.filter(r => r.runAt > since);
    }
    return all.slice(-limit);
  }

  // -------------------------------------------------------------------------
  // Structured talk state (event ledger + snapshot)
  // -------------------------------------------------------------------------

  private getStateBaseDir(talkId: string, stream: string): string {
    return path.join(this.talksDir, talkId, 'state', normalizeStateStream(stream));
  }

  private getStateEventsPath(talkId: string, stream: string): string {
    return path.join(this.getStateBaseDir(talkId, stream), 'events.jsonl');
  }

  private getStatePolicyPath(talkId: string, stream: string): string {
    return path.join(this.getStateBaseDir(talkId, stream), 'policy.json');
  }

  private getStateSnapshotPath(talkId: string, stream: string): string {
    return path.join(this.getStateBaseDir(talkId, stream), 'snapshot.json');
  }

  private async withStateLock<T>(talkId: string, stream: string, op: () => Promise<T>): Promise<T> {
    const key = `${talkId}:${normalizeStateStream(stream)}`;
    const previous = this.stateLocks.get(key) ?? Promise.resolve();
    const next = previous.then(op, op);
    const marker = next.then(() => undefined, () => undefined);
    this.stateLocks.set(key, marker);
    try {
      return await next;
    } finally {
      if (this.stateLocks.get(key) === marker) {
        this.stateLocks.delete(key);
      }
    }
  }

  private async readStateEvents(talkId: string, stream: string): Promise<TalkStateEvent[]> {
    const eventsPath = this.getStateEventsPath(talkId, stream);
    if (!fs.existsSync(eventsPath)) return [];
    const text = await fsp.readFile(eventsPath, 'utf-8');
    if (!text.trim()) return [];
    const events: TalkStateEvent[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as TalkStateEvent;
        if (!parsed || typeof parsed !== 'object') continue;
        if (typeof parsed.sequence !== 'number' || typeof parsed.type !== 'string') continue;
        events.push(parsed);
      } catch {
        // skip malformed lines
      }
    }
    events.sort((a, b) => a.sequence - b.sequence);
    return events;
  }

  private async readStatePolicy(talkId: string, stream: string): Promise<TalkStatePolicy> {
    const policyPath = this.getStatePolicyPath(talkId, stream);
    try {
      const raw = JSON.parse(await fsp.readFile(policyPath, 'utf-8')) as Partial<TalkStatePolicy>;
      return normalizeStatePolicy(stream, raw);
    } catch {
      return normalizeStatePolicy(stream, undefined);
    }
  }

  private computeCarryOver(
    totals: Record<string, number>,
    policy: TalkStatePolicy,
  ): Record<string, number> {
    const carry: Record<string, number> = {};
    for (const [kid, total] of Object.entries(totals)) {
      if (!Number.isFinite(total) || total <= 0) continue;
      if (policy.carryOverMode === 'all') {
        carry[kid] = total;
      } else if (policy.carryOverMode === 'excess_only') {
        carry[kid] = Math.max(0, total - policy.targetMinutes);
      }
    }
    return carry;
  }

  private applyStateEventToTotals(
    totals: Record<string, number>,
    event: TalkStateEvent,
  ): Record<string, number> {
    const next = { ...totals };
    const payload = event.payload ?? {};
    if (event.type === 'minutes_logged' || event.type === 'manual_adjustment') {
      const kid = normalizeKidKey((payload as Record<string, unknown>).kid);
      const minutesRaw = Number((payload as Record<string, unknown>).minutes);
      if (!kid || !Number.isFinite(minutesRaw)) return next;
      next[kid] = Math.max(0, (next[kid] ?? 0) + minutesRaw);
      return next;
    }
    if (event.type === 'set_total') {
      const kid = normalizeKidKey((payload as Record<string, unknown>).kid);
      const totalRaw = Number((payload as Record<string, unknown>).total);
      if (!kid || !Number.isFinite(totalRaw)) return next;
      next[kid] = Math.max(0, totalRaw);
      return next;
    }
    return next;
  }

  private buildStateSnapshot(
    stream: string,
    policy: TalkStatePolicy,
    events: TalkStateEvent[],
    asOf: number = Date.now(),
  ): TalkStateSnapshot {
    const normalizedStream = normalizeStateStream(stream);
    const baseWindow = resolveWeekWindow(asOf, policy);
    let currentWeek = baseWindow;
    let totals: Record<string, number> = {};
    let carryOver: Record<string, number> = {};

    for (const event of events) {
      const eventWeek = resolveWeekWindow(event.occurredAt || event.recordedAt || asOf, policy);
      if (eventWeek.weekStartAt > currentWeek.weekStartAt) {
        while (currentWeek.weekStartAt < eventWeek.weekStartAt) {
          carryOver = this.computeCarryOver(totals, policy);
          totals = { ...carryOver };
          currentWeek = {
            weekStartAt: currentWeek.weekStartAt + 7 * DAY_MS,
            weekEndAt: currentWeek.weekEndAt + 7 * DAY_MS,
            weekKey: formatWeekKeyFromPseudoUtc(currentWeek.weekStartAt + 7 * DAY_MS),
          };
        }
      } else if (eventWeek.weekStartAt < currentWeek.weekStartAt) {
        currentWeek = eventWeek;
        totals = {};
        carryOver = {};
      }
      totals = this.applyStateEventToTotals(totals, event);
    }

    const finalWindow = resolveWeekWindow(asOf, policy);
    if (finalWindow.weekStartAt > currentWeek.weekStartAt) {
      while (currentWeek.weekStartAt < finalWindow.weekStartAt) {
        carryOver = this.computeCarryOver(totals, policy);
        totals = { ...carryOver };
        currentWeek = {
          weekStartAt: currentWeek.weekStartAt + 7 * DAY_MS,
          weekEndAt: currentWeek.weekEndAt + 7 * DAY_MS,
          weekKey: formatWeekKeyFromPseudoUtc(currentWeek.weekStartAt + 7 * DAY_MS),
        };
      }
    } else {
      currentWeek = finalWindow;
    }

    const completed: Record<string, boolean> = {};
    for (const [kid, total] of Object.entries(totals)) {
      completed[kid] = total >= policy.targetMinutes;
    }

    return {
      stream: normalizedStream,
      weekKey: currentWeek.weekKey,
      weekStartAt: currentWeek.weekStartAt,
      weekEndAt: currentWeek.weekEndAt,
      totals,
      carryOver,
      completionTarget: policy.targetMinutes,
      completed,
      lastEventSequence: events.length ? events[events.length - 1].sequence : 0,
      updatedAt: Date.now(),
      policy,
    };
  }

  async configureStatePolicy(
    talkId: string,
    streamRaw: string,
    updates: Partial<TalkStatePolicy>,
    options?: { modifiedBy?: string },
  ): Promise<TalkStatePolicy | null> {
    if (!isValidId(talkId)) return null;
    const talk = this.talks.get(talkId);
    if (!talk) return null;
    const stream = normalizeStateStream(streamRaw);
    return this.withStateLock(talkId, stream, async () => {
      const current = await this.readStatePolicy(talkId, stream);
      const next = normalizeStatePolicy(stream, { ...current, ...updates, updatedAt: Date.now() });
      const baseDir = this.getStateBaseDir(talkId, stream);
      await fsp.mkdir(baseDir, { recursive: true });
      await fsp.writeFile(this.getStatePolicyPath(talkId, stream), JSON.stringify(next, null, 2), 'utf-8');
      this.touchMeta(talk, 'state_updated', { modifiedBy: options?.modifiedBy });
      return next;
    });
  }

  async getStatePolicy(talkId: string, streamRaw: string): Promise<TalkStatePolicy | null> {
    if (!isValidId(talkId)) return null;
    if (!this.talks.has(talkId)) return null;
    const stream = normalizeStateStream(streamRaw);
    return this.readStatePolicy(talkId, stream);
  }

  async appendStateEvent(
    talkId: string,
    streamRaw: string,
    input: {
      type: string;
      payload?: Record<string, unknown>;
      occurredAt?: number;
      idempotencyKey?: string;
      actor?: string;
    },
    options?: { modifiedBy?: string },
  ): Promise<{ applied: boolean; event: TalkStateEvent; snapshot: TalkStateSnapshot } | null> {
    if (!isValidId(talkId)) return null;
    const talk = this.talks.get(talkId);
    if (!talk) return null;
    const stream = normalizeStateStream(streamRaw);

    return this.withStateLock(talkId, stream, async () => {
      const baseDir = this.getStateBaseDir(talkId, stream);
      await fsp.mkdir(baseDir, { recursive: true });
      const events = await this.readStateEvents(talkId, stream);
      const policy = await this.readStatePolicy(talkId, stream);
      const idempotencyKey = input.idempotencyKey?.trim();
      const existing = idempotencyKey
        ? events.find((event) => event.idempotencyKey === idempotencyKey)
        : undefined;
      if (existing) {
        const snapshot = this.buildStateSnapshot(stream, policy, events);
        await fsp.writeFile(this.getStateSnapshotPath(talkId, stream), JSON.stringify(snapshot, null, 2), 'utf-8');
        return { applied: false, event: existing, snapshot };
      }

      const event: TalkStateEvent = {
        id: randomUUID(),
        stream,
        sequence: (events[events.length - 1]?.sequence ?? 0) + 1,
        type: input.type.trim(),
        payload: input.payload ?? {},
        occurredAt: typeof input.occurredAt === 'number' && Number.isFinite(input.occurredAt)
          ? input.occurredAt
          : Date.now(),
        recordedAt: Date.now(),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(input.actor?.trim() ? { actor: input.actor.trim() } : {}),
      };
      await fsp.appendFile(this.getStateEventsPath(talkId, stream), `${JSON.stringify(event)}\n`, 'utf-8');
      const nextEvents = [...events, event];
      const snapshot = this.buildStateSnapshot(stream, policy, nextEvents);
      await fsp.writeFile(this.getStateSnapshotPath(talkId, stream), JSON.stringify(snapshot, null, 2), 'utf-8');
      this.touchMeta(talk, 'state_updated', { modifiedBy: options?.modifiedBy });
      return { applied: true, event, snapshot };
    });
  }

  async getStateSnapshot(talkId: string, streamRaw: string, asOf?: number): Promise<TalkStateSnapshot | null> {
    if (!isValidId(talkId)) return null;
    if (!this.talks.has(talkId)) return null;
    const stream = normalizeStateStream(streamRaw);
    return this.withStateLock(talkId, stream, async () => {
      const events = await this.readStateEvents(talkId, stream);
      const policy = await this.readStatePolicy(talkId, stream);
      const snapshot = this.buildStateSnapshot(stream, policy, events, asOf);
      await fsp.mkdir(this.getStateBaseDir(talkId, stream), { recursive: true });
      await fsp.writeFile(this.getStateSnapshotPath(talkId, stream), JSON.stringify(snapshot, null, 2), 'utf-8');
      return snapshot;
    });
  }

  async getStateEvents(
    talkId: string,
    streamRaw: string,
    opts?: { limit?: number; sinceSequence?: number },
  ): Promise<TalkStateEvent[]> {
    if (!isValidId(talkId)) return [];
    if (!this.talks.has(talkId)) return [];
    const stream = normalizeStateStream(streamRaw);
    const events = await this.readStateEvents(talkId, stream);
    const sinceSequence =
      typeof opts?.sinceSequence === 'number' && Number.isFinite(opts.sinceSequence)
        ? Math.max(0, Math.floor(opts.sinceSequence))
        : 0;
    let filtered = sinceSequence > 0 ? events.filter((event) => event.sequence > sinceSequence) : events;
    if (typeof opts?.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0) {
      filtered = filtered.slice(-Math.floor(opts.limit));
    }
    return filtered;
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

  getDataDir(): string {
    return path.dirname(this.talksDir);
  }
}
