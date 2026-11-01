import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Container } from '@azure/cosmos';
import type { Money } from '../../src/cases/documents.ts';
import {
  createCreditProvider,
  creditKeyFor,
  faultPlanId,
  PROVIDER_NAME,
  ProviderKeyConflictError,
  ProviderUnavailableError,
  type IssueRequest,
} from '../../src/credits/provider.ts';
import { SCHEMA_VERSION } from '../../src/data/documents.ts';
import { newRuTotals, runWithRuMeter } from '../../src/telemetry/ru.ts';
import { newCaseId } from '../support/case-fixtures.ts';

type Doc = Record<string, unknown>;

interface Version {
  readonly doc: Doc;
  readonly etag: string;
}

const TENANT = 'aurora';
const OTHER_TENANT = 'borealis';
const NOW = new Date('2026-10-29T12:00:00.000Z');
const LATER = new Date('2026-10-29T13:00:00.000Z');
const REFERENCE = /^sim-[0-9a-f]{16}$/;
const CHARGE = { create: 6, read: 1, replace: 7 } as const;

const usd = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

function failure(status: number): Error {
  return Object.assign(new Error(`Simulated database status ${String(status)}`), { code: status, statusCode: status });
}

/** Runs the operation when the request arrives, as a database that serializes requests would. */
function settle<T>(operation: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(operation());
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const slotOf = (tenantId: string, id: string): string => `${tenantId}|${id}`;

/** The point operations the provider uses, with the status codes, ETags and charges the SDK reports for them. */
class FakeContainer {
  readonly calls = { creates: 0, reads: 0, replaces: 0 };
  readonly readIds: string[] = [];
  readonly replaceBodies: Doc[] = [];
  readonly replaceConditions: unknown[] = [];
  /** `false` makes the database answer without a request charge, as when the charge is unknown. */
  reportsCharges = true;
  /** `true` makes a read of a missing record throw a 404 instead of answering with one. */
  missingReadThrows = false;
  beforeCreate: ((doc: Doc) => void) | undefined;
  beforeReplace: ((tenantId: string, id: string) => void) | undefined;
  readonly #records = new Map<string, Version>();
  #version = 0;

  readonly items = {
    create: (doc: Doc): Promise<unknown> =>
      settle(() => {
        this.calls.creates += 1;
        this.beforeCreate?.(doc);
        const tenantId = String(doc['tenantId']);
        const id = String(doc['id']);
        if (this.#records.has(slotOf(tenantId, id))) throw failure(409);
        return { resource: this.#write(tenantId, id, doc), requestCharge: this.#charge(CHARGE.create), statusCode: 201 };
      }),
  };

  item(id: string, tenantId: string): { read: () => Promise<unknown>; replace: (body: Doc, options?: { accessCondition?: unknown }) => Promise<unknown> } {
    return {
      read: () =>
        settle(() => {
          this.calls.reads += 1;
          this.readIds.push(id);
          const found = this.#records.get(slotOf(tenantId, id));
          if (found === undefined) {
            if (this.missingReadThrows) throw failure(404);
            return { resource: undefined, requestCharge: this.#charge(CHARGE.read), statusCode: 404 };
          }
          return { resource: this.#view(found), requestCharge: this.#charge(CHARGE.read), statusCode: 200 };
        }),
      replace: (body, options) =>
        settle(() => {
          this.calls.replaces += 1;
          this.replaceBodies.push(structuredClone(body));
          this.replaceConditions.push(options?.accessCondition);
          this.beforeReplace?.(tenantId, id);
          const found = this.#records.get(slotOf(tenantId, id));
          if (found === undefined) throw failure(404);
          const condition = options?.accessCondition as { type?: unknown; condition?: unknown } | undefined;
          if (condition?.type === 'IfMatch' && condition.condition !== found.etag) throw failure(412);
          return { resource: this.#write(tenantId, id, body), requestCharge: this.#charge(CHARGE.replace), statusCode: 200 };
        }),
    };
  }

  /** Writes a record the way a test or another host instance would, bypassing the provider. */
  put(doc: Doc): void {
    this.#write(String(doc['tenantId']), String(doc['id']), doc);
  }

  /** What the database holds, including the fields it adds and the current ETag. */
  get(tenantId: string, id: string): Doc | undefined {
    const found = this.#records.get(slotOf(tenantId, id));
    return found === undefined ? undefined : this.#view(found);
  }

  /** What was written, without the fields the database adds. */
  content(tenantId: string, id: string): Doc | undefined {
    const found = this.#records.get(slotOf(tenantId, id));
    return found === undefined ? undefined : structuredClone(found.doc);
  }

  ofType(type: string): Doc[] {
    return [...this.#records.values()].map((version) => structuredClone(version.doc)).filter((doc) => doc['type'] === type);
  }

  #charge(value: number): number | undefined {
    return this.reportsCharges ? value : undefined;
  }

  #write(tenantId: string, id: string, doc: Doc): Doc {
    this.#version += 1;
    const stored: Version = { doc: structuredClone(doc), etag: `"v${String(this.#version)}"` };
    this.#records.set(slotOf(tenantId, id), stored);
    return this.#view(stored);
  }

  #view(version: Version): Doc {
    return { ...structuredClone(version.doc), _rid: 'rid', _self: 'self', _etag: version.etag, _ts: 1 };
  }
}

function scenario(options: { faults?: boolean } = {}) {
  const fake = new FakeContainer();
  const provider = createCreditProvider(fake as unknown as Container, { faultsEnabled: options.faults === true });
  const caseId = newCaseId();
  const key = creditKeyFor(caseId, 1);
  const request = (overrides: Partial<IssueRequest> = {}): IssueRequest => ({
    tenantId: TENANT,
    caseId,
    key,
    amount: usd(4900),
    now: NOW,
    ...overrides,
  });
  return { fake, provider, caseId, key, request };
}

/** A credit record as the provider stores it, for tests that put one there by hand. */
const storedCredit = (key: string, caseId: string, overrides: Doc = {}): Doc => ({
  id: key,
  tenantId: TENANT,
  type: 'provider_credit',
  schemaVersion: SCHEMA_VERSION,
  caseId,
  amount: usd(4900),
  reference: 'sim-0123456789abcdef',
  createdAt: NOW.toISOString(),
  ...overrides,
});

/** Arms a fault plan the way a local or CI test does: by writing the document the provider looks for. */
function arm(fake: FakeContainer, caseId: string, mode: string, remaining: number, tenantId = TENANT, overrides: Doc = {}): void {
  fake.put({ id: faultPlanId(caseId), tenantId, type: 'fault_plan', mode, remaining, fired: 0, ...overrides });
}

function planOf(fake: FakeContainer, caseId: string, tenantId = TENANT): Doc {
  const plan = fake.content(tenantId, faultPlanId(caseId));
  assert.ok(plan, 'the plan exists');
  return plan;
}

/** Another host instance uses up faults of the plan between this one's read and replace. */
function competingClaimer(fake: FakeContainer, caseId: string, times: number): { taken: () => number } {
  let taken = 0;
  fake.beforeReplace = (tenantId, id) => {
    const plan = fake.content(tenantId, id);
    if (id !== faultPlanId(caseId) || taken >= times || plan === undefined) return;
    taken += 1;
    fake.put({ ...plan, remaining: Number(plan['remaining']) - 1, fired: Number(plan['fired']) + 1 });
  };
  return { taken: () => taken };
}

const rejectsWith = (promise: Promise<unknown>, type: new (message: string) => Error): Promise<void> =>
  assert.rejects(promise, (error: unknown) => error instanceof type);

const rejectsWithSame = (promise: Promise<unknown>, expected: Error): Promise<void> =>
  assert.rejects(promise, (error: unknown) => error === expected);

describe('the simulated credit provider', () => {
  describe('naming', () => {
    it('names the credit of a proposal version and the fault plan of a case in a form the database accepts as an id', () => {
      const caseId = newCaseId();
      assert.equal(creditKeyFor(caseId, 2), `credit-${caseId}-v2`);
      assert.notEqual(creditKeyFor(caseId, 1), creditKeyFor(caseId, 2));
      assert.equal(faultPlanId(caseId), `fault-${caseId}`);
      for (const id of [creditKeyFor(caseId, 3), faultPlanId(caseId)]) {
        assert.ok(id.length <= 255);
        assert.doesNotMatch(id, /[\\/?#]/);
      }
      assert.equal(PROVIDER_NAME, 'simulated-ledger');
    });
  });

  describe('recording a credit', () => {
    it('stores the credit under its key and answers with what it stored', async () => {
      const { fake, provider, caseId, key, request } = scenario();
      const outcome = await provider.issue(request());

      assert.equal(outcome.created, true);
      assert.match(outcome.credit.reference, REFERENCE);
      assert.deepEqual(outcome.credit, {
        key,
        tenantId: TENANT,
        caseId,
        amount: usd(4900),
        reference: outcome.credit.reference,
        createdAt: NOW.toISOString(),
      });
      assert.deepEqual(fake.content(TENANT, key), {
        id: key,
        tenantId: TENANT,
        type: 'provider_credit',
        schemaVersion: SCHEMA_VERSION,
        caseId,
        amount: usd(4900),
        reference: outcome.credit.reference,
        createdAt: NOW.toISOString(),
      });
      assert.deepEqual(fake.calls, { creates: 1, reads: 0, replaces: 0 });
    });

    it('derives the reference from the key alone', async () => {
      const first = scenario();
      const other = await first.provider.issue(first.request({ amount: usd(100), now: LATER }));
      const same = await first.provider.lookup(TENANT, first.key);
      assert.equal(same?.reference, other.credit.reference);

      const second = scenario();
      const again = await second.provider.issue(second.request({ key: first.key, caseId: first.caseId }));
      assert.equal(again.credit.reference, other.credit.reference, 'the same key gives the same reference anywhere');
      const different = await second.provider.issue(second.request({ key: creditKeyFor(first.caseId, 2), caseId: first.caseId }));
      assert.notEqual(different.credit.reference, again.credit.reference);
    });

    it('finds a credit it recorded, answers nothing for a key it has never seen, and changes nothing by looking', async () => {
      const { fake, provider, key, request } = scenario();
      assert.equal(await provider.lookup(TENANT, key), null);
      const { credit } = await provider.issue(request());
      const held = fake.get(TENANT, key);

      assert.deepEqual(await provider.lookup(TENANT, key), credit);
      assert.equal(await provider.lookup(TENANT, creditKeyFor(newCaseId(), 1)), null);
      assert.deepEqual(fake.get(TENANT, key), held, 'a lookup writes nothing');
      assert.equal(fake.calls.creates, 1);
      assert.equal(fake.calls.replaces, 0);
    });

    it('accepts a credit that was put there by hand in the stored form', async () => {
      const { fake, provider, caseId, key } = scenario();
      fake.put(storedCredit(key, caseId));
      assert.deepEqual(await provider.lookup(TENANT, key), {
        key,
        tenantId: TENANT,
        caseId,
        amount: usd(4900),
        reference: 'sim-0123456789abcdef',
        createdAt: NOW.toISOString(),
      });
    });

    it('keeps the tenants apart even for the same key', async () => {
      const { fake, provider, key, request } = scenario();
      const aurora = await provider.issue(request());
      const borealis = await provider.issue(request({ tenantId: OTHER_TENANT, amount: usd(100) }));

      assert.equal(aurora.created, true);
      assert.equal(borealis.created, true, 'the same key in another tenant is a different record');
      assert.equal(fake.ofType('provider_credit').length, 2);
      assert.equal((await provider.lookup(TENANT, key))?.amount.amountMinor, 4900);
      assert.equal((await provider.lookup(OTHER_TENANT, key))?.amount.amountMinor, 100);
    });
  });

  describe('the same credit again', () => {
    it('answers a repeat with the credit it already holds and creates nothing', async () => {
      const { fake, provider, key, request } = scenario();
      const first = await provider.issue(request());
      const held = fake.get(TENANT, key);

      const again = await provider.issue(request({ now: LATER }));
      assert.equal(again.created, false);
      assert.deepEqual(again.credit, first.credit, 'the original credit, including when it was recorded');
      assert.equal(fake.ofType('provider_credit').length, 1);
      assert.deepEqual(fake.get(TENANT, key), held, 'the record was not touched');
      assert.deepEqual(fake.calls, { creates: 2, reads: 1, replaces: 0 });
    });

    it('records exactly one credit when the same request arrives many times at once', async () => {
      const { fake, provider, request } = scenario();
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => provider.issue(request())));

      assert.equal(outcomes.filter((outcome) => outcome.created).length, 1, 'one call took effect');
      for (const outcome of outcomes) assert.deepEqual(outcome.credit, outcomes[0]?.credit);
      assert.equal(fake.ofType('provider_credit').length, 1);
    });

    const DIFFERENT: [string, (caseId: string) => Partial<IssueRequest>][] = [
      ['another amount', () => ({ amount: usd(4901) })],
      ['another currency', () => ({ amount: { amountMinor: 4900, currency: 'EUR' } })],
      ['another case', () => ({ caseId: newCaseId() })],
    ];

    for (const [name, change] of DIFFERENT) {
      it(`refuses ${name} under a key that already holds a credit, and leaves the credit alone`, async () => {
        const { fake, provider, caseId, key, request } = scenario();
        await provider.issue(request());
        const held = fake.get(TENANT, key);

        await rejectsWith(provider.issue(request(change(caseId))), ProviderKeyConflictError);
        assert.deepEqual(fake.get(TENANT, key), held);
        assert.equal(fake.ofType('provider_credit').length, 1);
      });
    }
  });

  describe('a key that holds something else', () => {
    const SQUATTERS: [string, (key: string, caseId: string) => Doc][] = [
      ['a fault plan', (key) => ({ id: key, tenantId: TENANT, type: 'fault_plan', mode: 'unavailable', remaining: 1, fired: 0 })],
      ['a credit of nothing', (key, caseId) => storedCredit(key, caseId, { amount: { amountMinor: 0, currency: 'USD' } })],
      ['a credit in a currency nobody defined', (key, caseId) => storedCredit(key, caseId, { amount: { amountMinor: 100, currency: 'GBP' } })],
      ['a credit for a fraction of a cent', (key, caseId) => storedCredit(key, caseId, { amount: { amountMinor: 1.5, currency: 'USD' } })],
      ['a credit for something that is not a case', (key) => storedCredit(key, 'not-a-case')],
      ['a credit with no real creation time', (key, caseId) => storedCredit(key, caseId, { createdAt: 'yesterday' })],
      ['a credit whose reference is not text', (key, caseId) => storedCredit(key, caseId, { reference: 42 })],
    ];

    for (const [name, squat] of SQUATTERS) {
      it(`reports ${name} as a conflict, both when looking it up and when issuing over it`, async () => {
        const { fake, provider, caseId, key, request } = scenario();
        fake.put(squat(key, caseId));
        const held = fake.get(TENANT, key);

        await rejectsWith(provider.lookup(TENANT, key), ProviderKeyConflictError);
        await rejectsWith(provider.issue(request()), ProviderKeyConflictError);
        assert.deepEqual(fake.get(TENANT, key), held, 'nothing was overwritten');
      });
    }

    it('reports a conflict it cannot read back as unavailable, because nothing can be reconciled', async () => {
      const { fake, provider, request } = scenario();
      fake.beforeCreate = () => {
        throw failure(409);
      };
      await rejectsWith(provider.issue(request()), ProviderUnavailableError);
      assert.equal(fake.calls.reads, 1, 'it looked for what the conflict claims is there');
    });
  });

  describe('failures of the database', () => {
    for (const status of [400, 429, 500, 503]) {
      it(`passes a ${String(status)} on instead of mistaking it for a conflict`, async () => {
        const { fake, provider, request } = scenario();
        const cause = failure(status);
        fake.beforeCreate = () => {
          throw cause;
        };
        await rejectsWithSame(provider.issue(request()), cause);
        assert.equal(fake.calls.reads, 0, 'it did not go looking for a credit');
        assert.equal(fake.ofType('provider_credit').length, 0);
      });
    }

    for (const throws of [false, true]) {
      it(`reads a missing record as nothing when the database ${throws ? 'throws a 404' : 'answers with a 404'}`, async () => {
        const { fake, provider, key } = scenario();
        fake.missingReadThrows = throws;
        assert.equal(await provider.lookup(TENANT, key), null);
      });
    }

    it('reports the request charge of every operation, and counts a charge it was not given as unknown rather than zero', async () => {
      const measured = scenario();
      const totals = newRuTotals();
      await runWithRuMeter(totals, async () => {
        await measured.provider.issue(measured.request());
        await measured.provider.lookup(TENANT, measured.key);
      });
      assert.deepEqual(totals, { measuredOperations: 2, requestUnits: CHARGE.create + CHARGE.read, unmeasuredOperations: 0 });

      const unknown = scenario();
      unknown.fake.reportsCharges = false;
      const unreported = newRuTotals();
      await runWithRuMeter(unreported, () => unknown.provider.issue(unknown.request()));
      assert.deepEqual(unreported, { measuredOperations: 0, requestUnits: 0, unmeasuredOperations: 1 });
    });
  });

  describe('faults for local and CI tests', () => {
    it('ignores an armed plan unless faults are enabled, and does not even look for one', async () => {
      const { fake, provider, caseId, request } = scenario();
      arm(fake, caseId, 'unavailable', 2);
      const armed = planOf(fake, caseId);

      assert.equal((await provider.issue(request())).created, true);
      assert.deepEqual(planOf(fake, caseId), armed);
      assert.ok(!fake.readIds.includes(faultPlanId(caseId)), 'the plan was never read');
      assert.equal(fake.calls.replaces, 0);
    });

    it('fails before recording while an "unavailable" plan has faults left, then works', async () => {
      const { fake, provider, caseId, key, request } = scenario({ faults: true });
      arm(fake, caseId, 'unavailable', 2);

      await rejectsWith(provider.issue(request()), ProviderUnavailableError);
      assert.equal(fake.ofType('provider_credit').length, 0, 'nothing was recorded');
      assert.equal(await provider.lookup(TENANT, key), null, 'a lookup is never faulted');
      assert.equal(planOf(fake, caseId)['remaining'], 1, 'and does not use up a fault');

      await rejectsWith(provider.issue(request()), ProviderUnavailableError);
      const outcome = await provider.issue(request());
      assert.equal(outcome.created, true);
      assert.equal(planOf(fake, caseId)['remaining'], 0);
      assert.equal(planOf(fake, caseId)['fired'], 2);
      assert.equal(fake.ofType('provider_credit').length, 1);
    });

    it('claims a fault with a conditional write that leaves out what the database added', async () => {
      const { fake, provider, caseId, request } = scenario({ faults: true });
      arm(fake, caseId, 'unavailable', 1);
      await rejectsWith(provider.issue(request()), ProviderUnavailableError);

      assert.equal(fake.replaceBodies.length, 1);
      assert.ok(fake.replaceBodies.every((body) => Object.keys(body).every((name) => !name.startsWith('_'))));
      assert.deepEqual(fake.replaceConditions[0], { type: 'IfMatch', condition: '"v1"' });
    });

    it('records the credit and then loses the answer for a "lose_response" plan, so that a retry finds it', async () => {
      const { fake, provider, caseId, key, request } = scenario({ faults: true });
      arm(fake, caseId, 'lose_response', 1);

      await rejectsWith(provider.issue(request()), ProviderUnavailableError);
      const recorded = await provider.lookup(TENANT, key);
      assert.equal(recorded?.amount.amountMinor, 4900, 'the credit took effect');

      const retry = await provider.issue(request({ now: LATER }));
      assert.equal(retry.created, false);
      assert.deepEqual(retry.credit, recorded);
      assert.equal(fake.ofType('provider_credit').length, 1);
      assert.equal(planOf(fake, caseId)['remaining'], 0);
      assert.equal(planOf(fake, caseId)['fired'], 1);
    });

    it('loses the answer even when the credit was already there', async () => {
      const { fake, provider, caseId, request } = scenario({ faults: true });
      const first = await provider.issue(request());
      arm(fake, caseId, 'lose_response', 1);

      await rejectsWith(provider.issue(request()), ProviderUnavailableError);
      assert.equal(fake.ofType('provider_credit').length, 1);
      const retry = await provider.issue(request());
      assert.equal(retry.created, false);
      assert.deepEqual(retry.credit, first.credit);
    });

    it('leaves the plans of other cases and of other tenants alone', async () => {
      const { fake, provider, caseId, request } = scenario({ faults: true });
      const elsewhere = newCaseId();
      arm(fake, elsewhere, 'unavailable', 1);
      arm(fake, caseId, 'unavailable', 1, OTHER_TENANT);

      assert.equal((await provider.issue(request())).created, true);
      assert.equal(planOf(fake, elsewhere)['remaining'], 1);
      assert.equal(planOf(fake, caseId, OTHER_TENANT)['remaining'], 1);
    });

    const UNUSABLE: [string, Doc][] = [
      ['one with no faults left', { remaining: 0 }],
      ['one with a mode nobody defined', { mode: 'explode' }],
      ['one with a negative count', { remaining: -1 }],
      ['one with a fractional count', { remaining: 1.5 }],
      ['one with a negative number of fired faults', { fired: -1 }],
      ['a record of another type under its id', { type: 'credit' }],
    ];

    for (const [name, overrides] of UNUSABLE) {
      it(`ignores a plan that is unusable, such as ${name}`, async () => {
        const { fake, provider, caseId, request } = scenario({ faults: true });
        arm(fake, caseId, 'unavailable', 2, TENANT, overrides);
        const armed = fake.get(TENANT, faultPlanId(caseId));

        assert.equal((await provider.issue(request())).created, true);
        assert.deepEqual(fake.get(TENANT, faultPlanId(caseId)), armed);
        assert.equal(fake.calls.replaces, 0);
      });
    }

    it('uses each fault once when another claimer takes one between its read and its replace', async () => {
      const { fake, provider, caseId, request } = scenario({ faults: true });
      arm(fake, caseId, 'unavailable', 2);
      const competitor = competingClaimer(fake, caseId, 1);

      await rejectsWith(provider.issue(request()), ProviderUnavailableError);
      assert.equal(competitor.taken(), 1, 'the other claimer really got in between');
      assert.equal(fake.calls.replaces, 2, 'the first replace lost on its ETag and the claim was tried again');
      assert.equal(planOf(fake, caseId)['remaining'], 0);
      assert.equal(planOf(fake, caseId)['fired'], 2, 'no fault was used twice and none was lost');
      assert.equal(fake.ofType('provider_credit').length, 0);
    });

    it('gives up claiming a fault after three lost races and issues normally', async () => {
      const { fake, provider, caseId, request } = scenario({ faults: true });
      arm(fake, caseId, 'unavailable', 20);
      const competitor = competingClaimer(fake, caseId, 10);

      assert.equal((await provider.issue(request())).created, true);
      assert.equal(competitor.taken(), 3);
      assert.equal(fake.calls.replaces, 3, 'the claim is bounded');
      assert.equal(planOf(fake, caseId)['fired'], 3, 'only the other claimer used faults');
      assert.equal(fake.ofType('provider_credit').length, 1);
    });

    it('does not hide a failure to claim a fault', async () => {
      const { fake, provider, caseId, request } = scenario({ faults: true });
      arm(fake, caseId, 'unavailable', 2);
      const cause = failure(503);
      fake.beforeReplace = () => {
        throw cause;
      };

      await rejectsWithSame(provider.issue(request()), cause);
      assert.equal(fake.ofType('provider_credit').length, 0, 'nothing was recorded');
      assert.equal(planOf(fake, caseId)['remaining'], 2);
    });

    it('never injects more faults than the plan holds when several issues race for them', async () => {
      const { fake, provider, caseId, request } = scenario({ faults: true });
      arm(fake, caseId, 'unavailable', 3);

      const results = await Promise.allSettled(Array.from({ length: 6 }, () => provider.issue(request())));
      const failed = results.filter((result) => result.status === 'rejected');
      assert.ok(failed.length > 0, 'the plan fired');
      assert.ok(failed.every((result) => result.status === 'rejected' && result.reason instanceof ProviderUnavailableError));

      const plan = planOf(fake, caseId);
      assert.equal(failed.length, plan['fired'], 'every fired fault failed exactly one call');
      assert.equal(Number(plan['remaining']) + Number(plan['fired']), 3, 'a fault is either left or used');
      assert.equal(fake.ofType('provider_credit').length, 1, 'whatever happened, one credit exists');
    });
  });
});
