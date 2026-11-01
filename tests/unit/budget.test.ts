import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXHAUSTION_REASONS,
  addActive,
  exhaustion,
  interrupt,
  overshootOf,
  reserve,
  settle,
  type CallRequest,
  type CallUsage,
  type ExhaustionReason,
  type Settlement,
} from '../../src/agent/budget.ts';
import { newRunDoc, type RunDoc, type UsageEventDoc, type UsageSummary } from '../../src/cases/documents.ts';
import { BASE_RUN_LIMITS, type RunLimits } from '../../src/config/limits.ts';
import { AT } from '../support/case-fixtures.ts';

const NOW = new Date(AT);

function newRun(limits: Partial<RunLimits> = {}, mode: 'demo' | 'live' = 'demo'): RunDoc {
  return newRunDoc({
    tenantId: 'aurora',
    caseId: 'case_0123456789abcdef0123456789abcdef',
    revision: 1,
    mode,
    limits: { ...BASE_RUN_LIMITS, ...limits },
    now: NOW,
  });
}

const tool = (patch: Partial<CallRequest> = {}): CallRequest => ({
  kind: 'tool',
  name: 'get_account',
  attempt: 1,
  startsTurn: true,
  estimate: { tokens: 0, costMicroUsd: 0 },
  now: NOW,
  ...patch,
});

const model = (patch: Partial<CallRequest> = {}): CallRequest =>
  tool({ kind: 'model', name: 'live-model', estimate: { tokens: 400, costMicroUsd: 4_000 }, ...patch });

const done = (patch: Partial<Settlement> = {}): Settlement => ({
  outcome: 'succeeded',
  errorCode: null,
  latencyMs: 12,
  usage: null,
  now: NOW,
  ...patch,
});

const measured = (input: number, output: number, cost: number): CallUsage => ({
  inputTokens: input,
  outputTokens: output,
  tokenQuality: 'measured',
  costMicroUsd: cost,
  costQuality: 'measured',
});

const withUsage = (run: RunDoc, patch: Partial<UsageSummary>): RunDoc => ({ ...run, usage: { ...run.usage, ...patch } });
const withCharged = (run: RunDoc, tokens: number, costMicroUsd: number): RunDoc => ({ ...run, charged: { tokens, costMicroUsd } });

function reserved(run: RunDoc, request: CallRequest): { run: RunDoc; event: UsageEventDoc } {
  const result = reserve(run, request);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result;
}

/** Reserves and settles calls until one is refused. */
function drain(
  start: RunDoc,
  request: (accepted: number) => CallRequest,
  settlement: Settlement = done(),
): { accepted: number; reason: ExhaustionReason; run: RunDoc } {
  let run = start;
  for (let accepted = 0; accepted < 1_000; accepted++) {
    const result = reserve(run, request(accepted));
    if (!result.ok) return { accepted, reason: result.reason, run };
    run = settle(result.run, result.event, settlement).run;
  }
  throw new Error('no call was ever refused');
}

interface Boundary {
  request: CallRequest;
  /** One short of the limit: the call is allowed. */
  below: RunDoc;
  /** At the limit: the call is refused. */
  at: RunDoc;
}

// Typed by reason so that a new reason cannot be added without a boundary for it.
const BOUNDARIES: Record<ExhaustionReason, Boundary> = {
  active_time_exhausted: {
    request: tool(),
    below: addActive(newRun({ activeMs: 1_000 }), 999),
    at: addActive(newRun({ activeMs: 1_000 }), 1_000),
  },
  steps_exhausted: {
    request: tool(),
    below: withUsage(newRun({ steps: 3 }), { steps: 2 }),
    at: withUsage(newRun({ steps: 3 }), { steps: 3 }),
  },
  tool_calls_exhausted: {
    request: tool({ startsTurn: false }),
    below: withUsage(newRun({ toolCalls: 4 }), { toolCalls: 3 }),
    at: withUsage(newRun({ toolCalls: 4 }), { toolCalls: 4 }),
  },
  model_calls_exhausted: {
    request: model({ startsTurn: false }),
    below: withUsage(newRun({ modelCalls: 4 }), { modelCalls: 3 }),
    at: withUsage(newRun({ modelCalls: 4 }), { modelCalls: 4 }),
  },
  retries_per_call_exhausted: {
    request: tool({ attempt: 3, startsTurn: false }),
    below: newRun({ retriesPerCall: 2 }),
    at: newRun({ retriesPerCall: 1 }),
  },
  retries_exhausted: {
    request: tool({ attempt: 2, startsTurn: false }),
    below: withUsage(newRun({ retriesPerRun: 3 }), { retries: 2 }),
    at: withUsage(newRun({ retriesPerRun: 3 }), { retries: 3 }),
  },
  tokens_exhausted: {
    request: model({ startsTurn: false }),
    below: withCharged(newRun({ tokens: 1_000 }), 600, 0),
    at: withCharged(newRun({ tokens: 1_000 }), 601, 0),
  },
  cost_exhausted: {
    request: model({ startsTurn: false }),
    below: withCharged(newRun({ costMicroUsd: 10_000 }), 0, 6_000),
    at: withCharged(newRun({ costMicroUsd: 10_000 }), 0, 6_001),
  },
};

