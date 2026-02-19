const DEFAULT_SLACK_ACCOUNT_ID = 'default';

export function normalizeSlackAccountId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}

export function resolveTemplateSecret(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const envMatch = trimmed.match(/^\$\{(.+)\}$/);
  if (envMatch?.[1]) {
    const value = process.env[envMatch[1]]?.trim();
    return value || undefined;
  }
  return trimmed;
}

export function listSlackAccountIds(cfg: Record<string, any>): string[] {
  const accounts = cfg?.channels?.slack?.accounts;
  if (!accounts || typeof accounts !== 'object') {
    return [DEFAULT_SLACK_ACCOUNT_ID];
  }
  const ids = Object.keys(accounts).filter(Boolean);
  if (ids.length === 0) return [DEFAULT_SLACK_ACCOUNT_ID];
  if (ids.includes(DEFAULT_SLACK_ACCOUNT_ID)) {
    return [DEFAULT_SLACK_ACCOUNT_ID, ...ids.filter((id) => id !== DEFAULT_SLACK_ACCOUNT_ID).sort()];
  }
  return ids.sort();
}

export function resolveSlackBotTokenForAccount(
  cfg: Record<string, any>,
  accountId: string,
): string | undefined {
  const normalizedAccountId = normalizeSlackAccountId(accountId);
  if (!normalizedAccountId) return undefined;

  const accountToken = resolveTemplateSecret(cfg?.channels?.slack?.accounts?.[normalizedAccountId]?.botToken);
  if (accountToken) return accountToken;

  if (normalizedAccountId === DEFAULT_SLACK_ACCOUNT_ID) {
    const topLevelToken = resolveTemplateSecret(cfg?.channels?.slack?.botToken);
    if (topLevelToken) return topLevelToken;
    const envToken = resolveTemplateSecret(process.env.SLACK_BOT_TOKEN);
    if (envToken) return envToken;
  }

  return undefined;
}

