import {
  listSlackAccountIds,
  normalizeSlackAccountId,
  resolveSlackBotTokenForAccount,
  resolveTemplateSecret,
} from '../slack-auth.js';

describe('slack-auth', () => {
  it('normalizes account ids', () => {
    expect(normalizeSlackAccountId(' KimFamily ')).toBe('kimfamily');
    expect(normalizeSlackAccountId('')).toBeUndefined();
    expect(normalizeSlackAccountId(undefined)).toBeUndefined();
  });

  it('resolves template secrets from env', () => {
    process.env.SLACK_AUTH_TEST_SECRET = 'xoxb-test-token';
    expect(resolveTemplateSecret('${SLACK_AUTH_TEST_SECRET}')).toBe('xoxb-test-token');
    delete process.env.SLACK_AUTH_TEST_SECRET;
  });

  it('returns configured account ids and keeps default first', () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            kimfamily: {},
            default: {},
            lilagames: {},
          },
        },
      },
    };

    expect(listSlackAccountIds(cfg)).toEqual(['default', 'kimfamily', 'lilagames']);
  });

  it('resolves account token and does not fallback across accounts', () => {
    process.env.SLACK_KIM_TOKEN = 'xoxb-kim';
    process.env.SLACK_BOT_TOKEN = 'xoxb-default-env';

    const cfg = {
      channels: {
        slack: {
          botToken: '${SLACK_BOT_TOKEN}',
          accounts: {
            kimfamily: { botToken: '${SLACK_KIM_TOKEN}' },
            lilagames: {},
          },
        },
      },
    };

    expect(resolveSlackBotTokenForAccount(cfg, 'kimfamily')).toBe('xoxb-kim');
    expect(resolveSlackBotTokenForAccount(cfg, 'lilagames')).toBeUndefined();
    expect(resolveSlackBotTokenForAccount(cfg, 'default')).toBe('xoxb-default-env');

    delete process.env.SLACK_KIM_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
  });
});