describe('reserving an allowance', () => {
  it('counts the call, records a reserved event, and leaves its input alone', () => {
    const before = newRun();
    const snapshot = structuredClone(before);
    const { run, event } = reserved(before, tool());

    assert.deepEqual(before, snapshot);
    assert.deepEqual(
      { steps: run.usage.steps, toolCalls: run.usage.toolCalls, modelCalls: run.usage.modelCalls, retries: run.usage.retries },
      { steps: 1, toolCalls: 1, modelCalls: 0, retries: 0 },
    );
    assert.equal(run.nextEventSeq, 2);
    assert.deepEqual(run.reserved, { tokens: 0, costMicroUsd: 0 });
    assert.deepEqual(run.charged, { tokens: 0, costMicroUsd: 0 });
    assert.equal(run.updatedAt, AT);

    assert.deepEqual(event, {
      id: 'usage-run-1-0001',
      tenantId: 'aurora',
      caseId: before.caseId,
      type: 'usage',
      schemaVersion: event.schemaVersion,
      eventId: 'usage-run-1-0001',
      runId: 'run-1',
      seq: 1,
      kind: 'tool',
      name: 'get_account',
      outcome: 'reserved',
      attempt: 1,
      at: AT,
      inputTokens: null,
      outputTokens: null,
      tokenQuality: 'not_applicable',
      costMicroUsd: null,
      costQuality: 'not_applicable',
      latencyMs: null,
      errorCode: null,
      reservedTokens: 0,
      reservedCostMicroUsd: 0,
    });
  });

  it('holds the estimate of a call that uses a model, and marks its usage as not yet known', () => {
    const { run, event } = reserved(newRun({}, 'live'), model());
    assert.deepEqual(run.reserved, { tokens: 400, costMicroUsd: 4_000 });
    assert.deepEqual(run.charged, { tokens: 0, costMicroUsd: 0 });
    assert.equal(run.usage.modelCalls, 1);
    assert.equal(run.usage.toolCalls, 0);
    assert.equal(event.kind, 'model');
    assert.equal(event.tokenQuality, 'unknown');
    assert.equal(event.costQuality, 'unknown');
    assert.equal(event.reservedTokens, 400);
    assert.equal(event.reservedCostMicroUsd, 4_000);
  });

  it('counts a retry as a call and as a retry, but not as a step', () => {
    const first = reserved(newRun(), tool());
    const retry = reserved(settle(first.run, first.event, done({ outcome: 'failed', errorCode: 'tool_error' })).run, tool({ attempt: 2, startsTurn: false }));
    assert.equal(retry.run.usage.steps, 1);
    assert.equal(retry.run.usage.toolCalls, 2);
    assert.equal(retry.run.usage.retries, 1);
    assert.equal(retry.event.attempt, 2);
    assert.equal(retry.event.seq, 2);
    assert.equal(retry.event.id, 'usage-run-1-0002');
  });

  it('numbers events one after another and never reuses a number', () => {
    let run = newRun();
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      const next = reserved(run, tool({ startsTurn: false }));
      ids.push(next.event.id);
      run = settle(next.run, next.event, done()).run;
    }
    assert.deepEqual(ids, ['usage-run-1-0001', 'usage-run-1-0002', 'usage-run-1-0003', 'usage-run-1-0004', 'usage-run-1-0005']);
    assert.equal(run.nextEventSeq, 6);
  });

  it('does not let outstanding reservations pass a limit together', () => {
    const first = reserved(newRun({ tokens: 1_000 }, 'live'), model());
    const second = reserved(first.run, model({ startsTurn: false }));
    assert.deepEqual(second.run.reserved, { tokens: 800, costMicroUsd: 8_000 });
    const third = reserve(second.run, model({ startsTurn: false }));
    assert.deepEqual(third, { ok: false, reason: 'tokens_exhausted' });
  });

  it('refuses a request that cannot be a real call', () => {
    const run = newRun();
    const bad: ReadonlyArray<readonly [string, CallRequest]> = [
      ['attempt 0', tool({ attempt: 0 })],
      ['a fractional attempt', tool({ attempt: 1.5 })],
      ['a retry that starts a turn', tool({ attempt: 2, startsTurn: true })],
      ['an empty name', tool({ name: '' })],
      ['a long name', tool({ name: 'n'.repeat(81) })],
      ['a negative estimate', model({ estimate: { tokens: -1, costMicroUsd: 0 } })],
      ['a fractional estimate', model({ estimate: { tokens: 1.5, costMicroUsd: 0 } })],
      ['an infinite estimate', model({ estimate: { tokens: 0, costMicroUsd: Number.POSITIVE_INFINITY } })],
      ['an estimate that is not a number', model({ estimate: { tokens: Number.NaN, costMicroUsd: 0 } })],
    ];
    for (const [label, request] of bad) assert.throws(() => reserve(run, request), RangeError, label);
  });
});

