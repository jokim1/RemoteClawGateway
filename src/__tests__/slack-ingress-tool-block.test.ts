import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __resetSlackIngressStateForTests,
  handleSlackMessageReceivedHook,
  hasActiveSuppressionForTarget,
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
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'slack-tool-block-test-'));
  store = new TalkStore(tmpDir, mockLogger);
  await store.init();
  registry = new ToolRegistry(tmpDir, mockLogger);
  executor = new ToolExecutor(registry, store, mockLogger);
  __resetSlackIngressStateForTests();
  jest.clearAllMocks();
});

afterEach(async () => {
  __resetSlackIngressStateForTests();
  await fsp.rm(tmpDir, { recursive: true, force: true });
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

/** Claim an event via the message_received hook so a suppression lease is created. */
async function claimEvent(channelId: string, accountId?: string): Promise<string> {
  const talkId = addSlackBinding(`channel:${channelId}`);
  const deps = buildDeps();
  await handleSlackMessageReceivedHook(
    {
      from: `slack:${accountId ?? 'default'}:U999`,
      content: 'hello',
      metadata: {
        to: `slack:channel:${channelId}`,
        ...(accountId ? { accountId } : {}),
      },
    },
    { channelId: 'slack', conversationId: `slack:channel:${channelId}` },
    deps,
  );
  return talkId;
}

describe('hasActiveSuppressionForTarget', () => {
  it('returns lease info when suppression is active', async () => {
    const talkId = await claimEvent('C123');

    const result = hasActiveSuppressionForTarget({ target: 'channel:C123' });
    expect(result).toBeDefined();
    expect(result!.talkId).toBe(talkId);
    expect(result!.eventId).toBeDefined();
  });

  it('returns undefined when no suppression exists', () => {
    const result = hasActiveSuppressionForTarget({ target: 'channel:CXXX' });
    expect(result).toBeUndefined();
  });

  it('ignores expired suppressions', async () => {
    await claimEvent('C456');

    // Verify suppression exists first
    expect(hasActiveSuppressionForTarget({ target: 'channel:C456' })).toBeDefined();

    // Fast-forward past expiry (default TTL is 120s)
    const realNow = Date.now;
    Date.now = () => realNow() + 200_000;
    try {
      const result = hasActiveSuppressionForTarget({ target: 'channel:C456' });
      expect(result).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  it('normalizes various target formats', async () => {
    await claimEvent('C789');

    // All these should resolve to the same suppression
    expect(hasActiveSuppressionForTarget({ target: 'channel:C789' })).toBeDefined();
    expect(hasActiveSuppressionForTarget({ target: 'slack:channel:C789' })).toBeDefined();
    expect(hasActiveSuppressionForTarget({ target: 'C789' })).toBeDefined();
  });

  it('matches with accountId', async () => {
    await claimEvent('C321', 'workspace-a');

    // Exact account match
    expect(hasActiveSuppressionForTarget({
      accountId: 'workspace-a',
      target: 'channel:C321',
    })).toBeDefined();
  });

  it('does not consume the suppression (read-only)', async () => {
    await claimEvent('C555');

    // Call multiple times — should keep returning the lease
    for (let i = 0; i < 5; i++) {
      expect(hasActiveSuppressionForTarget({ target: 'channel:C555' })).toBeDefined();
    }
  });
});
