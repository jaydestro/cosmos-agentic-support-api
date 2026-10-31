import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoInvestigator } from '../../src/agent/demo.ts';
import { createAdmissionControl } from '../../src/cases/admission.ts';
import { BASE_RUN_LIMITS, OUTBOX_LIMITS, type OutboxLimits } from '../../src/config/limits.ts';
import type { Clock } from '../../src/domain/time.ts';
import { createOutboxHandlers, type OutboxHandlerServices } from '../../src/outbox/handlers.ts';
import { createOutboxProcessor, type OutboxHandler, type OutboxHandlers, type OutboxProcessorDeps } from '../../src/outbox/processor.ts';
import type { OutboxStore } from '../../src/outbox/store.ts';
import { backoffAfter, claimed, completed, isClaimLive, msUntilDue, poisoned, released } from '../../src/outbox/transitions.ts';
import {
  DIAGNOSTICS_PARTITION,
  OUTBOX_KINDS,
  OUTBOX_STATES,
  PermanentOutboxError,
  RetryableOutboxError,
  newOutboxDoc,
  outboxId,
  parseOutboxDoc,
  type OutboxDoc,
} from '../../src/outbox/types.ts';
import { createMemoryLogger } from '../../src/telemetry/log.ts';
import { createMemoryCases } from '../support/memory-case-store.ts';
import { createMemoryProvider } from '../support/memory-provider.ts';
import { createMemoryReference } from '../support/memory-reference.ts';

const START = Date.parse('2026-01-01T00:00:00.000Z');
const CASE = `case_${'a'.repeat(32)}`;
const TENANT = 'aurora';
const NOW = new Date(START);

const item = (overrides: Partial<OutboxDoc> = {}): OutboxDoc => ({
  ...newOutboxDoc({ tenantId: TENANT, caseId: CASE, kind: 'investigation.start', key: `${CASE}-run-1`, payload: { runId: 'run-1' }, now: NOW }),
  ...overrides,
});

const rowKey = (doc: Pick<OutboxDoc, 'tenantId' | 'caseId' | 'id'>): string => `${doc.tenantId}|${doc.caseId}|${doc.id}`;

function createMemoryStore(options: { omitEtag?: boolean; failReads?: boolean } = {}) {
  const rows = new Map<string, OutboxDoc>();
  let counter = 0;
  const stamp = (doc: OutboxDoc): OutboxDoc => {
    counter += 1;
    return { ...doc, _etag: `etag-${String(counter)}` };
  };
  const view = (doc: OutboxDoc | undefined): OutboxDoc | null => {
    if (doc === undefined) return null;
    const copy = structuredClone(doc);
    if (options.omitEtag === true) delete copy._etag;
    return copy;
  };
  const store: OutboxStore = {
    read(tenantId, caseId, id) {
      if (options.failReads === true) return Promise.reject(new Error('store unavailable'));
      return Promise.resolve(view(rows.get(rowKey({ tenantId, caseId, id }))));
    },
    create(doc) {
      const key = rowKey(doc);
      if (rows.has(key)) return Promise.resolve(false);
      rows.set(key, stamp(doc));
      return Promise.resolve(true);
    },
    replace(doc, etag) {
      const key = rowKey(doc);
      const current = rows.get(key);
      if (current === undefined || current._etag !== etag) return Promise.resolve(null);
      const next = stamp(doc);
      rows.set(key, next);
      return Promise.resolve(view(next));
    },
  };
  return { store, rows };
}

type MemoryStore = ReturnType<typeof createMemoryStore>;

function setup(
  options: {
    handlers?: OutboxHandlers;
    allowDiagnostics?: boolean;
    workerId?: string;
    limits?: OutboxLimits;
    memory?: MemoryStore;
    onPoisoned?: OutboxProcessorDeps['onPoisoned'];
  } = {},
) {
  const memory = options.memory ?? createMemoryStore();
  let now = START;
  const clock: Clock = { now: () => new Date(now) };
  const { logger, lines } = createMemoryLogger();
  const sleeps: number[] = [];
  const processor = createOutboxProcessor({
    store: memory.store,
    handlers: options.handlers ?? {},
    clock,
    logger,
    workerId: options.workerId ?? 'worker-a',
    allowDiagnostics: options.allowDiagnostics ?? true,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.onPoisoned === undefined ? {} : { onPoisoned: options.onPoisoned }),
  });
  return { ...memory, processor, lines, sleeps, advance: (ms: number) => { now += ms; }, at: () => new Date(now) };
}