describe('the limits', () => {
  for (const reason of EXHAUSTION_REASONS) {
    it(`${reason}: allows a call one short of the limit and refuses one at it`, () => {
      const { request, below, at } = BOUNDARIES[reason];
      assert.equal(exhaustion(below, request), null);
      assert.ok(reserve(below, request).ok);
      assert.equal(exhaustion(at, request), reason);
      assert.deepEqual(reserve(at, request), { ok: false, reason });
    });
  }

  it('names every reason as a short code that fits a stop reason', () => {
    assert.equal(new Set(EXHAUSTION_REASONS).size, EXHAUSTION_REASONS.length);
    for (const reason of EXHAUSTION_REASONS) assert.match(reason, /^[a-z]+(_[a-z]+)*$/);
    assert.deepEqual(Object.keys(BOUNDARIES).sort(), [...EXHAUSTION_REASONS].sort());
  });

  it('stops a run after exactly as many steps as it was given', () => {
    const { accepted, reason } = drain(newRun({ steps: 3 }), () => tool());
    assert.deepEqual({ accepted, reason }, { accepted: 3, reason: 'steps_exhausted' });
  });

  it('stops after the tool calls it was given, and a retry uses that allowance too', () => {
    const { accepted, reason } = drain(newRun({ toolCalls: 4, steps: 100 }), (n) => tool({ attempt: n === 0 ? 1 : 2, startsTurn: n === 0 }));
    assert.deepEqual({ accepted, reason }, { accepted: 4, reason: 'tool_calls_exhausted' });
  });

  it('stops after the model calls it was given', () => {
    const { accepted, reason } = drain(newRun({ modelCalls: 2, steps: 100, tokens: 1_000_000, costMicroUsd: 1_000_000 }, 'live'), () => model());
    assert.deepEqual({ accepted, reason }, { accepted: 2, reason: 'model_calls_exhausted' });
  });

  it('does not charge a step for a call that continues a turn', () => {
    const { accepted, reason } = drain(newRun({ steps: 1, toolCalls: 5 }), (n) => tool({ startsTurn: n === 0 }));
    assert.deepEqual({ accepted, reason }, { accepted: 5, reason: 'tool_calls_exhausted' });
  });

  it('allows each call its retries and the run only its own total', () => {
    const limits = { retriesPerCall: 2, retriesPerRun: 3, steps: 100, toolCalls: 100 };
    let run = newRun(limits);
    const attempts: boolean[] = [];
    for (const attempt of [1, 2, 3, 1, 2, 3]) {
      const result = reserve(run, tool({ attempt, startsTurn: attempt === 1 }));
      attempts.push(result.ok);
      if (result.ok) run = settle(result.run, result.event, done({ outcome: 'failed', errorCode: 'tool_error' })).run;
    }
    // Attempts 2 and 3 of the first call and attempt 2 of the second use the run's three retries.
    assert.deepEqual(attempts, [true, true, true, true, true, false]);
    assert.equal(run.usage.retries, 3);
    assert.deepEqual(reserve(run, tool({ attempt: 4, startsTurn: false })), { ok: false, reason: 'retries_per_call_exhausted' });
  });

  it('refunds what a call did not use, and refuses once the limit is reached', () => {
    const limits = { tokens: 1_000, steps: 100, modelCalls: 100, costMicroUsd: 1_000_000 };
    const used = drain(newRun(limits, 'live'), () => model(), done({ usage: measured(100, 100, 100) }));
    assert.deepEqual({ accepted: used.accepted, reason: used.reason }, { accepted: 4, reason: 'tokens_exhausted' });
    assert.equal(used.run.charged.tokens, 800);

    const unknown = drain(newRun(limits, 'live'), () => model(), done({ outcome: 'failed', errorCode: 'model_error' }));
    assert.deepEqual({ accepted: unknown.accepted, reason: unknown.reason }, { accepted: 2, reason: 'tokens_exhausted' });
    assert.equal(unknown.run.charged.tokens, 800, 'what is not known is charged at the reservation');
  });

  it('refuses on cost as it does on tokens', () => {
    const { accepted, reason, run } = drain(newRun({ costMicroUsd: 10_000, steps: 100, modelCalls: 100, tokens: 1_000_000 }, 'live'), () => model(), done({ usage: measured(10, 10, 4_000) }));
    assert.deepEqual({ accepted, reason }, { accepted: 2, reason: 'cost_exhausted' });
    assert.equal(run.charged.costMicroUsd, 8_000);
  });

  it('stops once the active time is spent, whatever else remains', () => {
    const run = addActive(newRun({ activeMs: 5_000 }), 4_999);
    assert.ok(reserve(run, tool()).ok);
    assert.deepEqual(reserve(addActive(run, 1), tool()), { ok: false, reason: 'active_time_exhausted' });
    assert.deepEqual(reserve(addActive(run, 60_000), tool()), { ok: false, reason: 'active_time_exhausted' });
  });

  it('adds active time only for positive, finite amounts, and without changing its input', () => {
    const run = newRun();
    assert.equal(addActive(run, 0), run);
    assert.equal(addActive(run, -5), run);
    assert.equal(addActive(run, Number.NaN), run);
    assert.equal(addActive(run, Number.POSITIVE_INFINITY), run);
    assert.equal(addActive(addActive(run, 10.4), 5).usage.activeMs, 15);
    assert.equal(run.usage.activeMs, 0);
  });

  it('reports the first limit passed, in a fixed order', () => {
    const limits = { steps: 1, toolCalls: 1, modelCalls: 1, tokens: 10, costMicroUsd: 10, retriesPerCall: 1, retriesPerRun: 0, activeMs: 1 };
    let run = withCharged(withUsage(newRun(limits), { steps: 1, toolCalls: 1, activeMs: 1 }), 11, 11);
    const expected: Array<ExhaustionReason | null> = ['active_time_exhausted', 'steps_exhausted', 'tool_calls_exhausted', 'tokens_exhausted', 'cost_exhausted', null];
    const fixes: Array<(run: RunDoc) => RunDoc> = [
      (r) => withUsage(r, { activeMs: 0 }),
      (r) => withUsage(r, { steps: 0 }),
      (r) => withUsage(r, { toolCalls: 0 }),
      (r) => withCharged(r, 0, r.charged.costMicroUsd),
      (r) => withCharged(r, 0, 0),
    ];
    const seen: Array<ExhaustionReason | null> = [];
    for (let index = 0; index <= fixes.length; index++) {
      seen.push(exhaustion(run, tool()));
      const fix = fixes[index];
      if (fix !== undefined) run = fix(run);
    }
    assert.deepEqual(seen, expected);

    const retryRun = withUsage(newRun(limits), { retries: 0 });
    assert.equal(exhaustion(retryRun, tool({ attempt: 3, startsTurn: false })), 'retries_per_call_exhausted', 'the call limit is named before the run limit');
    assert.equal(exhaustion(retryRun, tool({ attempt: 2, startsTurn: false })), 'retries_exhausted');
    assert.equal(exhaustion(withUsage(newRun(limits), { modelCalls: 1 }), model({ startsTurn: false })), 'model_calls_exhausted');
  });
});

