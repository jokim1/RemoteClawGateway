import { randomUUID } from 'node:crypto';
import type { TalkMeta } from '../types';
import {
  findSlackBindingConflicts,
  normalizeAndValidatePlatformBehaviorsInput,
  normalizeAndValidatePlatformBindingsInput,
  normalizeSlackBindingScope,
  resolvePlatformBehaviorBindingRefsInput,
} from '../talks';

function makeTalk(bindings: Array<{
  platform: string;
  scope: string;
  permission: 'read' | 'write' | 'read+write';
}>): TalkMeta {
  const now = Date.now();
  return {
    id: randomUUID(),
    pinnedMessageIds: [],
    jobs: [],
    directives: [],
    platformBindings: bindings.map((binding) => ({
      id: randomUUID(),
      platform: binding.platform,
      scope: binding.scope,
      permission: binding.permission,
      createdAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

describe('normalizeSlackBindingScope', () => {
  it('normalizes supported channel/user scopes', () => {
    expect(normalizeSlackBindingScope('channel:C123abc')).toBe('channel:C123ABC');
    expect(normalizeSlackBindingScope('slack:channel:c123')).toBe('channel:C123');
    expect(normalizeSlackBindingScope('user:u999')).toBe('user:U999');
    expect(normalizeSlackBindingScope('slack:user:U111')).toBe('user:U111');
    expect(normalizeSlackBindingScope('slack:*')).toBe('slack:*');
    expect(normalizeSlackBindingScope('*')).toBe('slack:*');
  });

  it('rejects unsupported Slack scope formats', () => {
    expect(normalizeSlackBindingScope('#team-product')).toBeNull();
    expect(normalizeSlackBindingScope('channel-name')).toBeNull();
  });
});

describe('normalizeAndValidatePlatformBindingsInput', () => {
  it('canonicalizes valid Slack bindings and emits ownership keys', async () => {
    const result = await normalizeAndValidatePlatformBindingsInput([
      { platform: 'Slack', scope: 'slack:channel:c123', permission: 'read+write' },
      { platform: 'slack', scope: 'user:u777', permission: 'write' },
      { platform: 'telegram', scope: 'group:abc', permission: 'read' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings[0]).toMatchObject({ platform: 'slack', scope: 'channel:C123' });
    expect(result.bindings[1]).toMatchObject({ platform: 'slack', scope: 'user:U777' });
    expect(result.ownershipKeys).toEqual(
      expect.arrayContaining([
        'slack:default:channel:c123',
        'slack:default:user:u777',
      ]),
    );
  });

  it('resolves account-qualified channel names with resolver', async () => {
    const result = await normalizeAndValidatePlatformBindingsInput(
      [
        { platform: 'slack', scope: 'kimfamily:#general', permission: 'read+write' },
      ],
      {
        resolveSlackScope: async (_scope, accountId) => ({
          ok: true,
          canonicalScope: 'channel:C12345678',
          accountId,
          displayScope: '#general',
        }),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings[0]).toMatchObject({
      platform: 'slack',
      accountId: 'kimfamily',
      scope: 'channel:C12345678',
      displayScope: '#general',
    });
    expect(result.ownershipKeys).toContain('slack:kimfamily:channel:c12345678');
  });

  it('fails for invalid Slack scope formats', async () => {
    const result = await normalizeAndValidatePlatformBindingsInput([
      { platform: 'slack', scope: '#team-product', permission: 'read+write' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('invalid Slack scope');
  });
});

describe('normalizeAndValidatePlatformBehaviorsInput', () => {
  it('validates behavior rows against bindings and agents', () => {
    const bindingId = randomUUID();
    const result = normalizeAndValidatePlatformBehaviorsInput(
      [{
        platformBindingId: bindingId,
        agentName: 'DeepSeek',
        onMessagePrompt: 'Reply with concise action items.',
      }],
      {
        bindings: [{
          id: bindingId,
          platform: 'slack',
          scope: 'channel:C123',
          permission: 'read+write',
          createdAt: Date.now(),
        }],
        agents: [{
          name: 'DeepSeek',
          model: 'deepseek',
          role: 'analyst',
          isPrimary: true,
        }],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.behaviors).toHaveLength(1);
    expect(result.behaviors[0]).toMatchObject({
      platformBindingId: bindingId,
      agentName: 'DeepSeek',
      onMessagePrompt: 'Reply with concise action items.',
    });
  });

  it('accepts deliveryMode and responsePolicy fields', () => {
    const bindingId = randomUUID();
    const result = normalizeAndValidatePlatformBehaviorsInput(
      [{
        platformBindingId: bindingId,
        responseMode: 'all',
        deliveryMode: 'adaptive',
        responsePolicy: {
          triggerPolicy: 'advice_or_study',
          allowedSenders: ['Asher', 'Jaxon'],
          minConfidence: 0.7,
        },
      }],
      {
        bindings: [{
          id: bindingId,
          platform: 'slack',
          scope: 'channel:C123',
          permission: 'read+write',
          createdAt: Date.now(),
        }],
        agents: [],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.behaviors[0]).toMatchObject({
      platformBindingId: bindingId,
      responseMode: 'all',
      deliveryMode: 'adaptive',
      responsePolicy: {
        triggerPolicy: 'advice_or_study',
        allowedSenders: ['Asher', 'Jaxon'],
        minConfidence: 0.7,
      },
    });
  });

  it('rejects behavior rows with unknown binding or unknown agent', () => {
    const unknownBinding = normalizeAndValidatePlatformBehaviorsInput(
      [{ platformBindingId: 'missing-binding', onMessagePrompt: 'Hi' }],
      { bindings: [], agents: [] },
    );
    expect(unknownBinding.ok).toBe(false);
    if (unknownBinding.ok) return;
    expect(unknownBinding.error).toContain('unknown binding');

    const knownBindingId = randomUUID();
    const unknownAgent = normalizeAndValidatePlatformBehaviorsInput(
      [{ platformBindingId: knownBindingId, agentName: 'NotHere' }],
      {
        bindings: [{
          id: knownBindingId,
          platform: 'slack',
          scope: 'channel:C123',
          permission: 'read+write',
          createdAt: Date.now(),
        }],
        agents: [],
      },
    );
    expect(unknownAgent.ok).toBe(false);
    if (unknownAgent.ok) return;
    expect(unknownAgent.error).toContain('unknown agent');
  });
});

describe('findSlackBindingConflicts', () => {
  it('detects write/read+write conflicts on other talks', () => {
    const existing = makeTalk([
      { platform: 'slack', scope: 'channel:C123', permission: 'read+write' },
    ]);
    existing.platformBindings![0].accountId = 'default';
    const conflicts = findSlackBindingConflicts({
      candidateOwnershipKeys: ['slack:default:channel:c123'],
      talks: [existing],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ scope: 'channel:C123', talkId: existing.id });
  });

  it('does not conflict with read-only bindings or skipped talk', () => {
    const existingReadOnly = makeTalk([
      { platform: 'slack', scope: 'channel:C123', permission: 'read' },
    ]);
    const existingWritable = makeTalk([
      { platform: 'slack', scope: 'channel:C123', permission: 'write' },
    ]);

    expect(
      findSlackBindingConflicts({
        candidateOwnershipKeys: ['slack:default:channel:c123'],
        talks: [existingReadOnly],
      }),
    ).toHaveLength(0);

    expect(
      findSlackBindingConflicts({
        candidateOwnershipKeys: ['slack:default:channel:c123'],
        talks: [existingWritable],
        skipTalkId: existingWritable.id,
      }),
    ).toHaveLength(0);
  });
});

describe('resolvePlatformBehaviorBindingRefsInput', () => {
  it('resolves channelResponseSettings connectionId platformN aliases', () => {
    const bindings = [
      {
        id: randomUUID(),
        platform: 'slack',
        scope: 'channel:C111',
        permission: 'read+write' as const,
        createdAt: Date.now(),
      },
      {
        id: randomUUID(),
        platform: 'slack',
        scope: 'channel:C222',
        permission: 'read+write' as const,
        createdAt: Date.now(),
      },
    ];

    const mapped = resolvePlatformBehaviorBindingRefsInput(
      [{ connectionId: 'platform2', onMessagePrompt: 'Do work' }],
      bindings,
    ) as Array<{ platformBindingId?: string }>;

    expect(mapped[0]?.platformBindingId).toBe(bindings[1].id);
  });

  it('defaults to the only binding when none specified', () => {
    const bindings = [
      {
        id: randomUUID(),
        platform: 'slack',
        scope: 'channel:C111',
        permission: 'read+write' as const,
        createdAt: Date.now(),
      },
    ];
    const mapped = resolvePlatformBehaviorBindingRefsInput(
      [{ onMessagePrompt: 'Do work' }],
      bindings,
    ) as Array<{ platformBindingId?: string }>;
    expect(mapped[0]?.platformBindingId).toBe(bindings[0].id);
  });
});
