import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __resetSlackIngressStateForTests,
  getSlackIngressTalkRuntimeSnapshot,
  handleSlackMessageReceivedHook,
  handleSlackMessageSendingHook,
  inspectSlackOwnership,
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
  return addSlackBindingWithId(scope).talkId;
}

function addSlackBindingWithId(scope: string): { talkId: string; bindingId: string } {
  const talk = store.createTalk('test-model');
  const bindingId = `binding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  store.updateTalk(talk.id, {
    platformBindings: [{
      id: bindingId,
      platform: 'slack',
      scope,
      permission: 'read+write',
      createdAt: Date.now(),
    }],
  });
  return { talkId: talk.id, bindingId };
}

describe('slack ingress ownership hooks', () => {
  it('claims matching channel events and suppresses OpenClaw outbound', async () => {
    addSlackBinding('channel:c123');
    process.env.CLAWTALK_INGRESS_SUPPRESS_MAX_CANCELS = '1';

    const hookResult = await handleSlackMessageReceivedHook(
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
    expect(hookResult).toEqual({ cancel: true });

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

    const hookResult = await handleSlackMessageReceivedHook(
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
    expect(hookResult).toEqual({ cancel: true });

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

  it('suppresses outbound across equivalent Slack target formats', async () => {
    addSlackBinding('channel:c123');
    process.env.CLAWTALK_INGRESS_SUPPRESS_MAX_CANCELS = '1';

    await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C123',
        content: 'hello from slack',
        metadata: {
          to: 'slack:channel:C123',
          messageId: '1700000005.100',
          senderId: 'U123',
        },
      },
      {
        channelId: 'slack',
        accountId: 'acct-1',
      },
      buildDeps(),
    );

    const result = handleSlackMessageSendingHook(
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
    expect(result).toEqual({ cancel: true });
  });

  it('does not suppress outbound when no talk binding matches', async () => {
    const hookResult = await handleSlackMessageReceivedHook(
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
    expect(hookResult).toBeUndefined();

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

  it('handles when behavior sets agent-only override (no on-message prompt)', async () => {
    const { talkId, bindingId } = addSlackBindingWithId('channel:c901');
    store.updateTalk(talkId, {
      platformBehaviors: [{
        id: 'behavior-1',
        platformBindingId: bindingId,
        agentName: 'DeepSeek',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });

    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C901',
        content: 'hello from slack',
        metadata: {
          to: 'channel:C901',
          messageId: '1700000003.400',
          senderId: 'U901',
        },
      },
      {
        channelId: 'slack',
        accountId: 'acct-9',
      },
      buildDeps(),
    );
    expect(hookResult).toEqual({ cancel: true });

    const result = handleSlackMessageSendingHook(
      {
        to: 'channel:C901',
        content: 'openclaw reply',
        metadata: { accountId: 'acct-9' },
      },
      {
        channelId: 'slack',
        accountId: 'acct-9',
      },
      mockLogger,
    );
    expect(result).toEqual({ cancel: true });
  });

  it('suppresses outbound when on-message behavior is configured for the binding', async () => {
    const { talkId, bindingId } = addSlackBindingWithId('channel:c902');
    store.updateTalk(talkId, {
      platformBehaviors: [{
        id: 'behavior-2',
        platformBindingId: bindingId,
        onMessagePrompt: 'Reply with concise action items.',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });
    process.env.CLAWTALK_INGRESS_SUPPRESS_MAX_CANCELS = '1';

    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C902',
        content: 'status?',
        metadata: {
          to: 'channel:C902',
          messageId: '1700000004.500',
          senderId: 'U902',
        },
      },
      {
        channelId: 'slack',
        accountId: 'acct-10',
      },
      buildDeps(),
    );
    expect(hookResult).toEqual({ cancel: true });

    const first = handleSlackMessageSendingHook(
      {
        to: 'channel:C902',
        content: 'openclaw reply',
        metadata: { accountId: 'acct-10' },
      },
      {
        channelId: 'slack',
        accountId: 'acct-10',
      },
      mockLogger,
    );
    expect(first).toEqual({ cancel: true });
  });

  it('ignores non-slack hook events', async () => {
    addSlackBinding('channel:c123');

    const hookResult = await handleSlackMessageReceivedHook(
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
    expect(hookResult).toBeUndefined();

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

  it('exposes ownership inspection details for diagnostics', () => {
    const { talkId, bindingId } = addSlackBindingWithId('channel:c777');
    store.updateTalk(talkId, {
      platformBehaviors: [{
        id: 'behavior-diag',
        platformBindingId: bindingId,
        onMessagePrompt: 'Reply in one line.',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });

    const inspected = inspectSlackOwnership(
      {
        eventId: 'evt-1',
        accountId: 'default',
        channelId: 'C777',
      },
      store,
      mockLogger,
    );
    expect(inspected.decision).toBe('handled');
    expect(inspected.talkId).toBe(talkId);
    expect(inspected.bindingId).toBe(bindingId);
  });

  it('passes when autoRespond is explicitly disabled for a binding', async () => {
    const { talkId, bindingId } = addSlackBindingWithId('channel:c555');
    store.updateTalk(talkId, {
      platformBehaviors: [{
        id: 'behavior-disabled',
        platformBindingId: bindingId,
        autoRespond: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });

    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C555',
        content: 'hello',
        metadata: {
          to: 'channel:C555',
          messageId: '1700000010.100',
          senderId: 'U555',
        },
      },
      {
        channelId: 'slack',
      },
      buildDeps(),
    );
    expect(hookResult).toBeUndefined();
  });

  it('uses binding account fallback when inbound event account is missing', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-account-fallback';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c777',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
    });

    const sendSlackMessage = jest.fn(async (_params: { accountId?: string; channelId: string; threadTs?: string; message: string }) => true);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ack' } }],
      }),
    } as unknown as Response);
    try {
      const deps = {
        ...buildDeps(),
        autoProcessQueue: true,
        sendSlackMessage,
      };

      const hookResult = await handleSlackMessageReceivedHook(
        {
          from: 'slack:channel:C777',
          content: 'progress update',
          metadata: {
            to: 'channel:C777',
            messageId: '1700000011.100',
            senderId: 'U777',
          },
        },
        {
          channelId: 'slack',
        },
        deps,
      );
      expect(hookResult).toEqual({ cancel: true });

      for (let i = 0; i < 40 && sendSlackMessage.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(sendSlackMessage).toHaveBeenCalled();
      const firstCall = sendSlackMessage.mock.calls[0]?.[0] as { accountId?: string } | undefined;
      expect(firstCall?.accountId).toBe('kimfamily');

      const runtime = getSlackIngressTalkRuntimeSnapshot(talk.id);
      expect(runtime.counters.handled).toBeGreaterThanOrEqual(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
