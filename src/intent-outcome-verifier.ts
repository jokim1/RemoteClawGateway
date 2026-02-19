type ExecutedTool = {
  requestedName: string;
  executedName: string;
  rawArguments: string;
  resultSuccess: boolean;
  resultContent: string;
};

type SetDirective = {
  subject: string;
  metricPhrase: string;
  requestedValue: number;
  metricKind: 'total' | 'target' | 'unknown';
};

export type IntentVerificationResult =
  | { ok: true }
  | {
      ok: false;
      code: 'INTENT_STATE_MISMATCH';
      title: string;
      message: string;
      correctedReply: string;
      details: Record<string, unknown>;
    };

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeEntityLabel(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9 _'-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((token) => token[0].toUpperCase() + token.slice(1).toLowerCase())
    .join(' ');
}

function inferMetricKind(metricPhrase: string): 'total' | 'target' | 'unknown' {
  const metric = metricPhrase.toLowerCase();
  if (/\b(goal|target|quota|limit|threshold)\b/.test(metric)) return 'target';
  if (/\b(total|time|minutes?|mins?|hours?|hrs?|logged|count|progress)\b/.test(metric)) return 'total';
  return 'unknown';
}

function parseSetDirective(userText: string): SetDirective | null {
  const trimmed = userText.trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    /\bset\s+([a-z][a-z0-9\s'-]{0,40}?)\s*(?:'s)?\s+([a-z][a-z0-9\s/_-]{1,50}?)\s+to\s+(\d{1,6})\s*(?:minutes?|mins?|m|hours?|hrs?)?\b/i,
  );
  if (!match) return null;
  const subject = normalizeEntityLabel(match[1] ?? '');
  const metricPhrase = (match[2] ?? '').trim();
  const requestedValue = Number.parseInt(match[3] ?? '', 10);
  if (!subject || !metricPhrase || !Number.isFinite(requestedValue) || requestedValue < 0) return null;
  return {
    subject,
    metricPhrase,
    requestedValue,
    metricKind: inferMetricKind(metricPhrase),
  };
}