describe('settling a call', () => {
  it('settles the event it reserved, under the same id and sequence number, so that what a client read earlier changes in place', () => {
    for (const settlement of [done(), done({ outcome: 'failed', errorCode: 'tool_error' }), done({ outcome: 'ambiguous', errorCode: 'interrupted' }), done({ outcome: 'rejected_by_code', errorCode: 'exceeds_request' })]) {
      const start = reserved(newRun(), tool());
      const { event } = settle(start.run, start.event, settlement);
      assert.equal(start.event.outcome, 'reserved');
      assert.notEqual(event.outcome, 'reserved', settlement.outcome);
      assert.deepEqual([event.id, event.eventId, event.seq, event.runId, event.attempt], [start.event.id, start.event.eventId, start.event.seq, start.event.runId, start.event.attempt]);
    }
  });

  it('records a call that used nothing as not applicable and charges nothing', () => {
    const start = reserved(newRun(), tool());
    const before = structuredClone(start);
    const { run, event, overshoot } = settle(start.run, start.event, done());

    assert.deepEqual(start, before, 'the inputs are not changed');
    assert.equal(event.outcome, 'succeeded');
    assert.equal(event.latencyMs, 12);
    assert.equal(event.errorCode, null);
    assert.deepEqual([event.inputTokens, event.outputTokens, event.costMicroUsd], [null, null, null]);
    assert.deepEqual([event.tokenQuality, event.costQuality], ['not_applicable', 'not_applicable']);
    assert.deepEqual(run.reserved, { tokens: 0, costMicroUsd: 0 });
    assert.deepEqual(run.charged, { tokens: 0, costMicroUsd: 0 });
    assert.deepEqual(overshoot, { tokens: 0, costMicroUsd: 0 });
    assert.equal(run.usage.inputTokens, null);
    assert.equal(run.usage.tokenQuality, 'not_applicable');
    assert.equal(run.usage.costQuality, 'not_applicable');
  });

  it('counts a call refused by code as a call that used a step, and not as a failure', () => {
    const start = reserved(newRun(), tool());
    const { run, event } = settle(start.run, start.event, done({ outcome: 'rejected_by_code', errorCode: 'exceeds_request' }));
    assert.equal(event.outcome, 'rejected_by_code');
    assert.equal(event.errorCode, 'exceeds_request');
    assert.deepEqual([run.usage.steps, run.usage.toolCalls, run.usage.failedCalls, run.usage.ambiguousCalls], [1, 1, 0, 0]);
  });

  it('counts failed and ambiguous calls separately', () => {
    const failed = reserved(newRun(), tool());
    const afterFailure = settle(failed.run, failed.event, done({ outcome: 'failed', errorCode: 'tool_error' })).run;
    assert.deepEqual([afterFailure.usage.failedCalls, afterFailure.usage.ambiguousCalls], [1, 0]);

    const lost = reserved(afterFailure, tool({ startsTurn: false }));
    const afterLoss = settle(lost.run, lost.event, done({ outcome: 'ambiguous', errorCode: 'interrupted' })).run;
    assert.deepEqual([afterLoss.usage.failedCalls, afterLoss.usage.ambiguousCalls], [1, 1]);
  });

  it('charges the measured amount, which may be less than the reservation', () => {
    const start = reserved(newRun({}, 'live'), model());
    const { run, event } = settle(start.run, start.event, done({ usage: measured(120, 30, 1_500) }));
    assert.deepEqual(run.charged, { tokens: 150, costMicroUsd: 1_500 });
    assert.deepEqual(run.reserved, { tokens: 0, costMicroUsd: 0 });
    assert.deepEqual([run.usage.inputTokens, run.usage.outputTokens, run.usage.costMicroUsd], [120, 30, 1_500]);
    assert.deepEqual([run.usage.tokenQuality, run.usage.costQuality], ['measured', 'measured']);
    assert.deepEqual([event.inputTokens, event.outputTokens, event.costMicroUsd], [120, 30, 1_500]);
    assert.deepEqual([event.tokenQuality, event.costQuality], ['measured', 'measured']);
  });

  it('records a soft-limit overshoot, and refuses everything after it, even a call that uses no model', () => {
    const start = reserved(newRun({ tokens: 500, costMicroUsd: 5_000 }, 'live'), model());
    const { run, overshoot } = settle(start.run, start.event, done({ usage: measured(500, 100, 7_000) }));
    assert.deepEqual(run.charged, { tokens: 600, costMicroUsd: 7_000 });
    assert.deepEqual(overshoot, { tokens: 100, costMicroUsd: 2_000 });
    assert.deepEqual(overshootOf(run), overshoot);
    assert.deepEqual(reserve(run, tool({ startsTurn: false })), { ok: false, reason: 'tokens_exhausted' });
  });

  it('charges an estimate as it was given, and says that it is one', () => {
    const start = reserved(newRun({}, 'live'), model());
    const usage: CallUsage = { inputTokens: 300, outputTokens: 100, tokenQuality: 'estimated', costMicroUsd: 3_000, costQuality: 'estimated' };
    const { run, event } = settle(start.run, start.event, done({ usage }));
    assert.deepEqual(run.charged, { tokens: 400, costMicroUsd: 3_000 });
    assert.deepEqual([event.tokenQuality, event.costQuality], ['estimated', 'estimated']);
    assert.deepEqual([run.usage.tokenQuality, run.usage.costQuality], ['estimated', 'estimated']);
  });

  it('charges the whole reservation for usage that was not reported, and never reports it as zero', () => {
    const start = reserved(newRun({}, 'live'), model());
    const { run, event } = settle(start.run, start.event, done());
    assert.deepEqual(run.charged, { tokens: 400, costMicroUsd: 4_000 });
    assert.deepEqual([event.inputTokens, event.outputTokens, event.costMicroUsd], [null, null, null]);
    assert.deepEqual([event.tokenQuality, event.costQuality], ['unknown', 'unknown']);
    assert.deepEqual([run.usage.tokenQuality, run.usage.costQuality], ['unknown', 'unknown']);
    assert.deepEqual([run.usage.inputTokens, run.usage.outputTokens, run.usage.costMicroUsd], [0, 0, 0], 'the totals hold what was measured, and the quality says they are incomplete');
  });

  it('charges a failed model call at its reservation', () => {
    const start = reserved(newRun({}, 'live'), model());
    const { run, event } = settle(start.run, start.event, done({ outcome: 'failed', errorCode: 'model_error' }));
    assert.deepEqual(run.charged, { tokens: 400, costMicroUsd: 4_000 });
    assert.equal(run.usage.failedCalls, 1);
    assert.equal(event.errorCode, 'model_error');
    assert.equal(event.tokenQuality, 'unknown');
  });

  it('does not accept a quantity it cannot trust as a measurement, and judges tokens and cost separately', () => {
    // Which of the two the call must be charged for at its reservation, because its report cannot be trusted.
    const bad: ReadonlyArray<readonly [string, CallUsage, { tokens: boolean; cost: boolean }]> = [
      ['a negative count', { ...measured(1, 1, 1), inputTokens: -1 }, { tokens: true, cost: false }],
      ['a fractional count', { ...measured(1, 1, 1), outputTokens: 1.5 }, { tokens: true, cost: false }],
      ['a count that is not a number', { ...measured(1, 1, 1), inputTokens: Number.NaN }, { tokens: true, cost: false }],
      ['an infinite cost', { ...measured(1, 1, 1), costMicroUsd: Number.POSITIVE_INFINITY }, { tokens: false, cost: true }],
      ['a missing count', { ...measured(1, 1, 1), outputTokens: null }, { tokens: true, cost: false }],
      ['a quality that is unknown', { ...measured(1, 1, 1), tokenQuality: 'unknown', costQuality: 'unknown' }, { tokens: true, cost: true }],
    ];
    for (const [label, usage, fallsBack] of bad) {
      const start = reserved(newRun({}, 'live'), model());
      const { run, event } = settle(start.run, start.event, done({ usage }));
      assert.deepEqual(run.charged, { tokens: fallsBack.tokens ? 400 : 2, costMicroUsd: fallsBack.cost ? 4_000 : 1 }, label);
      assert.equal(event.tokenQuality, fallsBack.tokens ? 'unknown' : 'measured', label);
      assert.equal(event.costQuality, fallsBack.cost ? 'unknown' : 'measured', label);
    }
  });

  it('keeps what a partial report did say, and still treats the call as unknown', () => {
    const start = reserved(newRun({}, 'live'), model());
    const { run, event } = settle(start.run, start.event, done({ usage: { ...measured(250, 0, 0), outputTokens: null, costMicroUsd: null, costQuality: 'unknown' } }));
    assert.deepEqual([event.inputTokens, event.outputTokens], [250, null]);
    assert.equal(event.tokenQuality, 'unknown');
    assert.deepEqual(run.charged, { tokens: 400, costMicroUsd: 4_000 });
    assert.equal(run.usage.inputTokens, 250);
  });

  it('combines the quality of calls as the least certain of them, and never improves it', () => {
    const steps: ReadonlyArray<readonly [CallUsage | null, 'model' | 'tool', string]> = [
      [null, 'tool', 'measured'],
      [measured(10, 10, 10), 'model', 'measured'],
      [null, 'tool', 'measured'],
      [{ inputTokens: 5, outputTokens: 5, tokenQuality: 'estimated', costMicroUsd: 5, costQuality: 'estimated' }, 'model', 'estimated'],
      [measured(10, 10, 10), 'model', 'estimated'],
      [null, 'model', 'unknown'],
      [measured(10, 10, 10), 'model', 'unknown'],
      [null, 'tool', 'unknown'],
    ];
    let run = newRun({ steps: 100, toolCalls: 100, modelCalls: 100, tokens: 1_000_000, costMicroUsd: 1_000_000 }, 'live');
    assert.equal(run.usage.tokenQuality, 'measured');
    for (const [usage, kind, quality] of steps) {
      const next = reserved(run, kind === 'model' ? model({ startsTurn: false }) : tool({ startsTurn: false }));
      run = settle(next.run, next.event, done({ usage })).run;
      assert.equal(run.usage.tokenQuality, quality);
      assert.equal(run.usage.costQuality, quality);
    }
    assert.deepEqual([run.usage.inputTokens, run.usage.outputTokens, run.usage.costMicroUsd], [35, 35, 35], 'the totals add only what was reported');
  });

  it('keeps the totals of a demo run empty, because a demo run uses no model', () => {
    let run = newRun();
    for (let n = 0; n < 3; n++) {
      const next = reserved(run, tool());
      run = settle(next.run, next.event, done()).run;
    }
    const { usage } = run;
    assert.deepEqual([usage.inputTokens, usage.outputTokens, usage.costMicroUsd], [null, null, null]);
    assert.deepEqual([usage.tokenQuality, usage.costQuality], ['not_applicable', 'not_applicable']);
  });

  it('refuses to settle an event twice, or one that belongs to another run', () => {
    const start = reserved(newRun(), tool());
    const settled = settle(start.run, start.event, done());
    assert.throws(() => settle(settled.run, settled.event, done()), RangeError);

    const other = newRunDoc({ tenantId: 'aurora', caseId: 'case_ffffffffffffffffffffffffffffffff', revision: 1, mode: 'demo', limits: BASE_RUN_LIMITS, now: NOW });
    assert.throws(() => settle(other, start.event, done()), RangeError);
    const elsewhere = newRunDoc({ tenantId: 'borealis', caseId: start.run.caseId, revision: 1, mode: 'demo', limits: BASE_RUN_LIMITS, now: NOW });
    assert.throws(() => settle(elsewhere, start.event, done()), RangeError);
  });
});

