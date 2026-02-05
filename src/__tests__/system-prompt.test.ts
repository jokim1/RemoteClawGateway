import { composeSystemPrompt } from '../system-prompt';
import type { TalkMeta, TalkMessage } from '../types';

function makeMeta(overrides: Partial<TalkMeta> = {}): TalkMeta {
  return {
    id: 'test-talk-1',
    pinnedMessageIds: [],
    jobs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<TalkMessage> = {}): TalkMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'This is a test message.',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('composeSystemPrompt', () => {
  it('returns undefined when no enrichment data exists', () => {
    const result = composeSystemPrompt({
      meta: makeMeta(),
      contextMd: '',
      pinnedMessages: [],
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for whitespace-only contextMd', () => {
    const result = composeSystemPrompt({
      meta: makeMeta(),
      contextMd: '   \n\n  ',
      pinnedMessages: [],
    });
    expect(result).toBeUndefined();
  });

  it('includes objective section when set', () => {
    const result = composeSystemPrompt({
      meta: makeMeta({ objective: 'Help user plan their sprint tasks' }),
      contextMd: '',
      pinnedMessages: [],
    });
    expect(result).toBeDefined();
    expect(result).toContain('## Objective');
    expect(result).toContain('Help user plan their sprint tasks');
    expect(result).toContain('steer it back');
  });

  it('includes context section when contextMd is provided', () => {
    const result = composeSystemPrompt({
      meta: makeMeta(),
      contextMd: 'User is working on a React project. They prefer TypeScript.',
      pinnedMessages: [],
    });
    expect(result).toBeDefined();
    expect(result).toContain('## Conversation Context');
    expect(result).toContain('User is working on a React project');
  });

  it('trims contextMd whitespace', () => {
    const result = composeSystemPrompt({
      meta: makeMeta(),
      contextMd: '\n  Some context with whitespace  \n',
      pinnedMessages: [],
    });
    expect(result).toContain('Some context with whitespace');
    expect(result).not.toContain('\n  Some context');
  });

  it('includes pinned messages section', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'The API endpoint is /api/users and requires Bearer auth.',
      timestamp: new Date('2026-01-15T10:30:00Z').getTime(),
    });
    const result = composeSystemPrompt({
      meta: makeMeta({ pinnedMessageIds: [msg.id] }),
      contextMd: '',
      pinnedMessages: [msg],
    });
    expect(result).toBeDefined();
    expect(result).toContain('## Pinned References');
    expect(result).toContain('assistant');
    expect(result).toContain('2026-01-15 10:30');
    expect(result).toContain('/api/users');
  });

  it('truncates long pinned message content to 200 chars', () => {
    const longContent = 'A'.repeat(300);
    const msg = makeMessage({ content: longContent });
    const result = composeSystemPrompt({
      meta: makeMeta({ pinnedMessageIds: [msg.id] }),
      contextMd: '',
      pinnedMessages: [msg],
    })!;
    // Should contain the truncated version, not the full 300 chars
    expect(result).toContain('A'.repeat(200) + '...');
    expect(result).not.toContain('A'.repeat(201));
  });

  it('includes active jobs section', () => {
    const result = composeSystemPrompt({
      meta: makeMeta({
        jobs: [
          { id: 'j1', schedule: 'every 6h', prompt: 'Check sprint burndown', active: true, createdAt: Date.now() },
          { id: 'j2', schedule: 'daily 9am', prompt: 'Summarize PRs', active: false, createdAt: Date.now() },
        ],
      }),
      contextMd: '',
      pinnedMessages: [],
    });
    expect(result).toBeDefined();
    expect(result).toContain('## Active Jobs');
    expect(result).toContain('[every 6h] Check sprint burndown');
    // Inactive job should NOT appear
    expect(result).not.toContain('Summarize PRs');
  });

  it('omits jobs section when all jobs are inactive', () => {
    const result = composeSystemPrompt({
      meta: makeMeta({
        jobs: [
          { id: 'j1', schedule: 'daily', prompt: 'Paused task', active: false, createdAt: Date.now() },
        ],
      }),
      contextMd: '',
      pinnedMessages: [],
    });
    // Only base instruction, no enrichment → undefined
    expect(result).toBeUndefined();
  });

  it('combines all sections together', () => {
    const msg = makeMessage({ content: 'Important finding about the bug.' });
    const result = composeSystemPrompt({
      meta: makeMeta({
        objective: 'Debug the login flow',
        pinnedMessageIds: [msg.id],
        jobs: [
          { id: 'j1', schedule: 'every 1h', prompt: 'Check error logs', active: true, createdAt: Date.now() },
        ],
      }),
      contextMd: 'User found a null pointer in auth middleware.',
      pinnedMessages: [msg],
    })!;

    expect(result).toContain('focused assistant');
    expect(result).toContain('## Objective');
    expect(result).toContain('Debug the login flow');
    expect(result).toContain('## Conversation Context');
    expect(result).toContain('null pointer in auth middleware');
    expect(result).toContain('## Pinned References');
    expect(result).toContain('Important finding');
    expect(result).toContain('## Active Jobs');
    expect(result).toContain('Check error logs');
  });

  it('always starts with the base instruction', () => {
    const result = composeSystemPrompt({
      meta: makeMeta({ objective: 'Test' }),
      contextMd: '',
      pinnedMessages: [],
    })!;
    expect(result.startsWith('You are a focused assistant')).toBe(true);
  });

  it('separates sections with double newlines', () => {
    const result = composeSystemPrompt({
      meta: makeMeta({ objective: 'Test objective' }),
      contextMd: 'Some context',
      pinnedMessages: [],
    })!;
    // Base instruction and Objective should be separated by \n\n
    expect(result).toContain('conversation.\n\n## Objective');
    expect(result).toContain('reached.\n\n## Conversation Context');
  });
});
