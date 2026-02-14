import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import type {
  Logger,
  HandlerContext,
  UsageSummary,
  ProviderUsageSnapshot,
  CachedRateLimitData,
} from './types.js';
import { sendJson } from './http.js';
import { getProxyCachedLimits } from './proxy.js';

// ---------------------------------------------------------------------------
// Usage loader — uses openclaw internals for rate-limit data
// ---------------------------------------------------------------------------

// Prevent TypeScript from downcompiling import() to require(), which cannot
// handle file:// URLs or load ESM modules from a CJS context.
const dynamicImport = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<any>;

let _loadUsage: ((opts?: any) => Promise<UsageSummary>) | null = null;

function findOpenclawRoot(): string | null {
  const candidates = [
    '/usr/lib/node_modules/openclaw',
    '/usr/local/lib/node_modules/openclaw',
  ];
  for (const root of candidates) {
    if (existsSync(`${root}/dist/index.js`)) {
      return root;
    }
  }
  return null;
}

function findCandidateModules(root: string): string[] {
  const distDir = join(root, 'dist');
  try {
    const files = readdirSync(distDir);
    const candidates: string[] = [];

    // loader-<hash>.js (pre-2026.2.13)
    const loader = files.find(f => /^loader-[A-Za-z0-9_-]+\.js$/.test(f));
    if (loader) candidates.push(join(distDir, loader));

    // reply-<hash>.js (2026.2.13+ — loadProviderUsageSummary exported as minified alias)
    const reply = files.find(f => /^reply-[A-Za-z0-9_-]+\.js$/.test(f));
    if (reply) candidates.push(join(distDir, reply));

    return candidates;
  } catch {
    return [];
  }
}

async function ensureUsageLoader(log: Logger): Promise<typeof _loadUsage> {
  if (_loadUsage) return _loadUsage;

  const root = findOpenclawRoot();
  if (!root) {
    log.warn('ClawTalk: openclaw dist not found');
    return null;
  }

  // Try bundled modules: loader-<hash>.js (pre-2026.2.13), reply-<hash>.js (2026.2.13+)
  for (const candidatePath of findCandidateModules(root)) {
    try {
      const mod = await dynamicImport(pathToFileURL(candidatePath).href);
      if (typeof mod.loadProviderUsageSummary === 'function') {
        _loadUsage = mod.loadProviderUsageSummary;
        log.info('ClawTalk: usage loader initialized via bundled loader');
        return _loadUsage;
      }
      // Check minified export names — the function may be aliased (e.g. "bt")
      for (const key of Object.keys(mod)) {
        if (typeof mod[key] === 'function' && mod[key].name === 'loadProviderUsageSummary') {
          _loadUsage = mod[key];
          log.info('ClawTalk: usage loader initialized via bundled loader (aliased)');
          return _loadUsage;
        }
      }
    } catch (err) {
      log.debug(`ClawTalk: candidate import failed (${candidatePath}): ${err}`);
    }
  }

  // Legacy: try the old unbundled path
  try {
    const mod = await dynamicImport(
      pathToFileURL(`${root}/dist/infra/provider-usage.load.js`).href
    );
    if (typeof mod.loadProviderUsageSummary === 'function') {
      _loadUsage = mod.loadProviderUsageSummary;
      log.info('ClawTalk: usage loader initialized via legacy path');
      return _loadUsage;
    }
  } catch {
    // expected on newer openclaw versions
  }

  log.info('ClawTalk: falling back to subprocess strategy');
  _loadUsage = createSubprocessUsageLoader(root, log);
  return _loadUsage;
}

function createSubprocessUsageLoader(
  openclawRoot: string,
  log: Logger,
): (opts?: any) => Promise<UsageSummary> {
  const candidates = findCandidateModules(openclawRoot);
  const legacyPath = `${openclawRoot}/dist/infra/provider-usage.load.js`;
  return async () => {
    // Build a script that tries each candidate module to find loadProviderUsageSummary
    const imports = [
      ...candidates.map(p => `"${p}"`),
      `"${legacyPath}"`,
    ];
    const script = `
      async function run() {
        for (const path of [${imports.join(', ')}]) {
          try {
            const mod = await import(path);
            const fn = mod.loadProviderUsageSummary
              ?? Object.values(mod).find(v => typeof v === 'function' && v.name === 'loadProviderUsageSummary');
            if (fn) {
              const result = await fn();
              process.stdout.write(JSON.stringify(result));
              return;
            }
          } catch {}
        }
        process.stdout.write(JSON.stringify({ updatedAt: Date.now(), providers: [] }));
      }
      run();
    `;
    try {
      const output = execSync(
        `node --input-type=module -e '${script.replace(/'/g, "'\\''")}'`,
        {
          timeout: 10000,
          env: process.env,
          encoding: 'utf-8',
        }
      );
      return JSON.parse(output.trim());
    } catch (err) {
      log.warn(`ClawTalk: subprocess fetch failed: ${err}`);
      return { updatedAt: Date.now(), providers: [] };
    }
  };
}

