import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoInvestigator } from '../../src/agent/demo.ts';
import { RunStopped, type Investigator } from '../../src/agent/investigator.ts';
import type { ModelMessage } from '../../src/agent/model.ts';
import { AGENT_ACTOR, TENANT_PARTITION, runKeyFor, type UsageEventDoc } from '../../src/cases/documents.ts';
import { CaseWriteError } from '../../src/cases/store.ts';
import { PermanentOutboxError, RetryableOutboxError } from '../../src/outbox/types.ts';
import {
  assertAggregateInvariants,
  assertQuiescent,
  buildRig,
  caseOf,
  clearHooks,
  crashAt,
  forbidden,
  liveCostToday,
  logged,
  proposalsOf,
  runOf,
  scripted,
  slotKeys,
  storedText,
  timelineOf,
  usageOf,
  writeOrder,
  type Rig,
  type RigOptions,
} from '../support/runner-rig.ts';
import { DEFAULT_USAGE_COST_MICRO_USD, failing, says, scriptedModel, type ScriptStep, type ScriptedModel, type ScriptedModelOptions } from '../support/scripted-model.ts';

const BEGIN = 'create:timeline,replace:run,replace:case';
const RESERVE = 'create:usage,replace:run';
const SETTLE = 'replace:usage,create:timeline,replace:run,replace:case';
const ACCEPT = 'replace:usage,create:proposal,create:timeline,replace:run,replace:case';
const FIRST_HOLD = 'tenant:create:admission';
const TENANT = 'tenant:replace:admission';
/** The demo plan's five tool calls: four that settle, and the submission that is accepted. */
const TOOL_CALLS = [RESERVE, SETTLE, RESERVE, SETTLE, RESERVE, SETTLE, RESERVE, SETTLE, RESERVE, ACCEPT];

const RESERVED_TOKENS = 1000;
const RESERVED_COST = 10_000;
const MEASURED_TOKENS = 460;

const PROMPT: ModelMessage[] = [
  { role: 'system', content: 'CANARY_SYSTEM_PROMPT' },
  { role: 'user', content: 'CANARY_USER_PROMPT' },
];
const CANARIES = ['CANARY_SYSTEM_PROMPT', 'CANARY_USER_PROMPT', 'CANARY_MODEL_TEXT'];

/** A live investigator that asks the model `times` times, then follows the demo plan to a proposal. */
const asking = (times = 1): Investigator =>
  scripted(async (session) => {
    for (let call = 0; call < times; call += 1) await session.model(PROMPT);
    await createDemoInvestigator().investigate(session);
  }, 'live');

interface LiveSetup extends Omit<RigOptions, 'model' | 'investigators' | 'mode' | 'liveApproved'> {
  investigator?: Investigator;
  modelOptions?: ScriptedModelOptions;
}

async function liveRig(steps: readonly ScriptStep[], setup: LiveSetup = {}): Promise<{ rig: Rig; model: ScriptedModel }> {
  const { investigator, modelOptions, ...rest } = setup;
  const model = scriptedModel(steps, modelOptions);
  const rig = await buildRig({ ...rest, mode: 'live', liveApproved: true, model, investigators: { demo: forbidden('demo'), live: investigator ?? asking() } });
  return { rig, model };
}

/** What a usage event says about the call, without its identity. */
function accounting(event: UsageEventDoc | undefined): Record<string, unknown> | undefined {
  if (event === undefined) return undefined;
  const { kind, name, outcome, attempt, errorCode, inputTokens, outputTokens, tokenQuality, costMicroUsd, costQuality, latencyMs } = event;
  return { kind, name, outcome, attempt, errorCode, inputTokens, outputTokens, tokenQuality, costMicroUsd, costQuality, latencyMs };
}

const MEASURED_CALL = {
  kind: 'model',
  name: 'test-deployment',
  outcome: 'succeeded',
  attempt: 1,
  errorCode: null,
  inputTokens: 400,
  outputTokens: 60,
  tokenQuality: 'measured',
  costMicroUsd: DEFAULT_USAGE_COST_MICRO_USD,
  costQuality: 'estimated',
  latencyMs: 0,
};