function findSubjectValueInTotals(
  totals: Record<string, unknown>,
  subject: string,
): number | null {
  const target = subject.toLowerCase();
  for (const [key, value] of Object.entries(totals)) {
    if (key.trim().toLowerCase() !== target) continue;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function inferWriteKindFromStateAppend(args: Record<string, unknown>): 'total' | 'target' | 'unknown' {
  const eventType = String(args.event_type ?? '').trim().toLowerCase();
  if (eventType.includes('set_total')) return 'total';
  if (eventType.includes('target') || eventType.includes('goal')) return 'target';
  const payload = args.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'unknown';
  const keys = Object.keys(payload as Record<string, unknown>).map((k) => k.toLowerCase());
  if (keys.some((k) => k.includes('total') || k.includes('minute') || k === 'value')) return 'total';
  if (keys.some((k) => k.includes('target') || k.includes('goal') || k.includes('quota') || k.includes('limit'))) {
    return 'target';
  }
  return 'unknown';
}

function inferWriteKindFromConfigurePolicy(args: Record<string, unknown>): 'target' | 'unknown' {
  if (args.target_minutes !== undefined) return 'target';
  return 'unknown';
}

function readObservedValues(tools: ExecutedTool[], subject: string): {
  totalValue: number | null;
  targetValue: number | null;
  writeKinds: Array<'total' | 'target' | 'unknown'>;
} {
  let totalValue: number | null = null;
  let targetValue: number | null = null;
  const writeKinds: Array<'total' | 'target' | 'unknown'> = [];

  for (const tool of tools) {
    const args = parseJsonObject(tool.rawArguments) ?? {};
    const execName = tool.executedName.trim().toLowerCase();
    if (execName === 'state_append_event') {
      writeKinds.push(inferWriteKindFromStateAppend(args));
    } else if (execName === 'state_configure_policy') {
      writeKinds.push(inferWriteKindFromConfigurePolicy(args));
    }
    const resultObj = parseJsonObject(tool.resultContent);
    if (!resultObj) continue;
    const summary = resultObj.summary && typeof resultObj.summary === 'object' && !Array.isArray(resultObj.summary)
      ? resultObj.summary as Record<string, unknown>
      : resultObj;
    const totals = summary.totals;
    if (totals && typeof totals === 'object' && !Array.isArray(totals)) {
      const found = findSubjectValueInTotals(totals as Record<string, unknown>, subject);
      if (found !== null) totalValue = found;
    }
    const completionTarget = summary.completionTarget;
    if (typeof completionTarget === 'number' && Number.isFinite(completionTarget)) {
      targetValue = completionTarget;
    }
  }

  return { totalValue, targetValue, writeKinds };
}

function buildCorrectedReply(params: {
  directive: SetDirective;
  totalValue: number | null;
  targetValue: number | null;
  mismatchReason: string;
}): string {
  const lines: string[] = [
    `I could not verify the requested set action safely.`,
    `Requested: set ${params.directive.subject} ${params.directive.metricPhrase} to ${params.directive.requestedValue}.`,
    `Observed: ${params.mismatchReason}.`,
  ];
  if (params.totalValue !== null || params.targetValue !== null) {
    const observed: string[] = [];
    if (params.totalValue !== null) observed.push(`total=${params.totalValue}`);
    if (params.targetValue !== null) observed.push(`target=${params.targetValue}`);
    lines.push(`Current state snapshot: ${observed.join(', ')}.`);
  }
  lines.push('Please confirm whether I should apply the requested value directly now.');
  return lines.join('\n');
}

export function verifyIntentOutcome(input: {
  userText: string;
  assistantReply: string;
  executedTools: ExecutedTool[];
}): IntentVerificationResult {
  const directive = parseSetDirective(input.userText);
  if (!directive) return { ok: true };
  const stateTools = input.executedTools.filter((tool) =>
    /^state_/.test(tool.executedName.trim().toLowerCase()),
  );
  if (stateTools.length === 0) return { ok: true };

  const observed = readObservedValues(stateTools, directive.subject);
  const observedKinds = new Set(observed.writeKinds.filter((kind) => kind !== 'unknown'));

  if (directive.metricKind === 'total') {
    if (observedKinds.has('target') && !observedKinds.has('total')) {
      const correctedReply = buildCorrectedReply({
        directive,
        totalValue: observed.totalValue,
        targetValue: observed.targetValue,
        mismatchReason: 'state write changed a target/goal field instead of a running total',
      });
      return {
        ok: false,
        code: 'INTENT_STATE_MISMATCH',
        title: 'Requested value type did not match applied state write',
        message: 'The request implies setting a running total, but observed state writes changed target/goal fields.',
        correctedReply,
        details: {
          requestedMetricKind: directive.metricKind,
          observedWriteKinds: Array.from(observedKinds),
          subject: directive.subject,
        },
      };
    }
    if (observed.totalValue !== null && observed.totalValue !== directive.requestedValue) {
      const correctedReply = buildCorrectedReply({
        directive,
        totalValue: observed.totalValue,
        targetValue: observed.targetValue,
        mismatchReason: `running total is ${observed.totalValue}, not ${directive.requestedValue}`,
      });
      return {
        ok: false,
        code: 'INTENT_STATE_MISMATCH',
        title: 'Applied total did not match requested value',
        message: 'A set request was processed, but observed total does not match the requested value.',
        correctedReply,
        details: {
          requestedMetricKind: directive.metricKind,
          observedTotal: observed.totalValue,
          requestedValue: directive.requestedValue,
          subject: directive.subject,
        },
      };
    }
  }

  if (directive.metricKind === 'target' && observed.targetValue !== null && observed.targetValue !== directive.requestedValue) {
    const correctedReply = buildCorrectedReply({
      directive,
      totalValue: observed.totalValue,
      targetValue: observed.targetValue,
      mismatchReason: `target is ${observed.targetValue}, not ${directive.requestedValue}`,
    });
    return {
      ok: false,
      code: 'INTENT_STATE_MISMATCH',
      title: 'Applied target did not match requested value',
      message: 'A set-target request was processed, but observed target does not match the requested value.',
      correctedReply,
      details: {
        requestedMetricKind: directive.metricKind,
        observedTarget: observed.targetValue,
        requestedValue: directive.requestedValue,
        subject: directive.subject,
      },
    };
  }

  return { ok: true };
}
