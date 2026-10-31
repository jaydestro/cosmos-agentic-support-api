import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdmissionControl, SLOT_LEASE_MS } from '../../src/cases/admission.ts';
import { ADMISSION_DOC_ID, TENANT_PARTITION } from '../../src/cases/documents.ts';
import { CaseWriteError } from '../../src/cases/store.ts';
import { uniqueTenant } from '../support/case-fixtures.ts';
import { createTestClock } from '../support/clock.ts';
import { createMemoryCases } from '../support/memory-case-store.ts';

const MORNING = '2026-03-01T10:00:00.000Z';
const FOURTEEN_HOURS_IN_SECONDS = 14 * 60 * 60;

interface SetupLimits {
  concurrentRuns: number;
  casesPerUtcDay: number;
  liveCostMicroUsdPerUtcDay?: number;
}

function setup(limits: SetupLimits = { concurrentRuns: 3, casesPerUtcDay: 5 }, start = MORNING) {
  const memory = createMemoryCases();
  const clock = createTestClock(start);
  const sleeps: number[] = [];
  const admission = createAdmissionControl({
    store: memory.store,
    limits: { liveCostMicroUsdPerUtcDay: 1_000_000, ...limits },
    clock,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  const tenant = uniqueTenant('adm');
  const doc = () => memory.doc('admission', tenant, TENANT_PARTITION, ADMISSION_DOC_ID);
  const commits = () => memory.calls.filter((call) => call.method === 'commit').length;
  return { memory, clock, sleeps, admission, tenant, doc, commits };
}

describe('tenant admission', () => {
  it('admits runs up to the concurrency limit and then asks the caller to retry', async () => {
    const { admission, tenant, doc } = setup();
    for (const key of ['c1:run-1', 'c2:run-1', 'c3:run-1']) {
      assert.deepEqual(await admission.admit(tenant, key, 'new_case'), { ok: true });
    }
    assert.deepEqual(await admission.admit(tenant, 'c4:run-1', 'new_case'), {
      ok: false,
      reason: 'tenant_concurrency_limit',
      retryAfterSeconds: 5,
    });
    assert.equal(doc().casesToday, 3, 'a refused case is not counted against the daily allowance');
    assert.equal(doc().slots.length, 3);
  });

  it('counts a new case against the daily allowance, but not a further run of an existing case', async () => {
    const { admission, tenant, doc } = setup({ concurrentRuns: 10, casesPerUtcDay: 2 });
    assert.deepEqual(await admission.admit(tenant, 'c1:run-1', 'new_case'), { ok: true });
    assert.deepEqual(await admission.admit(tenant, 'c2:run-1', 'new_case'), { ok: true });
    assert.deepEqual(await admission.admit(tenant, 'c3:run-1', 'new_case'), {
      ok: false,
      reason: 'tenant_daily_case_limit',
      retryAfterSeconds: FOURTEEN_HOURS_IN_SECONDS,
    });
    assert.deepEqual(await admission.admit(tenant, 'c1:run-2', 'run'), { ok: true });
    assert.equal(doc().casesToday, 2);
    assert.equal(doc().slots.length, 3);
  });

  it('answers a repeated request for the same run key without taking a second slot or count', async () => {
    const { admission, tenant, doc } = setup({ concurrentRuns: 3, casesPerUtcDay: 1 });
    assert.deepEqual(await admission.admit(tenant, 'c1:run-1', 'new_case'), { ok: true });
    assert.deepEqual(await admission.admit(tenant, 'c1:run-1', 'new_case'), { ok: true });
    assert.equal(doc().casesToday, 1);
    assert.equal(doc().slots.length, 1);
    assert.equal((await admission.admit(tenant, 'c2:run-1', 'new_case')).ok, false, 'the allowance of one is still spent');
  });

  it('frees a slot by itself once its lease has lapsed, without touching the daily count', async () => {
    const { admission, clock, tenant, doc } = setup();
    for (const key of ['c1:run-1', 'c2:run-1', 'c3:run-1']) await admission.admit(tenant, key, 'new_case');
    clock.advance(SLOT_LEASE_MS - 1);
    assert.equal((await admission.admit(tenant, 'c4:run-1', 'new_case')).ok, false);
    clock.advance(1);
    assert.deepEqual(await admission.admit(tenant, 'c4:run-1', 'new_case'), { ok: true });
    assert.equal(doc().slots.length, 1, 'the three lapsed slots were pruned');
    assert.equal(doc().casesToday, 4);
  });

  it('starts a new UTC day with fresh counters and keeps slots that are still live', async () => {
    const { admission, clock, tenant, doc } = setup({ concurrentRuns: 5, casesPerUtcDay: 2 }, '2026-03-01T23:59:00.000Z');
    await admission.admit(tenant, 'c1:run-1', 'new_case');
    await admission.admit(tenant, 'c2:run-1', 'new_case');
    assert.deepEqual(await admission.admit(tenant, 'c3:run-1', 'new_case'), {
      ok: false,
      reason: 'tenant_daily_case_limit',
      retryAfterSeconds: 60,
    });
    clock.advance(61_000);
    assert.deepEqual(await admission.admit(tenant, 'c3:run-1', 'new_case'), { ok: true });
    assert.equal(doc().day, '2026-03-02');
    assert.equal(doc().casesToday, 1);
    assert.equal(doc().slots.length, 3);
  });

  it('keeps tenants apart', async () => {
    const { admission, tenant } = setup({ concurrentRuns: 1, casesPerUtcDay: 1 });
    const other = uniqueTenant('adm-other');
    assert.equal((await admission.admit(tenant, 'c1:run-1', 'new_case')).ok, true);
    assert.equal((await admission.admit(other, 'c1:run-1', 'new_case')).ok, true);
    assert.equal((await admission.admit(tenant, 'c2:run-1', 'new_case')).ok, false);
  });
});

describe('releasing a slot', () => {
  it('frees the slot and keeps the daily count unless a refund is asked for', async () => {
    const { admission, tenant, doc } = setup();
    await admission.admit(tenant, 'c1:run-1', 'new_case');
    await admission.release(tenant, 'c1:run-1');
    assert.equal(doc().slots.length, 0);
    assert.equal(doc().casesToday, 1);
  });

  it('refunds the allowance for a case that was provably not created', async () => {
    const { admission, tenant, doc } = setup();
    await admission.admit(tenant, 'c1:run-1', 'new_case');
    await admission.release(tenant, 'c1:run-1', { refundCase: true });
    assert.equal(doc().slots.length, 0);
    assert.equal(doc().casesToday, 0);
  });

  it('does not refund an allowance that was taken on an earlier UTC day', async () => {
    const { admission, clock, tenant, doc } = setup({ concurrentRuns: 5, casesPerUtcDay: 5 }, '2026-03-01T23:59:00.000Z');
    await admission.admit(tenant, 'c1:run-1', 'new_case');
    clock.advance(2 * 60_000);
    await admission.admit(tenant, 'c2:run-1', 'new_case');
    assert.equal(doc().casesToday, 1, 'only the new day is counted');
    await admission.release(tenant, 'c1:run-1', { refundCase: true });
    assert.equal(doc().casesToday, 1, 'the day-one allowance is gone and must not reduce day two');
    assert.deepEqual(
      doc().slots.map((slot) => slot.runKey),
      ['c2:run-1'],
    );
  });

  it('ignores a key that holds no slot, without writing', async () => {
    const { admission, tenant, doc, memory } = setup();
    await admission.admit(tenant, 'c1:run-1', 'new_case');
    const writes = memory.batches.length;
    await admission.release(tenant, 'unknown:run-1', { refundCase: true });
    assert.equal(memory.batches.length, writes);
    assert.equal(doc().casesToday, 1);
  });

  it('never refunds below zero, for example when the slot was only held and no case was counted', async () => {
    const { admission, tenant, doc } = setup();
    await admission.hold(tenant, 'c1:run-1');
    await admission.release(tenant, 'c1:run-1', { refundCase: true });
    assert.equal(doc().casesToday, 0);
    assert.equal(doc().slots.length, 0);
  });
});

describe('holding a slot for work that was already accepted', () => {
  it('adds a slot without a capacity check and never counts a case', async () => {
    const { admission, tenant, doc } = setup();
    for (const key of ['c1:run-1', 'c2:run-1', 'c3:run-1']) await admission.admit(tenant, key, 'new_case');
    assert.equal(await admission.hold(tenant, 'c9:run-1'), true);
    assert.equal(doc().slots.length, 4);
    assert.equal(doc().casesToday, 3);
    assert.equal((await admission.admit(tenant, 'c10:run-1', 'new_case')).ok, false, 'new work still sees the full tenant');
  });

  it('renews the lease of a slot it already holds without moving its start', async () => {
    const { admission, clock, tenant, doc } = setup();
    await admission.admit(tenant, 'c1:run-1', 'new_case');
    const before = doc().slots[0];
    clock.advance(5 * 60_000);
    assert.equal(await admission.hold(tenant, 'c1:run-1'), true);
    const after = doc().slots[0];
    assert.equal(doc().slots.length, 1);
    assert.equal(after?.since, before?.since);
    assert.equal(after?.until, new Date(Date.parse(MORNING) + 5 * 60_000 + SLOT_LEASE_MS).toISOString());
  });
});

describe('contention', () => {
  it('answers with a bounded, backed-off "busy" when every write loses the race', async () => {
    const { admission, memory, tenant, sleeps, commits } = setup();
    memory.hooks.beforeCommit = () => {
      throw new CaseWriteError('stale', 0);
    };
    assert.deepEqual(await admission.admit(tenant, 'c1:run-1', 'new_case'), {
      ok: false,
      reason: 'tenant_admission_busy',
      retryAfterSeconds: 1,
    });
    assert.equal(commits(), 6);
    assert.deepEqual(sleeps, [5, 10, 20, 40, 80], 'exponential backoff, and no pointless wait after the last attempt');
  });

  it('reports a failed hold, and lets a release give up quietly, when writes keep losing', async () => {
    const { admission, memory, tenant } = setup();
    await admission.admit(tenant, 'c1:run-1', 'new_case');
    memory.hooks.beforeCommit = () => {
      throw new CaseWriteError('stale', 0);
    };
    assert.equal(await admission.hold(tenant, 'c1:run-1'), false);
    await assert.doesNotReject(admission.release(tenant, 'c1:run-1'));
  });

  it('lets a failure that is not a lost race reach the caller', async () => {
    const { admission, memory, tenant } = setup();
    memory.hooks.beforeCommit = () => {
      throw new Error('storage is unavailable');
    };
    await assert.rejects(admission.admit(tenant, 'c1:run-1', 'new_case'), /storage is unavailable/);
  });

  it('never admits more than the limit when many requests race', async () => {
    const { admission, tenant, doc } = setup({ concurrentRuns: 3, casesPerUtcDay: 25 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => admission.admit(tenant, `c${String(index)}:run-1`, 'new_case')),
    );
    const admitted = results.filter((result) => result.ok).length;
    assert.equal(admitted, 3);
    assert.equal(doc().slots.length, 3);
    assert.equal(doc().casesToday, 3);
    for (const result of results) {
      if (!result.ok) assert.ok(['tenant_concurrency_limit', 'tenant_admission_busy'].includes(result.reason), result.reason);
    }
  });

  it('counts one case once when the same request is retried concurrently', async () => {
    const { admission, tenant, doc } = setup();
    const results = await Promise.all(Array.from({ length: 8 }, () => admission.admit(tenant, 'c1:run-1', 'new_case')));
    assert.ok(results.every((result) => result.ok));
    assert.equal(doc().slots.length, 1);
    assert.equal(doc().casesToday, 1);
  });
});

describe('the tenant daily live-cost allowance', () => {
  const small = { concurrentRuns: 3, casesPerUtcDay: 5, liveCostMicroUsdPerUtcDay: 1_000 };

  it('reserves cost up to the limit, inclusive, and refuses the next reservation until the next UTC day', async () => {
    const { admission, tenant, doc } = setup(small);
    assert.deepEqual(await admission.reserveLiveCost(tenant, 400), { ok: true, day: '2026-03-01' });
    assert.deepEqual(await admission.reserveLiveCost(tenant, 600), { ok: true, day: '2026-03-01' });
    assert.deepEqual(await admission.reserveLiveCost(tenant, 1), {
      ok: false,
      reason: 'tenant_live_cost_limit',
      retryAfterSeconds: FOURTEEN_HOURS_IN_SECONDS,
    });
    assert.equal(doc().liveCostMicroUsdToday, 1_000, 'a refused reservation adds nothing');
  });

  it('refuses a single reservation that exceeds the limit on its own and records nothing', async () => {
    const { admission, tenant, memory } = setup(small);
    const refusal = await admission.reserveLiveCost(tenant, 1_001);
    assert.equal(refusal.ok, false);
    assert.equal(memory.batches.length, 0, 'a refusal is decided from a read and writes nothing');
  });

  it('stops all live spending when the limit is lowered to zero', async () => {
    const { admission, tenant } = setup({ ...small, liveCostMicroUsdPerUtcDay: 0 });
    assert.equal((await admission.reserveLiveCost(tenant, 1)).ok, false);
  });

  it('settles a reservation down to what the call was charged, returning the rest', async () => {
    const { admission, tenant, doc } = setup(small);
    const reservation = await admission.reserveLiveCost(tenant, 600);
    assert.ok(reservation.ok);
    assert.equal(await admission.settleLiveCost(tenant, reservation.day, 600, 250), true);
    assert.equal(doc().liveCostMicroUsdToday, 250);
    assert.equal((await admission.reserveLiveCost(tenant, 750)).ok, true, 'the returned cost can be reserved again');
  });

  it('returns a whole reservation when the call never happened', async () => {
    const { admission, tenant, doc } = setup(small);
    const reservation = await admission.reserveLiveCost(tenant, 500);
    assert.ok(reservation.ok);
    assert.equal(await admission.settleLiveCost(tenant, reservation.day, 500, 0), true);
    assert.equal(doc().liveCostMicroUsdToday, 0);
  });

  it('records a charge above the reservation in full, because the limit is soft', async () => {
    const { admission, tenant, doc } = setup(small);
    const reservation = await admission.reserveLiveCost(tenant, 900);
    assert.ok(reservation.ok);
    assert.equal(await admission.settleLiveCost(tenant, reservation.day, 900, 1_200), true);
    assert.equal(doc().liveCostMicroUsdToday, 1_200);
    assert.equal((await admission.reserveLiveCost(tenant, 1)).ok, false, 'the overshoot counts against the next call');
  });

  it('does not write when the charge equals the reservation', async () => {
    const { admission, tenant, memory } = setup(small);
    const reservation = await admission.reserveLiveCost(tenant, 300);
    assert.ok(reservation.ok);
    const writes = memory.batches.length;
    assert.equal(await admission.settleLiveCost(tenant, reservation.day, 300, 300), true);
    assert.equal(memory.batches.length, writes);
  });

  it('never lets the counter fall below zero', async () => {
    const { admission, tenant, doc } = setup(small);
    const reservation = await admission.reserveLiveCost(tenant, 100);
    assert.ok(reservation.ok);
    assert.equal(await admission.settleLiveCost(tenant, reservation.day, 5_000, 0), true);
    assert.equal(doc().liveCostMicroUsdToday, 0);
  });

  it('starts every UTC day with a fresh allowance and leaves a later day alone when an earlier reservation settles', async () => {
    const { admission, clock, tenant, doc } = setup(small, '2026-03-01T23:59:00.000Z');
    const first = await admission.reserveLiveCost(tenant, 1_000);
    assert.ok(first.ok);
    assert.equal((await admission.reserveLiveCost(tenant, 1)).ok, false);
    clock.advance(2 * 60_000);
    const second = await admission.reserveLiveCost(tenant, 100);
    assert.deepEqual(second, { ok: true, day: '2026-03-02' });
    assert.equal(doc().liveCostMicroUsdToday, 100, 'the day-one spend is gone with its day');
    assert.equal(await admission.settleLiveCost(tenant, first.day, 1_000, 0), false);
    assert.equal(doc().liveCostMicroUsdToday, 100, 'a reservation of a past day cannot reduce today');
  });

  it('does not touch the slots or the case count', async () => {
    const { admission, tenant, doc } = setup(small);
    await admission.admit(tenant, 'c1:run-1', 'new_case');
    await admission.reserveLiveCost(tenant, 10);
    assert.equal(doc().casesToday, 1);
    assert.deepEqual(
      doc().slots.map((slot) => slot.runKey),
      ['c1:run-1'],
    );
  });

  it('keeps tenants apart', async () => {
    const { admission, tenant } = setup(small);
    const other = uniqueTenant('adm-other');
    assert.equal((await admission.reserveLiveCost(tenant, 1_000)).ok, true);
    assert.equal((await admission.reserveLiveCost(other, 1_000)).ok, true);
    assert.equal((await admission.reserveLiveCost(tenant, 1)).ok, false);
  });

  it('never reserves more than the limit when many reservations race', async () => {
    const { admission, tenant, doc } = setup(small);
    const results = await Promise.all(Array.from({ length: 10 }, () => admission.reserveLiveCost(tenant, 300)));
    const reserved = results.filter((result) => result.ok).length;
    assert.ok(reserved <= 3, `${String(reserved)} reservations of 300 passed a limit of 1000`);
    assert.equal(doc().liveCostMicroUsdToday, reserved * 300);
    for (const result of results) {
      if (!result.ok) assert.ok(['tenant_live_cost_limit', 'tenant_admission_busy'].includes(result.reason), result.reason);
    }
  });

  it('answers busy when every write loses the race, and reports an unsettled charge', async () => {
    const { admission, memory, tenant } = setup(small);
    const reservation = await admission.reserveLiveCost(tenant, 500);
    assert.ok(reservation.ok);
    memory.hooks.beforeCommit = () => {
      throw new CaseWriteError('stale', 0);
    };
    assert.deepEqual(await admission.reserveLiveCost(tenant, 10), { ok: false, reason: 'tenant_admission_busy', retryAfterSeconds: 1 });
    assert.equal(await admission.settleLiveCost(tenant, reservation.day, 500, 100), false);
  });

  it('rejects an amount that is not a whole, non-negative number', async () => {
    const { admission, tenant } = setup(small);
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      await assert.rejects(admission.reserveLiveCost(tenant, value), RangeError, String(value));
      await assert.rejects(admission.settleLiveCost(tenant, '2026-03-01', 10, value), RangeError, String(value));
      await assert.rejects(admission.settleLiveCost(tenant, '2026-03-01', value, 10), RangeError, String(value));
    }
  });
});
