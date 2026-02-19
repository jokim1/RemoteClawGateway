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
import { ToolRegistry } from '../tool-registry';
import { ToolExecutor } from '../tool-executor';
import type { Logger } from '../types';

const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

let tmpDir: string;
let store: TalkStore;
let registry: ToolRegistry;
let executor: ToolExecutor;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'slack-ingress-test-'));
  store = new TalkStore(tmpDir, mockLogger);
  await store.init();
  registry = new ToolRegistry(tmpDir, mockLogger);
  executor = new ToolExecutor(registry, store, mockLogger);
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
    registry,
    executor,
    dataDir: tmpDir,
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

  it('supports adaptive delivery: study updates post to channel, advice replies in thread', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-adaptive';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c888',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: 'behavior-adaptive',
        platformBindingId: bindingId,
        responseMode: 'all',
        deliveryMode: 'adaptive',
        responsePolicy: { triggerPolicy: 'advice_or_study' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
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

      await handleSlackMessageReceivedHook(
        {
          from: 'slack:channel:C888',
          content: '3h mathcounts practice',
          metadata: {
            to: 'channel:C888',
            threadId: '1700000099.100',
            messageId: '1700000099.100',
            senderId: 'U888',
            senderName: 'Asher',
          },
        },
        {
          channelId: 'slack',
          accountId: 'kimfamily',
        },
        deps,
      );

      await handleSlackMessageReceivedHook(
        {
          from: 'slack:channel:C888',
          content: 'can you help me plan tomorrow?',
          metadata: {
            to: 'channel:C888',
            threadId: '1700000100.100',
            messageId: '1700000100.100',
            senderId: 'U888',
            senderName: 'Asher',
          },
        },
        {
          channelId: 'slack',
          accountId: 'kimfamily',
        },
        deps,
      );

      for (let i = 0; i < 50 && sendSlackMessage.mock.calls.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(sendSlackMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
      const firstCall = sendSlackMessage.mock.calls[0]?.[0] as { threadTs?: string } | undefined;
      const secondCall = sendSlackMessage.mock.calls[1]?.[0] as { threadTs?: string } | undefined;
      expect(firstCall?.threadTs).toBeUndefined();
      expect(secondCall?.threadTs).toBe('1700000100.100');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('supports adaptive explicit routing hints: thread/channel directives override intent routing', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-adaptive-explicit';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c898',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: 'behavior-adaptive-explicit',
        platformBindingId: bindingId,
        responseMode: 'all',
        deliveryMode: 'adaptive',
        responsePolicy: { triggerPolicy: 'advice_or_study' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
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

      await handleSlackMessageReceivedHook(
        {
          from: 'slack:channel:C898',
          content: '2h study update, reply in thread please',
          metadata: {
            to: 'channel:C898',
            threadId: '1700000199.100',
            messageId: '1700000199.100',
            senderId: 'U898',
            senderName: 'Asher',
          },
        },
        {
          channelId: 'slack',
          accountId: 'kimfamily',
        },
        deps,
      );

      await handleSlackMessageReceivedHook(
        {
          from: 'slack:channel:C898',
          content: 'can you help me plan tomorrow? post top-level',
          metadata: {
            to: 'channel:C898',
            threadId: '1700000200.100',
            messageId: '1700000200.100',
            senderId: 'U898',
            senderName: 'Asher',
          },
        },
        {
          channelId: 'slack',
          accountId: 'kimfamily',
        },
        deps,
      );

      for (let i = 0; i < 50 && sendSlackMessage.mock.calls.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(sendSlackMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
      const firstCall = sendSlackMessage.mock.calls[0]?.[0] as { threadTs?: string } | undefined;
      const secondCall = sendSlackMessage.mock.calls[1]?.[0] as { threadTs?: string } | undefined;
      expect(firstCall?.threadTs).toBe('1700000199.100');
      expect(secondCall?.threadTs).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('respects study_entries_only trigger policy and skips non-study chatter', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-trigger-policy';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c889',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: 'behavior-trigger-policy',
        platformBindingId: bindingId,
        responseMode: 'all',
        responsePolicy: { triggerPolicy: 'study_entries_only' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });

    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C889',
        content: 'lol this is random chatter',
        metadata: {
          to: 'channel:C889',
          messageId: '1700000101.100',
          senderId: 'U889',
          senderName: 'Asher',
        },
      },
      {
        channelId: 'slack',
        accountId: 'kimfamily',
      },
      buildDeps(),
    );

    expect(hookResult).toBeUndefined();
  });

  it('does not mirror Slack messages into talk when mirrorToTalk is off', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-mirror-off';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c890',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: 'behavior-mirror-off',
        platformBindingId: bindingId,
        responseMode: 'all',
        mirrorToTalk: 'off',
        createdAt: Date.now(),
        updatedAt: Date.now(),
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

      await handleSlackMessageReceivedHook(
        {
          from: 'slack:channel:C890',
          content: '2h homework',
          metadata: {
            to: 'channel:C890',
            messageId: '1700000102.100',
            senderId: 'U890',
            senderName: 'Asher',
          },
        },
        {
          channelId: 'slack',
          accountId: 'kimfamily',
        },
        deps,
      );

      for (let i = 0; i < 40 && sendSlackMessage.mock.calls.length < 1; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const history = await store.getRecentMessages(talk.id, 50);
      const mirroredSlackEntries = history.filter((m) => m.content.includes('[Slack #'));
      expect(mirroredSlackEntries).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('mirrors inbound only when mirrorToTalk is inbound', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-mirror-inbound';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c891',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: 'behavior-mirror-inbound',
        platformBindingId: bindingId,
        responseMode: 'all',
        mirrorToTalk: 'inbound',
        createdAt: Date.now(),
        updatedAt: Date.now(),
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

      await handleSlackMessageReceivedHook(
        {
          from: 'slack:channel:C891',
          content: '1h art project',
          metadata: {
            to: 'channel:C891',
            messageId: '1700000103.100',
            senderId: 'U891',
            senderName: 'Kaela',
          },
        },
        {
          channelId: 'slack',
          accountId: 'kimfamily',
        },
        deps,
      );

      for (let i = 0; i < 40 && sendSlackMessage.mock.calls.length < 1; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const history = await store.getRecentMessages(talk.id, 50);
      const mirroredSlackEntries = history.filter((m) => m.content.includes('[Slack #'));
      expect(mirroredSlackEntries.length).toBeGreaterThanOrEqual(1);
      const assistantEntries = history.filter((m) => m.role === 'assistant');
      expect(assistantEntries).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('includes a user message for llm calls when mirrorToTalk is off', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-user-turn-required';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c892',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: 'behavior-user-turn-required',
        platformBindingId: bindingId,
        responseMode: 'all',
        mirrorToTalk: 'off',
        createdAt: Date.now(),
        updatedAt: Date.now(),
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

      await handleSlackMessageReceivedHook(
        {
          from: 'slack:channel:C892',
          content: 'please summarize study time',
          metadata: {
            to: 'channel:C892',
            messageId: '1700000104.100',
            senderId: 'U892',
            senderName: 'Big Bad Daddy',
          },
        },
        {
          channelId: 'slack',
          accountId: 'kimfamily',
        },
        deps,
      );

      for (let i = 0; i < 40 && sendSlackMessage.mock.calls.length < 1; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(fetchSpy).toHaveBeenCalled();
      const llmCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes('/v1/chat/completions'));
      const llmReq = llmCall?.[1] as { body?: string } | undefined;
      const payload = llmReq?.body ? JSON.parse(llmReq.body) as { messages?: Array<{ role?: string; content?: string }> } : {};
      const userTurn = payload.messages?.find((m) => m.role === 'user');
      expect(userTurn).toBeDefined();
      expect(userTurn?.content).toContain('please summarize study time');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('blocks mismatched set intent and records intent diagnostic', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-intent-verification';
    store.updateTalk(talk.id, {
      stateBackend: 'stream_store',
      defaultStateStream: 'kids_study',
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c893',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: 'behavior-intent-verification',
        platformBindingId: bindingId,
        responseMode: 'all',
        deliveryMode: 'channel',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });

    const sendSlackMessage = jest.fn(async (_params: { accountId?: string; channelId: string; threadTs?: string; message: string }) => true);
    let completionCall = 0;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      if (String(input).includes('/v1/chat/completions')) {
        completionCall += 1;
        if (completionCall === 1) {
          return {
            ok: true,
            json: async () => ({
              choices: [{
                finish_reason: 'tool_calls',
                message: {
                  content: '',
                  tool_calls: [{
                    id: 'tc1',
                    type: 'function',
                    function: {
                      name: 'state_append_event',
                      arguments: JSON.stringify({
                        talk_id: talk.id,
                        stream: 'kids_study',
                        event_type: 'manual_adjustment',
                        payload: { kid: 'Asher', target: 360 },
                      }),
                    },
                  }],
                },
              }],
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "Set Asher's weekly study time to 360 minutes." } }],
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch call: ${String(input)}`);
    });
    try {
      const deps = {
        ...buildDeps(),
        autoProcessQueue: true,
        sendSlackMessage,
      };

      await handleSlackMessageReceivedHook(
        {
          from: 'slack:channel:C893',
          content: "Kimi pls set asher's weekly study time to 360 minutes",
          metadata: {
            to: 'channel:C893',
            messageId: '1700000105.100',
            senderId: 'U893',
            senderName: 'Big Bad Daddy',
          },
        },
        {
          channelId: 'slack',
          accountId: 'kimfamily',
        },
        deps,
      );

      for (let i = 0; i < 50 && sendSlackMessage.mock.calls.length < 1; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(sendSlackMessage).toHaveBeenCalled();
      const sent = sendSlackMessage.mock.calls[0]?.[0] as { message?: string } | undefined;
      expect(sent?.message ?? '').toContain('I could not verify the requested set action safely.');
      expect(sent?.message ?? '').toContain('state write changed a target/goal field instead of a running total');

      const updated = store.getTalk(talk.id);
      const diagnostics = updated?.diagnostics ?? [];
      expect(diagnostics.some((entry) => entry.category === 'intent' && entry.code === 'INTENT_STATE_MISMATCH')).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