/**
 * Eagerly warm up the usage loader in background.
 */
export function warmUsageLoader(log: Logger): void {
  ensureUsageLoader(log).catch(() => {});
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatSnapshot(snapshot: ProviderUsageSnapshot): Record<string, any> {
  const result: Record<string, any> = { provider: snapshot.provider };
  const windows = snapshot.windows ?? [];

  const sessionWindow = windows.find(
    (w) => w.label === '5h' || w.label === 'session'
  );
  const weeklyWindow = windows.find(
    (w) => w.label === 'Week' || w.label === '7d' || w.label === 'weekly'
  );

  if (sessionWindow) {
    result.session = {
      used: Math.round(sessionWindow.usedPercent),
      limit: 100,
      resetsAt: sessionWindow.resetAt
        ? new Date(sessionWindow.resetAt).toISOString()
        : undefined,
    };
  }

  if (weeklyWindow) {
    result.weekly = {
      used: Math.round(weeklyWindow.usedPercent),
      limit: 100,
      resetsAt: weeklyWindow.resetAt
        ? new Date(weeklyWindow.resetAt).toISOString()
        : undefined,
    };
  }

  if (!sessionWindow && !weeklyWindow && windows.length > 0) {
    const first = windows[0]!;
    result.session = {
      used: Math.round(first.usedPercent),
      limit: 100,
      resetsAt: first.resetAt
        ? new Date(first.resetAt).toISOString()
        : undefined,
    };
  }

  if (snapshot.error) {
    result.error = snapshot.error;
  }

  return result;
}

function formatCachedLimits(cached: CachedRateLimitData): Record<string, any> {
  const result: Record<string, any> = {
    provider: cached.provider,
  };

  // Map fiveHour → session, sevenDay → weekly
  // Client expects: { used: number, limit: number, resetsAt: string (ISO) }
  if (cached.fiveHour) {
    result.session = {
      used: Math.round(cached.fiveHour.utilization * 100),
      limit: 100,
      resetsAt: cached.fiveHour.resetsAt
        ? new Date(cached.fiveHour.resetsAt * 1000).toISOString()
        : undefined,
    };
  }

  if (cached.sevenDay) {
    result.weekly = {
      used: Math.round(cached.sevenDay.utilization * 100),
      limit: 100,
      resetsAt: cached.sevenDay.resetsAt
        ? new Date(cached.sevenDay.resetsAt * 1000).toISOString()
        : undefined,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleRateLimits(ctx: HandlerContext): Promise<void> {
  if (ctx.req.method !== 'GET') {
    ctx.res.statusCode = 405;
    ctx.res.setHeader('Allow', 'GET, OPTIONS');
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end('Method Not Allowed');
    return;
  }

  const providerFilter = ctx.url.searchParams.get('provider') ?? undefined;

  // Try the openclaw usage loader first
  let usedProxyFallback = false;
  const loader = await ensureUsageLoader(ctx.logger);

  if (loader) {
    try {
      const summary = await loader();
      const snapshots = summary.providers ?? [];

      const filtered = providerFilter
        ? snapshots.filter(
            (s) =>
              s.provider.toLowerCase() === providerFilter.toLowerCase()
          )
        : snapshots;

      // Check if filtered results have errors — if so, try proxy fallback
      const hasErrors = filtered.some((s) => !!s.error);
      if (filtered.length > 0 && !hasErrors) {
        if (providerFilter && filtered.length === 1) {
          sendJson(ctx.res, 200, formatSnapshot(filtered[0]!));
          return;
        }
        sendJson(ctx.res, 200, {
          rateLimits: filtered.map(formatSnapshot),
        });
        return;
      }

      // If we got results with errors, fall through to proxy cache
      if (hasErrors) {
        usedProxyFallback = true;
      }
    } catch (err) {
      ctx.logger.warn(`ClawTalk: usage loader error: ${String(err)}`);
      usedProxyFallback = true;
    }
  } else {
    usedProxyFallback = true;
  }

  // Fallback: use proxy-captured rate-limit headers
  if (usedProxyFallback) {
    if (providerFilter) {
      const cached = getProxyCachedLimits(providerFilter);
      if (cached) {
        sendJson(ctx.res, 200, formatCachedLimits(cached));
        return;
      }
      sendJson(ctx.res, 200, { provider: providerFilter });
      return;
    }

    // No filter — return all cached providers
    const anthropicCached = getProxyCachedLimits('anthropic');
    if (anthropicCached) {
      sendJson(ctx.res, 200, {
        rateLimits: [formatCachedLimits(anthropicCached)],
      });
      return;
    }

    sendJson(ctx.res, 200, {});
    return;
  }

  sendJson(ctx.res, 200, {});
}
