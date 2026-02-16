import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __resetSlackIngressStateForTests,
  handleSlackMessageReceivedHook,
  handleSlackMessageSendingHook,
} from '../slack-ingress';
import { TalkStore } from '../talk-store';
import type { Logger } from '../types';

const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

let tmpDir: string;
let store: TalkStore;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'slack-ingress-test-'));
  store = new TalkStore(tmpDir, mockLogger);
  await store.init();
  __resetSlackIngressStateForTests();
  jest.clearAllMocks();
  delete process.env.CLAWTALK_INGRESS_SUPPRESS_MAX_CANCELS;
});

afterEach(async () => {
  __resetSlackIngressStateForTests();
  await fsp.rm(tmpDir, { recursive: true, force: true });
  delete process.env.CLAWTALK_INGRESS_SUPPRESS_MAX_CANCELS;
});

function buildDeps() {
  return {
    store,
    gatewayOrigin: 'http://127.0.0.1:18789',
    authToken: 'test-token',
    logger: mockLogger,
    autoProcessQueue: false,
    sendSlackMessage: jest.fn(async () => true),
  };
}

function addSlackBinding(scope: string): string {
  const talk = store.createTalk('test-model');
  store.updateTalk(talk.id, {
    platformBindings: [{
      id: `binding-${Date.now()}`,
      platform: 'slack',
      scope,
      permission: 'read+write',
      createdAt: Date.now(),
    }],
  });
  return talk.id;
}

describe('slack ingress ownership hooks', () => {
  it('claims matching channel events and suppresses OpenClaw outbound', async () => {
    addSlackBinding('channel:c123');
    process.env.CLAWTALK_INGRESS_SUPPRESS_MAX_CANCELS = '1';

    await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C123',
        content: 'hello from slack',
        metadata: {
          to: 'channel:C123',
          messageId: '1700000000.100',
          senderId: 'U123',
        },
      },
      {
        channelId: 'slack',
        accountId: 'acct-1',
      },
      buildDeps(),
    );

    const first = handleSlackMessageSendingHook(
      {
        to: 'channel:C123',
        content: 'openclaw reply',
        metadata: { accountId: 'acct-1' },
      },
      {
        channelId: 'slack',
        accountId: 'acct-1',
      },
      mockLogger,
    );
    expect(first).toEqual({ cancel: true });

    const second = handleSlackMessageSendingHook(
      {
        to: 'channel:C123',
        content: 'openclaw retry',
        metadata: { accountId: 'acct-1' },
      },
      {
        channelId: 'slack',
        accountId: 'acct-1',
      },
      mockLogger,
    );
    expect(second).toBeUndefined();
  });

  it('supports user-scoped bindings for Slack DM targets', async () => {
    addSlackBinding('user:u777');

    await handleSlackMessageReceivedHook(
      {
        from: 'slack:U777',
        content: 'dm message',
        metadata: {
          to: 'user:U777',
          messageId: '1700000001.200',
          senderId: 'U777',
        },
      },
      {
        channelId: 'slack',
        accountId: 'acct-2',
      },
      buildDeps(),
    );

    const result = handleSlackMessageSendingHook(
      {
        to: 'user:U777',
        content: 'openclaw dm reply',
        metadata: { accountId: 'acct-2' },
      },
      {
        channelId: 'slack',
        accountId: 'acct-2',
      },
      mockLogger,
    );
    expect(result).toEqual({ cancel: true });
  });

  it('does not suppress outbound when no talk binding matches', async () => {
    await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C404',
        content: 'no owner',
        metadata: {
          to: 'channel:C404',
          messageId: '1700000002.300',
          senderId: 'U404',
        },
      },
      {
        channelId: 'slack',
        accountId: 'acct-3',
      },
      buildDeps(),
    );

    const result = handleSlackMessageSendingHook(
      {
        to: 'channel:C404',
        content: 'openclaw reply',
        metadata: { accountId: 'acct-3' },
      },
      {
        channelId: 'slack',
        accountId: 'acct-3',
      },
      mockLogger,
    );
    expect(result).toBeUndefined();
  });

  it('ignores non-slack hook events', async () => {
    addSlackBinding('channel:c123');

    await handleSlackMessageReceivedHook(
      {
        from: 'telegram:group:1',
        content: 'hello telegram',
      },
      {
        channelId: 'telegram',
        accountId: 'acct-4',
      },
      buildDeps(),
    );

    const result = handleSlackMessageSendingHook(
      {
        to: 'channel:C123',
        content: 'telegram outbound',
      },
      {
        channelId: 'telegram',
        accountId: 'acct-4',
      },
      mockLogger,
    );
    expect(result).toBeUndefined();
  });
});