/** A call whose usage nobody reported: it is charged at its reservation, and its quality is unknown. */
function unmeteredFailure(outcome: 'succeeded' | 'failed' | 'ambiguous', errorCode: string | null, attempt = 1, latencyMs = 0): Record<string, unknown> {
  return {
    kind: 'model',
    name: 'test-deployment',
    outcome,
    attempt,
    errorCode,
    inputTokens: null,
    outputTokens: null,
    tokenQuality: 'unknown',
    costMicroUsd: null,
    costQuality: 'unknown',
    latencyMs,
  };
}

function assertExhausted(rig: Rig, reason: string, events: number, overshoot = { tokens: 0, costMicroUsd: 0 }): void {
  const run = runOf(rig);
  assert.equal(run.state, 'budget_exhausted');
  assert.equal(run.stopReason, reason);
  assert.notEqual(run.finishedAt, null);
  assert.equal(usageOf(rig).length, events, 'a refused call is not recorded as made');
  assert.equal(proposalsOf(rig).length, 0);
  assert.equal(caseOf(rig).status, 'needs_attention');
  const last = timelineOf(rig).at(-1);
  assert.equal(last?.kind, 'run_budget_exhausted');
  assert.equal(last?.summary, `Run stopped: the allowance is exhausted (${reason}).`);
  assert.deepEqual(last?.data, { reason, overshootTokens: overshoot.tokens, overshootCostMicroUsd: overshoot.costMicroUsd });
  assertAggregateInvariants(rig);
  assertQuiescent(rig);
}

/** With one run spending, the tenant's counter and the run's charge are the same number. */
const assertTenantMatchesRun = (rig: Rig): void => {
  assert.equal(liveCostToday(rig), runOf(rig).charged.costMicroUsd, "the tenant's counter equals what the run was charged");
};

function assertNothingLeaked(rig: Rig, extra: readonly string[] = []): void {
  const stored = storedText(rig);
  const logs = JSON.stringify(rig.logs);
  for (const text of [...CANARIES, ...extra]) {
    assert.ok(!stored.includes(text), `${text} is not stored`);
    assert.ok(!logs.includes(text), `${text} is not logged`);
  }
}

/** Makes the `index`th write to the case aggregate (counting from 0) fail once, with nothing written. */
function failCaseBatch(rig: Rig, index: number, error: CaseWriteError): void {
  let seen = 0;
  rig.memory.hooks.beforeCommit = (batch) => {
    if (batch.caseId !== rig.caseId) return;
    const current = seen;
    seen += 1;
    if (current === index) throw error;
  };
}