const stored = (env: { rows: Map<string, OutboxDoc> }, doc: OutboxDoc): OutboxDoc => {
  const row = env.rows.get(rowKey(doc));
  assert.ok(row, 'the item should still be stored');
  return row;
};

const kindHandlers = (handler: OutboxHandler): OutboxHandlers => ({ 'investigation.start': handler });

describe('outbox documents', () => {
  it('derives a deterministic id from the kind and key', () => {
    assert.equal(outboxId('investigation.start', 'k1'), 'out-investigation-start-k1');
    assert.equal(outboxId('credit.execute', 'k1'), 'out-credit-execute-k1');
    assert.equal(outboxId('diagnostic.echo', 'k1'), 'out-diagnostic-echo-k1');
  });

  it('creates a pending item that is due immediately and has used no attempts', () => {
    const doc = newOutboxDoc({ tenantId: TENANT, caseId: CASE, kind: 'credit.execute', key: 'k', payload: { proposal: 1 }, now: NOW });
    assert.deepEqual(doc, {
      id: 'out-credit-execute-k',
      tenantId: TENANT,
      caseId: CASE,
      type: 'outbox',
      schemaVersion: 1,
      workKey: `${NOW.toISOString()}~${CASE}~out-credit-execute-k`,
      kind: 'credit.execute',
      state: 'pending',
      attempts: 0,
      maxAttempts: OUTBOX_LIMITS.maxAttempts,
      notBefore: NOW.toISOString(),
      claimedUntil: null,
      claimedBy: null,
      payload: { proposal: 1 },
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      completedAt: null,
      lastError: null,
    });
  });

  it('lets every created item pass the reader that the trigger uses', () => {
    for (const kind of OUTBOX_KINDS) {
      assert.ok(parseOutboxDoc(newOutboxDoc({ tenantId: TENANT, caseId: CASE, kind, key: 'k', payload: {}, now: NOW })), kind);
    }
    assert.ok(parseOutboxDoc(newOutboxDoc({ tenantId: TENANT, caseId: DIAGNOSTICS_PARTITION, kind: 'diagnostic.echo', key: 'k', payload: {}, now: NOW })));
  });

  it('accepts a stored item with its system fields', () => {
    const doc = { ...item(), _etag: '"abc"', _rid: 'r', _ts: 1, _self: 's', _attachments: 'a/' };
    assert.ok(parseOutboxDoc(doc));
  });

  const invalid: [string, Record<string, unknown>][] = [
    ['another document type', { type: 'case' }],
    ['another schema version', { schemaVersion: 2 }],
    ['an id without the prefix', { id: 'investigation-start-k' }],
    ['an id with upper-case letters', { id: 'out-Investigation' }],
    ['an id that is too long', { id: `out-${'a'.repeat(71)}` }],
    ['a tenant that is not valid', { tenantId: 'A' }],
    ['a case id that is not valid', { caseId: 'case_xyz' }],
    ['a missing workKey', { workKey: undefined }],
    ['a workKey that is not text', { workKey: 7 }],
    ['an unknown kind', { kind: 'credit.refund' }],
    ['an unknown state', { state: 'running' }],
    ['a negative attempt count', { attempts: -1 }],
    ['a fractional attempt count', { attempts: 1.5 }],
    ['an attempt count that is not a number', { attempts: '1' }],
    ['a zero attempt budget', { maxAttempts: 0 }],
    ['an attempt budget above the cap', { maxAttempts: OUTBOX_LIMITS.maxAttempts + 1 }],
    ['an invalid notBefore', { notBefore: 'soon' }],
    ['an invalid createdAt', { createdAt: 'x' }],
    ['a missing updatedAt', { updatedAt: undefined }],
    ['an invalid claimedUntil', { claimedUntil: 'x' }],
    ['a claimedBy that is not text', { claimedBy: 7 }],
    ['an invalid completedAt', { completedAt: 'x' }],
    ['a payload that is not an object', { payload: 'x' }],
    ['a payload that is an array', { payload: [1] }],
    ['a payload with a nested object', { payload: { nested: { a: 1 } } }],
    ['a payload with an array value', { payload: { list: [1] } }],
    ['a payload with more than ten entries', { payload: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`k${String(index)}`, index])) }],
    ['a payload string over 200 characters', { payload: { text: 'x'.repeat(201) } }],
    ['a lastError that is not an object', { lastError: 'x' }],
    ['a lastError code that is not valid', { lastError: { code: 'Bad Code', at: NOW.toISOString() } }],
    ['a lastError time that is not valid', { lastError: { code: 'handler_failed', at: 'x' } }],
  ];

  for (const [name, change] of invalid) {
    it(`rejects ${name}`, () => {
      assert.equal(parseOutboxDoc({ ...item(), ...change }), null);
    });
  }

  it('rejects values that are not documents at all', () => {
    for (const value of [null, undefined, 'text', 42, true, [], [item()]]) assert.equal(parseOutboxDoc(value), null);
  });

  it('accepts a payload at exactly the limits', () => {
    const payload = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${String(index)}`, 'x'.repeat(200)]));
    assert.ok(parseOutboxDoc({ ...item(), payload }));
    assert.ok(parseOutboxDoc({ ...item(), payload: { a: null, b: true, c: 1.5, d: 'x' } }));
  });

  it('uses the permanent-failure error to carry a code', () => {
    const error = new PermanentOutboxError('bad_input', 'cannot be fixed by retrying');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'PermanentOutboxError');
    assert.equal(error.code, 'bad_input');
  });

  it('uses the retryable-failure error to carry a code', () => {
    const error = new RetryableOutboxError('run_conflict', 'try again');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'RetryableOutboxError');
    assert.equal(error.code, 'run_conflict');
    assert.equal(error instanceof PermanentOutboxError, false);
  });

  it('knows every state and kind it can store', () => {
    assert.deepEqual([...OUTBOX_STATES], ['pending', 'claimed', 'completed', 'poison']);
    assert.deepEqual([...OUTBOX_KINDS], ['investigation.start', 'credit.execute', 'diagnostic.echo']);
  });
});

describe('outbox transitions', () => {
  const later = new Date(START + 5_000);

  it('claims by consuming an attempt and taking a lease', () => {
    const doc = item();
    const result = claimed(doc, 'worker-a', later, 120_000);
    assert.equal(result.state, 'claimed');
    assert.equal(result.attempts, 1);
    assert.equal(result.claimedBy, 'worker-a');
    assert.equal(result.claimedUntil, new Date(START + 125_000).toISOString());
    assert.equal(result.updatedAt, later.toISOString());
    assert.equal(doc.state, 'pending');
    assert.equal(doc.attempts, 0);
  });

  it('counts a takeover as another attempt', () => {
    const taken = claimed(claimed(item(), 'worker-a', NOW, 1_000), 'worker-b', later, 1_000);
    assert.equal(taken.attempts, 2);
    assert.equal(taken.claimedBy, 'worker-b');
  });

  it('releases for a retry with a delay and the failure code', () => {
    const result = released(claimed(item(), 'worker-a', NOW, 1_000), later, 'handler_failed', 2_000);
    assert.equal(result.state, 'pending');
    assert.equal(result.claimedBy, null);
    assert.equal(result.claimedUntil, null);
    assert.equal(result.notBefore, new Date(START + 7_000).toISOString());
    assert.deepEqual(result.lastError, { code: 'handler_failed', at: later.toISOString() });
    assert.equal(result.attempts, 1);
  });

  it('poisons without losing the attempt count or reason', () => {
    const result = poisoned(claimed(item(), 'worker-a', NOW, 1_000), later, 'bad_input');
    assert.equal(result.state, 'poison');
    assert.equal(result.claimedBy, null);
    assert.equal(result.claimedUntil, null);
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.lastError, { code: 'bad_input', at: later.toISOString() });
  });

  it('completes and records when, keeping the last error for the record', () => {
    const failed = released(claimed(item(), 'worker-a', NOW, 1_000), NOW, 'handler_failed', 0);
    const result = completed(claimed(failed, 'worker-a', later, 1_000), later);
    assert.equal(result.state, 'completed');
    assert.equal(result.completedAt, later.toISOString());
    assert.equal(result.claimedBy, null);
    assert.equal(result.claimedUntil, null);
    assert.equal(result.lastError?.code, 'handler_failed');
  });

  it('keeps every transition result readable by the trigger reader', () => {
    const step = claimed(item(), 'worker-a', later, 1_000);
    for (const doc of [step, released(step, later, 'handler_failed', 10), poisoned(step, later, 'bad_input'), completed(step, later)]) {
      assert.ok(parseOutboxDoc(doc), doc.state);
    }
  });

  it('judges whether a claim is still live', () => {
    const live = claimed(item(), 'worker-a', NOW, 1_000);
    assert.equal(isClaimLive(live, new Date(START + 999)), true);
    assert.equal(isClaimLive(live, new Date(START + 1_000)), false);
    assert.equal(isClaimLive(live, new Date(START + 5_000)), false);
    assert.equal(isClaimLive(item(), NOW), false);
    assert.equal(isClaimLive({ ...live, claimedUntil: null }, NOW), false);
    assert.equal(isClaimLive({ ...live, state: 'pending' }, NOW), false);
  });

  it('measures how long until an item is due, never below zero', () => {
    assert.equal(msUntilDue(item({ notBefore: new Date(START + 3_000).toISOString() }), NOW), 3_000);
    assert.equal(msUntilDue(item(), NOW), 0);
    assert.equal(msUntilDue(item(), later), 0);
  });

  it('backs off along the schedule and repeats its last step', () => {
    assert.deepEqual(OUTBOX_LIMITS.backoffMs, [1000, 2000, 4000, 8000]);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map((attempts) => backoffAfter(attempts)), [1000, 2000, 4000, 8000, 8000, 8000, 8000]);
    assert.equal(backoffAfter(0), 1000);
    assert.equal(backoffAfter(-3), 1000);
    assert.equal(backoffAfter(2, [5, 6, 7]), 6);
    assert.equal(backoffAfter(1, []), 0);
  });

  it('holds a claim longer than a whole run may be active, and every wait below the in-process cap', () => {
    assert.ok(OUTBOX_LIMITS.claimLeaseMs > BASE_RUN_LIMITS.activeMs);
    assert.ok(Math.max(...OUTBOX_LIMITS.backoffMs) <= 10_000);
    assert.equal(OUTBOX_LIMITS.backoffMs.length, OUTBOX_LIMITS.maxAttempts - 1);
  });
});

describe('outbox processor', () => {
  it('claims an item, runs its handler once and records completion', async () => {
    const seen: OutboxDoc[] = [];
    const env = setup({ handlers: kindHandlers(({ item: claim }) => { seen.push(claim); return Promise.resolve(); }) });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'completed');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.state, 'claimed');
    assert.equal(seen[0]?.attempts, 1);
    assert.equal(seen[0]?.claimedBy, 'worker-a');
    assert.equal(seen[0]?.claimedUntil, new Date(START + OUTBOX_LIMITS.claimLeaseMs).toISOString());
    const done = stored(env, doc);
    assert.equal(done.state, 'completed');
    assert.equal(done.completedAt, NOW.toISOString());
    assert.equal(done.claimedBy, null);
    assert.equal(done.attempts, 1);
  });

  it('gives the handler a logger that names the item', async () => {
    const env = setup({ handlers: kindHandlers(({ logger }) => { logger.info('handled'); return Promise.resolve(); }) });
    const doc = item();
    await env.store.create(doc);
    await env.processor.process(doc);
    const record = JSON.parse(env.lines.find((line) => line.includes('"handled"')) ?? '{}') as Record<string, unknown>;
    assert.equal(record['outboxId'], doc.id);
    assert.equal(record['outboxKind'], 'investigation.start');
    assert.equal(record['tenantId'], TENANT);
  });

  it('trusts the stored item, not the delivered change', async () => {
    let calls = 0;
    const env = setup({ handlers: kindHandlers(() => { calls += 1; return Promise.resolve(); }) });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'completed');
    // A redelivery of the original pending version finds the item already completed.
    assert.equal(await env.processor.process(doc), 'skipped');
    assert.equal(calls, 1);
  });

  it('skips an item that is gone, completed or poisoned', async () => {
    let calls = 0;
    const env = setup({ handlers: kindHandlers(() => { calls += 1; return Promise.resolve(); }) });
    assert.equal(await env.processor.process(item()), 'skipped');
    for (const state of ['completed', 'poison'] as const) {
      const doc = item({ id: `out-investigation-start-${state}`, state });
      await env.store.create(doc);
      assert.equal(await env.processor.process(doc), 'skipped', state);
    }
    assert.equal(calls, 0);
  });

  it('leaves an item with a live claim to its owner', async () => {
    let calls = 0;
    const env = setup({ handlers: kindHandlers(() => { calls += 1; return Promise.resolve(); }) });
    const doc = claimed(item(), 'worker-b', NOW, 60_000);
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'busy');
    assert.equal(calls, 0);
    assert.equal(stored(env, doc).claimedBy, 'worker-b');
  });

  it('takes over an expired claim, which uses another attempt', async () => {
    const env = setup({ handlers: kindHandlers(() => Promise.resolve()) });
    const doc = claimed(item(), 'worker-b', new Date(START - 10_000), 1_000);
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'completed');
    assert.equal(stored(env, doc).attempts, 2);
  });

  it('waits in-process for a retry that is due soon, but not for one far away', async () => {
    let calls = 0;
    const env = setup({ handlers: kindHandlers(() => { calls += 1; return Promise.resolve(); }) });
    const soon = item({ id: 'out-investigation-start-soon', notBefore: new Date(START + 3_000).toISOString() });
    const far = item({ id: 'out-investigation-start-far', notBefore: new Date(START + 10_001).toISOString() });
    await env.store.create(soon);
    await env.store.create(far);
    assert.equal(await env.processor.process(far), 'busy');
    assert.deepEqual(env.sleeps, []);
    assert.equal(await env.processor.process(soon), 'completed');
    assert.deepEqual(env.sleeps, [3_000]);
    assert.equal(calls, 1);
  });

  it('schedules a retry with backoff after a failure, then completes on the next try', async () => {
    let calls = 0;
    const env = setup({
      handlers: kindHandlers(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve();
      }),
    });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'retry_scheduled');
    const waiting = stored(env, doc);
    assert.equal(waiting.state, 'pending');
    assert.equal(waiting.attempts, 1);
    assert.equal(waiting.claimedBy, null);
    assert.equal(waiting.notBefore, new Date(START + 1_000).toISOString());
    assert.deepEqual(waiting.lastError, { code: 'handler_failed', at: NOW.toISOString() });
    assert.equal(await env.processor.process(doc), 'completed');
    assert.deepEqual(env.sleeps, [1_000]);
    assert.equal(stored(env, doc).attempts, 2);
    assert.equal(calls, 2);
  });

  it('records a transient dependency failure under its own code', async () => {
    const env = setup({ handlers: kindHandlers(() => Promise.reject(Object.assign(new Error('throttled'), { code: 429 }))) });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'retry_scheduled');
    assert.equal(stored(env, doc).lastError?.code, 'dependency_unavailable');
  });

  it('never stores the error message, only a code', async () => {
    const env = setup({ handlers: kindHandlers(() => Promise.reject(new Error('customer-secret-text'))) });
    const doc = item();
    await env.store.create(doc);
    await env.processor.process(doc);
    assert.equal(JSON.stringify(stored(env, doc)).includes('customer-secret-text'), false);
  });

  it('poisons an item once its attempts are used up, and then leaves it alone', async () => {
    let calls = 0;
    const env = setup({ handlers: kindHandlers(() => { calls += 1; return Promise.reject(new Error('always')); }) });
    const doc = item({ maxAttempts: 3 });
    await env.store.create(doc);
    assert.deepEqual(
      [await env.processor.process(doc), await env.processor.process(doc), await env.processor.process(doc)],
      ['retry_scheduled', 'retry_scheduled', 'poisoned'],
    );
    const final = stored(env, doc);
    assert.equal(final.state, 'poison');
    assert.equal(final.attempts, 3);
    assert.equal(final.lastError?.code, 'handler_failed');
    assert.deepEqual(env.sleeps, [1_000, 2_000]);
    assert.equal(await env.processor.process(doc), 'skipped');
    assert.equal(calls, 3);
  });

  it('uses the whole schedule for the default attempt budget', async () => {
    const env = setup({ handlers: kindHandlers(() => Promise.reject(new Error('always'))) });
    const doc = item();
    await env.store.create(doc);
    const outcomes: string[] = [];
    for (let index = 0; index < OUTBOX_LIMITS.maxAttempts; index += 1) outcomes.push(await env.processor.process(doc));
    assert.deepEqual(outcomes, ['retry_scheduled', 'retry_scheduled', 'retry_scheduled', 'retry_scheduled', 'poisoned']);
    assert.deepEqual(env.sleeps, [1_000, 2_000, 4_000, 8_000]);
  });

  it('poisons at once for a failure that retrying cannot fix', async () => {
    const env = setup({ handlers: kindHandlers(() => Promise.reject(new PermanentOutboxError('proposal_stale', 'the proposal changed'))) });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'poisoned');
    const final = stored(env, doc);
    assert.equal(final.state, 'poison');
    assert.equal(final.attempts, 1);
    assert.equal(final.lastError?.code, 'proposal_stale');
  });

  it('retries a failure that names its own code and records that code', async () => {
    const env = setup({ handlers: kindHandlers(() => Promise.reject(new RetryableOutboxError('run_conflict', 'the aggregate changed'))) });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'retry_scheduled');
    const final = stored(env, doc);
    assert.equal(final.state, 'pending');
    assert.equal(final.attempts, 1);
    assert.equal(final.lastError?.code, 'run_conflict');
  });

  it('tells the poison hook once, with the stored item and the code, and only when the item really moved to poison', async () => {
    const heard: { state: string; code: string; attempts: number }[] = [];
    const env = setup({
      handlers: kindHandlers(() => Promise.reject(new Error('always'))),
      onPoisoned: (poison, code) => {
        heard.push({ state: poison.state, code, attempts: poison.attempts });
        return Promise.resolve();
      },
    });
    const doc = item({ maxAttempts: 2 });
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'retry_scheduled');
    assert.deepEqual(heard, []);
    assert.equal(await env.processor.process(doc), 'poisoned');
    assert.deepEqual(heard, [{ state: 'poison', code: 'handler_failed', attempts: 2 }]);
    assert.equal(await env.processor.process(doc), 'skipped');
    assert.equal(heard.length, 1);
  });

  it('tells the poison hook about a failure that retrying cannot fix', async () => {
    const codes: string[] = [];
    const env = setup({
      handlers: kindHandlers(() => Promise.reject(new PermanentOutboxError('proposal_changed', 'the proposal changed'))),
      onPoisoned: (_poison, code) => {
        codes.push(code);
        return Promise.resolve();
      },
    });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'poisoned');
    assert.deepEqual(codes, ['proposal_changed']);
  });

  it('does not let a failing poison hook change what happened to the item', async () => {
    const env = setup({
      handlers: kindHandlers(() => Promise.reject(new PermanentOutboxError('proposal_changed', 'the proposal changed'))),
      onPoisoned: () => Promise.reject(new Error('customer-secret-text')),
    });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'poisoned');
    assert.equal(stored(env, doc).state, 'poison');
    assert.ok(env.lines.some((line) => line.includes('poison notification failed')));
    assert.equal(env.lines.join('\n').includes('customer-secret-text'), false);
  });

  it('does not tell the poison hook when another worker owns the claim', async () => {
    let told = 0;
    const memory = createMemoryStore();
    const handler: OutboxHandler = async ({ item: claim }) => {
      await memory.store.replace(poisoned(claim, NOW, 'someone_else'), claim._etag ?? '');
      throw new Error('late failure');
    };
    const env = setup({
      memory,
      handlers: kindHandlers(handler),
      onPoisoned: () => {
        told += 1;
        return Promise.resolve();
      },
    });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'lost_claim');
    assert.equal(told, 0);
  });

  it('uses the stored state when a handler committed and then failed', async () => {
    const env = setup();
    const handler: OutboxHandler = async ({ item: claim }) => {
      await env.store.replace(completed(claim, NOW), claim._etag ?? '');
      throw new Error('connection dropped after the commit');
    };
    const wired = setup({ memory: env, handlers: kindHandlers(handler) });
    const doc = item();
    await wired.store.create(doc);
    assert.equal(await wired.processor.process(doc), 'completed');
    assert.equal(stored(wired, doc).state, 'completed');
    assert.equal(stored(wired, doc).lastError, null);
  });

  it('reports a lost claim instead of overwriting the new owner', async () => {
    const memory = createMemoryStore();
    const takeOver: OutboxHandler = ({ item: claim }) => {
      memory.rows.set(rowKey(claim), { ...claim, claimedBy: 'worker-b', _etag: 'etag-taken' });
      return Promise.resolve();
    };
    const env = setup({ memory, handlers: kindHandlers(takeOver) });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'lost_claim');
    assert.equal(stored(env, doc).claimedBy, 'worker-b');
    assert.equal(stored(env, doc).state, 'claimed');
  });

  it('reports a lost claim when the handler fails after another worker took over', async () => {
    const memory = createMemoryStore();
    const takeOverThenFail: OutboxHandler = ({ item: claim }) => {
      memory.rows.set(rowKey(claim), { ...claim, claimedBy: 'worker-b', _etag: 'etag-taken' });
      return Promise.reject(new Error('late failure'));
    };
    const env = setup({ memory, handlers: kindHandlers(takeOverThenFail) });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'lost_claim');
    assert.equal(stored(env, doc).lastError, null);
  });

  it('lets only one of two competing workers run the handler', async () => {
    const memory = createMemoryStore();
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((open) => {
      release = open;
    });
    const handlers = kindHandlers(async () => {
      calls += 1;
      await gate;
    });
    const first = setup({ memory, handlers, workerId: 'worker-a' });
    const second = setup({ memory, handlers, workerId: 'worker-b' });
    const doc = item();
    await memory.store.create(doc);
    const winner = first.processor.process(doc);
    const loser = second.processor.process(doc);
    assert.equal(await loser, 'busy');
    release();
    assert.equal(await winner, 'completed');
    assert.equal(calls, 1);
    assert.equal(stored(memory, doc).attempts, 1);
  });

  it('leaves an item without a handler untouched', async () => {
    const env = setup({ handlers: {} });
    const doc = item();
    await env.store.create(doc);
    assert.equal(await env.processor.process(doc), 'unhandled_kind');
    assert.deepEqual(stored(env, doc), { ...doc, _etag: 'etag-1' });
  });

  it('refuses the diagnostic kind unless diagnostics are allowed', async () => {
    let calls = 0;
    const handlers: OutboxHandlers = { 'diagnostic.echo': () => { calls += 1; return Promise.resolve(); } };
    const doc = newOutboxDoc({ tenantId: TENANT, caseId: DIAGNOSTICS_PARTITION, kind: 'diagnostic.echo', key: 'k', payload: {}, now: NOW });
    const refused = setup({ handlers, allowDiagnostics: false });
    await refused.store.create(doc);
    assert.equal(await refused.processor.process(doc), 'unhandled_kind');
    assert.equal(calls, 0);
    const allowed = setup({ handlers, allowDiagnostics: true });
    await allowed.store.create(doc);
    assert.equal(await allowed.processor.process(doc), 'completed');
    assert.equal(calls, 1);
  });

  it('refuses to claim an item that was read without an ETag', async () => {
    const env = setup({ memory: createMemoryStore({ omitEtag: true }), handlers: kindHandlers(() => Promise.resolve()) });
    const doc = item();
    await env.store.create(doc);
    await assert.rejects(env.processor.process(doc), /without an ETag/);
  });

  it('honours custom limits for the lease and the backoff', async () => {
    const limits: OutboxLimits = { maxAttempts: 5, backoffMs: [50], claimLeaseMs: 777 };
    let leaseUntil: string | null = null;
    const env = setup({
      limits,
      handlers: kindHandlers(({ item: claim }) => {
        leaseUntil = claim.claimedUntil;
        return Promise.reject(new Error('fail'));
      }),
    });
    const doc = item();
    await env.store.create(doc);
    await env.processor.process(doc);
    assert.equal(leaseUntil, new Date(START + 777).toISOString());
    assert.equal(stored(env, doc).notBefore, new Date(START + 50).toISOString());
  });
});

describe('outbox batches', () => {
  it('ignores documents that are not valid outbox items', async () => {
    let calls = 0;
    const env = setup({ handlers: kindHandlers(() => { calls += 1; return Promise.resolve(); }) });
    const changes = [
      { id: 'case-1', type: 'case', tenantId: TENANT, caseId: CASE },
      { ...item(), id: 'bad id' },
      { type: 'outbox' },
      null,
      undefined,
      'text',
      42,
      [],
    ];
    assert.deepEqual(await env.processor.processBatch(changes), []);
    assert.equal(calls, 0);
  });

  it('collapses repeated versions of one item into one run', async () => {
    let calls = 0;
    const env = setup({ handlers: kindHandlers(() => { calls += 1; return Promise.resolve(); }) });
    const doc = item();
    await env.store.create(doc);
    const outcomes = await env.processor.processBatch([doc, { ...doc, updatedAt: new Date(START + 1).toISOString() }, doc]);
    assert.deepEqual(outcomes, ['completed']);
    assert.equal(calls, 1);
  });

  it('processes distinct items and reports each outcome', async () => {
    const env = setup({ handlers: kindHandlers(({ item: claim }) => (claim.payload['fail'] === true ? Promise.reject(new Error('x')) : Promise.resolve())) });
    const good = item({ id: 'out-investigation-start-good' });
    const bad = item({ id: 'out-investigation-start-bad', payload: { fail: true } });
    await env.store.create(good);
    await env.store.create(bad);
    const outcomes = await env.processor.processBatch([good, bad]);
    assert.deepEqual([...outcomes].sort(), ['completed', 'retry_scheduled']);
  });

  it('never throws, even when the store fails, and logs only a code', async () => {
    const env = setup({ memory: createMemoryStore({ failReads: true }), handlers: kindHandlers(() => Promise.resolve()) });
    assert.deepEqual(await env.processor.processBatch([item()]), ['error']);
    const record = JSON.parse(env.lines.find((line) => line.includes('could not be processed')) ?? '{}') as Record<string, unknown>;
    assert.equal(record['level'], 'error');
    assert.equal(record['code'], 'handler_failed');
    assert.equal(JSON.stringify(record).includes('store unavailable'), false);
  });

  it('runs at most four items at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const env = setup({
      handlers: kindHandlers(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((done) => setImmediate(done));
        inFlight -= 1;
      }),
    });
    const docs = Array.from({ length: 10 }, (_, index) => item({ id: `out-investigation-start-item${String(index)}` }));
    for (const doc of docs) await env.store.create(doc);
    const outcomes = await env.processor.processBatch(docs);
    assert.equal(outcomes.length, 10);
    assert.ok(outcomes.every((outcome) => outcome === 'completed'));
    assert.ok(peak > 1 && peak <= 4, `peak concurrency was ${String(peak)}`);
  });
});

describe('outbox handlers', () => {
  const handlerServices = (): OutboxHandlerServices => {
    const memory = createMemoryCases();
    const clock = { now: () => NOW };
    return {
      cases: memory.store,
      admission: createAdmissionControl({
        store: memory.store,
        limits: { concurrentRuns: 3, casesPerUtcDay: 25, liveCostMicroUsdPerUtcDay: 2_000_000 },
        clock,
      }),
      reference: createMemoryReference([]).store,
      clock,
      investigators: { demo: createDemoInvestigator(), live: null },
      model: null,
      provider: createMemoryProvider(),
      config: { agent: { mode: 'demo', liveApproved: false }, approvalTtlMs: 60_000 },
    };
  };

  it('registers a handler for every kind that does work, and a diagnostic echo that only logs', async () => {
    const handlers = createOutboxHandlers(handlerServices());
    assert.deepEqual(Object.keys(handlers).sort(), ['credit.execute', 'diagnostic.echo', 'investigation.start']);
    const { logger, lines } = createMemoryLogger();
    await handlers['diagnostic.echo']?.({ item: item(), logger, clock: { now: () => NOW } });
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /diagnostic echo handled/);
  });

  it('routes investigation.start to the runner, which refuses a payload that names no run', async () => {
    const handlers = createOutboxHandlers(handlerServices());
    const { logger } = createMemoryLogger();
    await assert.rejects(
      async () => handlers['investigation.start']?.({ item: item(), logger, clock: { now: () => NOW } }),
      (error: unknown) => error instanceof PermanentOutboxError && error.code === 'invalid_payload',
    );
  });

  it('routes credit.execute to the executor, which refuses a payload that names no proposal', async () => {
    const handlers = createOutboxHandlers(handlerServices());
    const { logger } = createMemoryLogger();
    await assert.rejects(
      async () => handlers['credit.execute']?.({ item: item({ kind: 'credit.execute', id: 'out-credit-execute-k1' }), logger, clock: { now: () => NOW } }),
      (error: unknown) => error instanceof PermanentOutboxError && error.code === 'invalid_payload',
    );
  });
});