describe('recovering a run that stopped in the middle of a call', () => {
  it('settles each outstanding call as ambiguous and charges its reservation', () => {
    let run = newRun({}, 'live');
    const first = reserved(run, model());
    run = first.run;
    const second = reserved(run, tool({ startsTurn: false }));
    const before = structuredClone(second.run);

    const later = new Date('2026-03-01T10:05:00.000Z');
    const result = interrupt(second.run, [first.event, second.event], later);

    assert.deepEqual(second.run, before, 'the input is not changed');
    assert.deepEqual(
      result.events.map((event) => [event.outcome, event.errorCode, event.tokenQuality, event.inputTokens]),
      [
        ['ambiguous', 'interrupted', 'unknown', null],
        ['ambiguous', 'interrupted', 'not_applicable', null],
      ],
    );
    assert.deepEqual(
      result.events.map((event) => [event.id, event.eventId, event.seq]),
      [first.event, second.event].map((event) => [event.id, event.eventId, event.seq]),
      'each is settled in place, under the id and sequence number it was reserved with',
    );
    assert.deepEqual(result.run.charged, { tokens: 400, costMicroUsd: 4_000 });
    assert.deepEqual(result.run.reserved, { tokens: 0, costMicroUsd: 0 });
    assert.equal(result.run.usage.ambiguousCalls, 2);
    assert.equal(result.run.usage.failedCalls, 0);
    assert.equal(result.run.usage.tokenQuality, 'unknown');
    assert.equal(result.run.updatedAt, later.toISOString());
  });

  it('keeps every counter, so recovery cannot be used to start the budget again', () => {
    let run = newRun({ steps: 3 });
    for (let n = 0; n < 2; n++) {
      const next = reserved(run, tool());
      run = settle(next.run, next.event, done()).run;
    }
    const lost = reserved(run, tool());
    assert.equal(lost.run.usage.steps, 3);

    const stored = JSON.parse(JSON.stringify(lost)) as typeof lost;
    const recovered = interrupt(stored.run, [stored.event], NOW).run;
    assert.equal(recovered.usage.steps, 3);
    assert.equal(recovered.usage.toolCalls, 3);
    assert.equal(recovered.nextEventSeq, 4);
    assert.deepEqual(reserve(recovered, tool()), { ok: false, reason: 'steps_exhausted' });
  });

  it('does nothing when no call was outstanding, and refuses a call that was not', () => {
    const run = newRun();
    assert.deepEqual(interrupt(run, [], NOW), { run, events: [] });
    const start = reserved(run, tool());
    const settled = settle(start.run, start.event, done());
    assert.throws(() => interrupt(settled.run, [settled.event], NOW), RangeError);
  });
});