describe('a live run that calls the model', () => {
  describe('one call that succeeds', () => {
    it('reserves the run then the tenant, calls, settles the run, then settles the tenant, and records only accounting', async () => {
      const { rig, model } = await liveRig([says('CANARY_MODEL_TEXT')]);
      await rig.run();

      const run = runOf(rig);
      assert.equal(run.state, 'completed');
      assert.deepEqual(
        { steps: run.usage.steps, modelCalls: run.usage.modelCalls, toolCalls: run.usage.toolCalls, retries: run.usage.retries },
        { steps: 1, modelCalls: 1, toolCalls: 5, retries: 0 },
        'a live step is a model turn, and the tool calls inside it are not steps',
      );
      assert.deepEqual(run.charged, { tokens: MEASURED_TOKENS, costMicroUsd: DEFAULT_USAGE_COST_MICRO_USD });
      assert.deepEqual(run.reserved, { tokens: 0, costMicroUsd: 0 });
      assert.deepEqual([run.usage.inputTokens, run.usage.outputTokens, run.usage.tokenQuality], [400, 60, 'measured']);
      assert.deepEqual([run.usage.costMicroUsd, run.usage.costQuality], [DEFAULT_USAGE_COST_MICRO_USD, 'estimated'], 'a price computed from reported tokens is an estimate');

      const [first] = usageOf(rig);
      assert.deepEqual(accounting(first), MEASURED_CALL);
      assert.equal(first?.reservedTokens, RESERVED_TOKENS);
      assert.equal(first?.reservedCostMicroUsd, RESERVED_COST);

      const called = timelineOf(rig).filter((item) => item.kind === 'model_called');
      assert.equal(called.length, 1);
      assert.equal(called[0]?.summary, 'Called the model test-deployment.');
      assert.deepEqual(called[0]?.actor, AGENT_ACTOR);
      assert.deepEqual(called[0]?.data, {
        model: 'test-deployment',
        attempt: 1,
        outcome: 'succeeded',
        errorCode: null,
        inputTokens: 400,
        outputTokens: 60,
        costMicroUsd: DEFAULT_USAGE_COST_MICRO_USD,
        finishReason: 'stop',
        toolCalls: 0,
        pricingAsOf: '2026-01-01',
      });

      assert.equal(liveCostToday(rig), DEFAULT_USAGE_COST_MICRO_USD, 'the estimate was replaced by the measured price');
      assertTenantMatchesRun(rig);
      assert.deepEqual(writeOrder(rig), [FIRST_HOLD, BEGIN, TENANT, RESERVE, SETTLE, TENANT, ...TOOL_CALLS, TENANT]);
      assert.deepEqual(model.requests, [PROMPT], 'the messages reached the model unchanged');
      assert.equal(model.unused, 0);
      assertNothingLeaked(rig);
      assert.equal(proposalsOf(rig).length, 1);
      assertAggregateInvariants(rig);
      assertQuiescent(rig);
    });

    it('serializes model calls that the investigator starts together', async () => {
      let inFlight = 0;
      let peak = 0;
      const slow: ScriptStep = async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return says('ok');
      };
      const { rig } = await liveRig([slow, slow], {
        investigator: scripted(async (session) => {
          await Promise.all([session.model(PROMPT), session.model(PROMPT)]);
          await createDemoInvestigator().investigate(session);
        }, 'live'),
      });
      await rig.run();

      assert.equal(peak, 1, 'two calls never share the aggregate at once');
      assert.equal(runOf(rig).state, 'completed');
      assert.deepEqual(
        usageOf(rig)
          .slice(0, 2)
          .map((event) => [event.seq, event.kind, event.outcome]),
        [
          [1, 'model', 'succeeded'],
          [2, 'model', 'succeeded'],
        ],
      );
      assert.equal(runOf(rig).usage.modelCalls, 2);
      assertTenantMatchesRun(rig);
      assertAggregateInvariants(rig);
      assertQuiescent(rig);
    });

    it('charges the whole reservation, as unknown, when the answer reports no usage', async () => {
      const { rig } = await liveRig([says('ok', { usage: null })]);
      await rig.run();

      const run = runOf(rig);
      assert.equal(run.state, 'completed');
      assert.deepEqual(accounting(usageOf(rig)[0]), unmeteredFailure('succeeded', null));
      assert.deepEqual(run.charged, { tokens: RESERVED_TOKENS, costMicroUsd: RESERVED_COST });
      assert.deepEqual([run.usage.tokenQuality, run.usage.costQuality], ['unknown', 'unknown'], 'unknown is never reported as zero');
      assert.equal(liveCostToday(rig), RESERVED_COST, 'the tenant keeps the estimate it cannot replace');
      const called = timelineOf(rig).find((item) => item.kind === 'model_called');
      assert.deepEqual([called?.data?.inputTokens, called?.data?.outputTokens, called?.data?.costMicroUsd], [null, null, null]);
      assertTenantMatchesRun(rig);
      assertAggregateInvariants(rig);
    });

    it('counts the time a call takes as active time and as its latency', async () => {
      let advance: (ms: number) => void = () => undefined;
      const { rig } = await liveRig([
        () => {
          advance(5000);
          return says('ok');
        },
      ]);
      advance = (ms) => {
        rig.clock.advance(ms);
      };
      await rig.run();

      assert.equal(usageOf(rig)[0]?.latencyMs, 5000);
      assert.ok(runOf(rig).usage.activeMs >= 5000, 'the wait for the model is work the run was doing');
      assertAggregateInvariants(rig);
    });

    it('leaves the old day alone when the UTC day rolls over during the call', async () => {
      let advance: (ms: number) => void = () => undefined;
      const { rig } = await liveRig(
        [
          () => {
            advance(2000);
            return says('ok');
          },
        ],
        { when: new Date('2026-10-01T23:59:59.000Z') },
      );
      advance = (ms) => {
        rig.clock.advance(ms);
      };
      await rig.run();

      assert.equal(runOf(rig).state, 'completed');
      assert.deepEqual(
        logged(rig, 'tenant live cost left as reserved').map((record) => [record.level, record.reservedMicroUsd, record.chargedMicroUsd]),
        [['info', RESERVED_COST, DEFAULT_USAGE_COST_MICRO_USD]],
      );
      const next = await rig.admission.reserveLiveCost(rig.tenantId, 1);
      assert.deepEqual(next, { ok: true, day: '2026-10-02' }, 'the new day starts from zero');
      assert.equal(liveCostToday(rig), 1);
    });
  });

  describe('a call that fails', () => {
    const TERMINAL = [
      { code: 'model_unauthorized', outcome: 'failed', summary: 'Call to the model test-deployment failed: model_unauthorized.' },
      { code: 'model_bad_request', outcome: 'failed', summary: 'Call to the model test-deployment failed: model_bad_request.' },
      {
        code: 'model_response_invalid',
        outcome: 'ambiguous',
        summary: 'Call to the model test-deployment ended without a usable answer and may have been billed: model_response_invalid.',
      },
    ] as const;

    for (const scenario of TERMINAL) {
      it(`stops the run on ${scenario.code} and charges the whole reservation`, async () => {
        const { rig, model } = await liveRig([failing(scenario.code, scenario.outcome, false)]);
        await rig.run();

        const run = runOf(rig);
        assert.equal(run.state, 'failed');
        assert.equal(run.stopReason, scenario.code);
        assert.notEqual(run.finishedAt, null);
        assert.equal(caseOf(rig).status, 'needs_attention');
        assert.deepEqual(usageOf(rig).map(accounting), [unmeteredFailure(scenario.outcome, scenario.code)]);
        assert.deepEqual(run.charged, { tokens: RESERVED_TOKENS, costMicroUsd: RESERVED_COST });
        assert.deepEqual([run.usage.failedCalls, run.usage.ambiguousCalls], scenario.outcome === 'failed' ? [1, 0] : [0, 1]);
        assert.deepEqual([run.usage.tokenQuality, run.usage.costQuality], ['unknown', 'unknown']);
        assert.deepEqual(rig.sleeps, [], 'a failure retrying cannot fix is not retried');
        assert.equal(model.requests.length, 1);
        assert.equal(rig.reference.calls.length, 0, 'no evidence is read after the failure');
        assert.equal(proposalsOf(rig).length, 0);

        const timeline = timelineOf(rig);
        assert.deepEqual(
          timeline.map((item) => item.kind),
          ['run_started', 'model_called', 'run_failed'],
        );
        assert.equal(timeline[1]?.summary, scenario.summary);
        assert.deepEqual(timeline[1]?.data, {
          model: 'test-deployment',
          attempt: 1,
          outcome: scenario.outcome,
          errorCode: scenario.code,
          inputTokens: null,
          outputTokens: null,
          costMicroUsd: null,
          finishReason: null,
          toolCalls: null,
          pricingAsOf: '2026-01-01',
        });
        assert.deepEqual(timeline[2]?.data, { reason: scenario.code });
        assert.equal(liveCostToday(rig), RESERVED_COST, 'a call that may have been billed stays counted against the tenant');
        assertTenantMatchesRun(rig);
        assertAggregateInvariants(rig);
        assertQuiescent(rig);
      });
    }

    const PAUSES = [
      { label: 'the shortest backoff when the model gives no hint', retryAfterMs: null, expected: 250 },
      { label: 'the backoff when it is longer than the hint', retryAfterMs: 100, expected: 250 },
      { label: "the model's hint when it is longer than the backoff", retryAfterMs: 2000, expected: 2000 },
    ] as const;

    for (const pause of PAUSES) {
      it(`retries a transient failure after ${pause.label}`, async () => {
        const { rig, model } = await liveRig([failing('model_rate_limited', 'failed', true, pause.retryAfterMs), says('ok')]);
        await rig.run();

        const run = runOf(rig);
        assert.equal(run.state, 'completed');
        assert.deepEqual(rig.sleeps, [pause.expected]);
        assert.deepEqual(usageOf(rig).slice(0, 2).map(accounting), [
          unmeteredFailure('failed', 'model_rate_limited'),
          { ...MEASURED_CALL, attempt: 2, latencyMs: 0 },
        ]);
        assert.deepEqual(
          { steps: run.usage.steps, modelCalls: run.usage.modelCalls, retries: run.usage.retries, failedCalls: run.usage.failedCalls },
          { steps: 1, modelCalls: 2, retries: 1, failedCalls: 1 },
          'a retry is a second call but not a second step',
        );
        assert.deepEqual(model.requests, [PROMPT, PROMPT]);
        assert.deepEqual(run.charged, { tokens: RESERVED_TOKENS + MEASURED_TOKENS, costMicroUsd: RESERVED_COST + DEFAULT_USAGE_COST_MICRO_USD });
        assert.equal(liveCostToday(rig), RESERVED_COST + DEFAULT_USAGE_COST_MICRO_USD, 'the failed attempt stays counted; the retry is settled to its measured price');
        assertTenantMatchesRun(rig);
        const calls = timelineOf(rig).filter((item) => item.kind === 'model_called');
        assert.deepEqual(
          calls.map((item) => [item.data?.attempt, item.data?.outcome, item.data?.errorCode]),
          [
            [1, 'failed', 'model_rate_limited'],
            [2, 'succeeded', null],
          ],
        );
        assertAggregateInvariants(rig);
        assertQuiescent(rig);
      });
    }

    it('retries a call that timed out and may have been billed, counting it as ambiguous', async () => {
      const { rig } = await liveRig([failing('model_timeout', 'ambiguous', true), says('ok')]);
      await rig.run();

      const run = runOf(rig);
      assert.equal(run.state, 'completed');
      assert.deepEqual(usageOf(rig).slice(0, 2).map(accounting), [
        unmeteredFailure('ambiguous', 'model_timeout'),
        { ...MEASURED_CALL, attempt: 2, latencyMs: 0 },
      ]);
      assert.deepEqual([run.usage.ambiguousCalls, run.usage.failedCalls, run.usage.retries], [1, 0, 1]);
      assertTenantMatchesRun(rig);
      assertAggregateInvariants(rig);
    });

    it('stops with the retry allowance spent, having charged every attempt in full', async () => {
      const unavailable = (): ScriptStep => failing('model_unavailable', 'failed', true);
      const { rig, model } = await liveRig([unavailable(), unavailable(), unavailable(), unavailable()]);
      await rig.run();

      assertExhausted(rig, 'retries_per_call_exhausted', 3);
      assert.equal(model.requests.length, 3, 'the refused fourth attempt never reached the model');
      assert.deepEqual(rig.sleeps, [250, 500, 500], 'the pauses back off, and the last one is spent before the refused attempt');
      assert.deepEqual(
        usageOf(rig).map((event) => [event.attempt, event.outcome, event.errorCode]),
        [
          [1, 'failed', 'model_unavailable'],
          [2, 'failed', 'model_unavailable'],
          [3, 'failed', 'model_unavailable'],
        ],
      );
      const run = runOf(rig);
      assert.deepEqual(run.charged, { tokens: 3 * RESERVED_TOKENS, costMicroUsd: 3 * RESERVED_COST });
      assert.deepEqual([run.usage.steps, run.usage.retries, run.usage.failedCalls], [1, 2, 3]);
      assert.equal(liveCostToday(rig), 3 * RESERVED_COST);
      assertTenantMatchesRun(rig);
    });

    it('records a thrown error that is not a model failure as an unusable answer, without its text', async () => {
      const secret = 'secret-token-123';
      const { rig } = await liveRig([
        () => {
          throw new Error(`${secret} leaked`);
        },
      ]);
      await rig.run();

      const run = runOf(rig);
      assert.equal(run.state, 'failed');
      assert.equal(run.stopReason, 'model_client_error');
      assert.deepEqual(usageOf(rig).map(accounting), [unmeteredFailure('ambiguous', 'model_client_error')]);
      assert.equal(run.usage.ambiguousCalls, 1);
      assert.deepEqual(rig.sleeps, [], 'it is not retried');
      assert.deepEqual(
        logged(rig, 'model call failed').map((record) => [record.level, record.model, record.attempt, record.errorCode, record.errorName]),
        [['warn', 'test-deployment', 1, 'model_client_error', 'Error']],
      );
      assertNothingLeaked(rig, [secret]);
      assertTenantMatchesRun(rig);
      assertAggregateInvariants(rig);
      assertQuiescent(rig);
    });
  });

  describe('the run allowance', () => {
    const SPENT = [
      { label: 'the model-call limit', limits: { modelCalls: 1 }, reason: 'model_calls_exhausted', calls: 2, made: 1 },
      { label: 'the token limit, counting what calls reported', limits: { tokens: 1500 }, reason: 'tokens_exhausted', calls: 3, made: 2 },
      { label: 'the cost limit, counting what calls reported', limits: { costMicroUsd: 12_000 }, reason: 'cost_exhausted', calls: 3, made: 2 },
    ] as const;

    for (const scenario of SPENT) {
      it(`refuses the next call at ${scenario.label}, before any write or model request`, async () => {
        const steps = Array.from({ length: scenario.calls }, () => says('ok'));
        const { rig, model } = await liveRig(steps, { limits: scenario.limits, investigator: asking(scenario.calls) });
        await rig.run();

        assertExhausted(rig, scenario.reason, scenario.made);
        assert.equal(model.requests.length, scenario.made);
        assert.equal(liveCostToday(rig), scenario.made * DEFAULT_USAGE_COST_MICRO_USD, 'a refused call reserves nothing from the tenant');
        assertTenantMatchesRun(rig);
        assert.equal(rig.reference.calls.length, 0, 'the investigator never reached the evidence');
      });
    }

    it('records how far the soft limit was passed when a call used more than it was estimated to', async () => {
      const heavy = says('ok', { usage: { promptTokens: 4000, completionTokens: 100 } });
      const { rig } = await liveRig([heavy, says('ok')], { limits: { tokens: 3000 }, investigator: asking(2) });
      await rig.run();

      assertExhausted(rig, 'tokens_exhausted', 1, { tokens: 1100, costMicroUsd: 0 });
      assert.equal(runOf(rig).charged.tokens, 4100, 'what the call reported is charged even past the limit');
      assert.equal(runOf(rig).usage.tokenQuality, 'measured');
    });
  });

  describe("the tenant's daily allowance", () => {
    it('stops the run before the call that would pass it, leaving what was spent', async () => {
      const { rig, model } = await liveRig([says('ok'), says('ok')], { tenantLiveCostMicroUsdPerUtcDay: RESERVED_COST, investigator: asking(2) });
      await rig.run();

      assertExhausted(rig, 'tenant_cost_exhausted', 1);
      assert.equal(model.requests.length, 1, 'the refused call never reached the model');
      assert.equal(liveCostToday(rig), DEFAULT_USAGE_COST_MICRO_USD);
      assertTenantMatchesRun(rig);
    });

    it('stops the run before its first call when the tenant may spend nothing', async () => {
      const { rig, model } = await liveRig([says('ok')], { tenantLiveCostMicroUsdPerUtcDay: 0 });
      await rig.run();

      assertExhausted(rig, 'tenant_cost_exhausted', 0);
      assert.equal(model.requests.length, 0);
      assert.equal(liveCostToday(rig), 0);
      assert.deepEqual(
        timelineOf(rig).map((item) => item.kind),
        ['run_started', 'run_budget_exhausted'],
      );
    });

    it('leaves the work for redelivery, with nothing reserved, when the tenant document is too contended', async () => {
      const { rig, model } = await liveRig([says('ok')]);
      let tenantWrites = 0;
      rig.memory.hooks.beforeCommit = (batch) => {
        if (batch.caseId !== TENANT_PARTITION) return;
        tenantWrites += 1;
        if (tenantWrites > 1) throw new CaseWriteError('stale', 0);
      };

      await assert.rejects(rig.run(), (error: unknown) => error instanceof RetryableOutboxError && error.code === 'tenant_admission_busy');
      assert.equal(model.requests.length, 0);
      assert.equal(usageOf(rig).length, 0, 'nothing was reserved from the run either');
      assert.equal(liveCostToday(rig), 0);
      assert.deepEqual(slotKeys(rig), [runKeyFor(rig.caseId, 'run-1')], 'the run keeps its slot for the redelivery');
      assertAggregateInvariants(rig);

      clearHooks(rig);
      await rig.run();
      assert.equal(runOf(rig).state, 'completed');
      assert.equal(model.requests.length, 1);
      assertTenantMatchesRun(rig);
      assertAggregateInvariants(rig);
      assertQuiescent(rig);
    });
  });

  describe('a write that does not complete', () => {
    const CONFLICTS = [
      { reason: 'stale', expected: (error: unknown) => error instanceof RetryableOutboxError && error.code === 'run_conflict' },
      { reason: 'exists', expected: (error: unknown) => error instanceof RetryableOutboxError && error.code === 'run_conflict' },
      { reason: 'missing', expected: (error: unknown) => error instanceof PermanentOutboxError && error.code === 'aggregate_missing' },
    ] as const;

    for (const conflict of CONFLICTS) {
      it(`gives the tenant its reservation back when the run's write is refused as ${conflict.reason}`, async () => {
        const { rig, model } = await liveRig([says('ok')]);
        failCaseBatch(rig, 1, new CaseWriteError(conflict.reason, 0));

        await assert.rejects(rig.run(), conflict.expected);
        assert.equal(model.requests.length, 0, 'the model is only called once the reservation is stored');
        assert.equal(usageOf(rig).length, 0);
        assert.equal(liveCostToday(rig), 0, 'a write known not to have happened returns what it reserved');
        assertAggregateInvariants(rig);
      });
    }

    const CRASHES = [
      { label: 'the reservation is stored but the answer is lost', index: 1, phase: 'after', calledBefore: 0 },
      { label: 'the call is made but its settlement is not stored', index: 2, phase: 'before', calledBefore: 1 },
    ] as const;

    for (const crash of CRASHES) {
      it(`keeps the tenant's reservation when the process dies and ${crash.label}`, async () => {
        const { rig, model } = await liveRig([says('first'), says('second')]);
        crashAt(rig, crash.index, crash.phase);

        await assert.rejects(rig.run(), /injected crash/);
        assert.equal(model.requests.length, crash.calledBefore);
        assert.equal(liveCostToday(rig), RESERVED_COST, 'it may have been billed, so it stays counted');
        assert.equal(usageOf(rig)[0]?.outcome, 'reserved');
        assertAggregateInvariants(rig);

        clearHooks(rig);
        await rig.run();

        const run = runOf(rig);
        assert.equal(run.state, 'completed');
        assert.deepEqual(
          usageOf(rig)
            .slice(0, 2)
            .map((event) => [event.kind, event.outcome, event.errorCode]),
          [
            ['model', 'ambiguous', 'interrupted'],
            ['model', 'succeeded', null],
          ],
          'the interrupted call is settled as ambiguous, and the restart asks again',
        );
        assert.equal(run.usage.modelCalls, 2);
        assert.equal(run.usage.steps, 2);
        assert.equal(run.usage.ambiguousCalls, 1);
        assert.deepEqual(run.charged, { tokens: RESERVED_TOKENS + MEASURED_TOKENS, costMicroUsd: RESERVED_COST + DEFAULT_USAGE_COST_MICRO_USD });
        assert.equal(liveCostToday(rig), RESERVED_COST + DEFAULT_USAGE_COST_MICRO_USD, 'the interrupted call stays counted against the tenant');
        assertTenantMatchesRun(rig);
        assert.equal(timelineOf(rig).filter((item) => item.kind === 'run_restarted').length, 1);
        assertAggregateInvariants(rig);
        assertQuiescent(rig);
      });
    }
  });

  describe('a call the run cannot make', () => {
    it('is refused in a demo run, which has no model to call', async () => {
      const model = scriptedModel([says('ok')]);
      const rig = await buildRig({
        mode: 'demo',
        model,
        investigators: {
          demo: scripted(async (session) => {
            await session.model(PROMPT);
          }),
        },
      });
      await rig.run();

      const run = runOf(rig);
      assert.equal(run.state, 'failed');
      assert.equal(run.stopReason, 'live_not_configured');
      assert.equal(model.requests.length, 0);
      assert.equal(usageOf(rig).length, 0);
      assert.equal(liveCostToday(rig), 0);
      assertAggregateInvariants(rig);
      assertQuiescent(rig);
    });

    it('is refused in a live run that was given no model', async () => {
      const rig = await buildRig({ mode: 'live', liveApproved: true, model: null, investigators: { demo: forbidden('demo'), live: asking() } });
      await rig.run();

      const run = runOf(rig);
      assert.equal(run.state, 'failed');
      assert.equal(run.stopReason, 'live_not_configured');
      assert.equal(usageOf(rig).length, 0);
      assertAggregateInvariants(rig);
      assertQuiescent(rig);
    });

    it('is refused once a proposal is stored, and the proposal stands', async () => {
      const { rig, model } = await liveRig([says('never used')], {
        investigator: scripted(async (session) => {
          await createDemoInvestigator().investigate(session);
          await session.model(PROMPT);
        }, 'live'),
      });
      await rig.run();

      const run = runOf(rig);
      assert.equal(run.state, 'completed');
      assert.equal(run.stopReason, null);
      assert.equal(proposalsOf(rig).length, 1);
      assert.equal(model.requests.length, 0);
      assert.equal(model.unused, 1);
      assert.equal(usageOf(rig).length, 5, 'only the five tool calls are recorded');
      assert.equal(liveCostToday(rig), 0);
      assertAggregateInvariants(rig);
      assertQuiescent(rig);
    });
  });

  describe('a stop that the investigator raises', () => {
    it('ends the run with the code it gave', async () => {
      const { rig } = await liveRig([says('ok')], {
        investigator: scripted(async (session) => {
          await session.model(PROMPT);
          throw new RunStopped('failed', 'model_refused');
        }, 'live'),
      });
      await rig.run();

      const run = runOf(rig);
      assert.equal(run.state, 'failed');
      assert.equal(run.stopReason, 'model_refused');
      assert.equal(usageOf(rig).length, 1);
      assertTenantMatchesRun(rig);
      assertAggregateInvariants(rig);
      assertQuiescent(rig);
    });
  });
});
