import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

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
// Usage loader — uses moltbot internals for rate-limit data
// ---------------------------------------------------------------------------

let _loadUsage: ((opts?: any) => Promise<UsageSummary>) | null = null;

function findMoltbotRoot(): string | null {
  const candidates = [
    '/usr/lib/node_modules/moltbot',
    '/usr/local/lib/node_modules/moltbot',
  ];
  for (const root of candidates) {
    if (existsSync(`${root}/dist/infra/provider-usage.load.js`)) {
      return root;
    }
  }
  return null;
}

async function ensureUsageLoader(log: Logger): Promise<typeof _loadUsage> {
  if (_loadUsage) return _loadUsage;

  const root = findMoltbotRoot();
  if (!root) {
    log.warn('RemoteClaw: moltbot dist not found');
    return null;
  }

  try {
    const mod = await import(
      pathToFileURL(`${root}/dist/infra/provider-usage.load.js`).href
    );
    if (typeof mod.loadProviderUsageSummary === 'function') {
      _loadUsage = mod.loadProviderUsageSummary;
      log.info('RemoteClaw: usage loader initialized via import()');
      return _loadUsage;
    }
    log.warn(`RemoteClaw: module loaded, keys: ${Object.keys(mod).join(', ')}`);
  } catch (err) {
    log.info(`RemoteClaw: import() approach failed: ${err}`);
  }

  try {
    const mod = await import(
      pathToFileURL(`${root}/dist/infra/provider-usage.js`).href
    );
    if (typeof mod.loadProviderUsageSummary === 'function') {
      _loadUsage = mod.loadProviderUsageSummary;
      log.info('RemoteClaw: usage loader initialized via barrel import');
      return _loadUsage;
    }
  } catch (err) {
    log.info(`RemoteClaw: barrel import failed: ${err}`);
  }

  log.info('RemoteClaw: falling back to subprocess strategy');
  _loadUsage = createSubprocessUsageLoader(root, log);
  return _loadUsage;
}

function createSubprocessUsageLoader(
  moltbotRoot: string,
  log: Logger,
): (opts?: any) => Promise<UsageSummary> {
  return async () => {
    try {
      const script = `
        import { loadProviderUsageSummary } from "${moltbotRoot}/dist/infra/provider-usage.load.js";
        const result = await loadProviderUsageSummary();
        process.stdout.write(JSON.stringify(result));
      `;
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
      log.warn(`RemoteClaw: subprocess fetch failed: ${err}`);
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

  // Try the moltbot usage loader first
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
      ctx.logger.warn(`RemoteClaw: usage loader error: ${String(err)}`);
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