describe('an allowance that is recorded', () => {
  it('is the only way past a limit, and the usage so far stays', () => {
    const run = withUsage(newRun({ steps: 3 }), { steps: 3, toolCalls: 3 });
    assert.deepEqual(reserve(run, tool()), { ok: false, reason: 'steps_exhausted' });

    const granted: RunDoc = { ...run, allowanceGrants: 1, limits: { ...run.limits, steps: run.limits.steps + 2 } };
    const next = reserved(granted, tool());
    assert.equal(next.run.usage.steps, 4, 'the count carries on from where it stopped');
    assert.equal(next.run.usage.toolCalls, 4);
    assert.equal(next.event.seq, 1);
  });
});

describe('accounting invariants over random sequences', () => {
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  it('hold however calls, outcomes, interruptions and time are interleaved', () => {
    const limits: RunLimits = { steps: 6, toolCalls: 9, modelCalls: 5, tokens: 3_000, costMicroUsd: 30_000, retriesPerCall: 2, retriesPerRun: 3, activeMs: 1_000 };
    for (let seed = 1; seed <= 150; seed++) {
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
      let run = newRun(limits, 'live');
      const outstanding: UsageEventDoc[] = [];
      let created = 0;

      for (let turn = 0; turn < 60; turn++) {
        const before = structuredClone(run);
        const action = pick(['reserve', 'reserve', 'settle', 'settle', 'interrupt', 'time'] as const);

        if (action === 'reserve') {
          const kind = pick(['tool', 'model'] as const);
          const attempt = pick([1, 1, 2, 3]);
          const request = kind === 'model' ? model({ attempt, startsTurn: attempt === 1, estimate: { tokens: 100 * (1 + Math.floor(next() * 8)), costMicroUsd: 1_000 * Math.floor(next() * 8) } }) : tool({ attempt, startsTurn: attempt === 1 && next() < 0.7 });
          const result = reserve(run, request);
          if (result.ok) {
            run = result.run;
            outstanding.push(result.event);
            created += 1;
            assert.ok(run.charged.tokens + run.reserved.tokens <= limits.tokens, `seed ${String(seed)}: tokens held within the limit at reservation`);
            assert.ok(run.charged.costMicroUsd + run.reserved.costMicroUsd <= limits.costMicroUsd, `seed ${String(seed)}: cost held within the limit at reservation`);
          } else {
            assert.deepEqual(run, before, 'a refusal changes nothing');
          }
        } else if (action === 'settle' && outstanding.length > 0) {
          const [event] = outstanding.splice(Math.floor(next() * outstanding.length), 1);
          assert.ok(event);
          const outcome = pick(['succeeded', 'failed', 'ambiguous', 'rejected_by_code'] as const);
          const usage = event.kind === 'model' && next() < 0.6 ? measured(Math.floor(next() * 300), Math.floor(next() * 300), Math.floor(next() * 9_000)) : null;
          run = settle(run, event, done({ outcome, usage })).run;
        } else if (action === 'interrupt') {
          const result = interrupt(run, outstanding, NOW);
          run = result.run;
          outstanding.length = 0;
        } else if (action === 'time') {
          run = addActive(run, Math.floor(next() * 300));
        }

        const label = `seed ${String(seed)} turn ${String(turn)}`;
        assert.equal(run.reserved.tokens, outstanding.reduce((sum, event) => sum + event.reservedTokens, 0), `${label}: reserved tokens are exactly the outstanding reservations`);
        assert.equal(run.reserved.costMicroUsd, outstanding.reduce((sum, event) => sum + event.reservedCostMicroUsd, 0), `${label}: reserved cost`);
        assert.ok(run.usage.steps <= limits.steps && run.usage.toolCalls <= limits.toolCalls && run.usage.modelCalls <= limits.modelCalls && run.usage.retries <= limits.retriesPerRun, `${label}: a hard limit was passed`);
        assert.equal(run.usage.toolCalls + run.usage.modelCalls, created, `${label}: every call is counted once`);
        assert.equal(run.nextEventSeq, created + 1, `${label}: event numbers are consecutive`);
        assert.ok(run.usage.failedCalls + run.usage.ambiguousCalls <= created, `${label}: failures are calls`);
        for (const key of ['steps', 'toolCalls', 'modelCalls', 'retries', 'failedCalls', 'ambiguousCalls', 'activeMs'] as const) {
          assert.ok(run.usage[key] >= before.usage[key], `${label}: ${key} only grows`);
        }
        assert.ok(run.charged.tokens >= before.charged.tokens && run.charged.costMicroUsd >= before.charged.costMicroUsd, `${label}: charges only grow`);
      }
    }
  });
});

describe('overshootOf', () => {
  it('is how far charges are past the limits, and never negative', () => {
    const limits = { ...BASE_RUN_LIMITS, tokens: 100, costMicroUsd: 10 };
    assert.deepEqual(overshootOf({ charged: { tokens: 120, costMicroUsd: 5 }, limits }), { tokens: 20, costMicroUsd: 0 });
    assert.deepEqual(overshootOf({ charged: { tokens: 100, costMicroUsd: 10 }, limits }), { tokens: 0, costMicroUsd: 0 });
    assert.deepEqual(overshootOf({ charged: { tokens: 0, costMicroUsd: 0 }, limits }), { tokens: 0, costMicroUsd: 0 });
  });
});
