import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newCreditResultDoc, type CaseDoc, type ProposalDoc, type RunDoc, type WorkState } from '../../src/cases/documents.ts';
import { CaseWriteError, MAX_BATCH_OPERATIONS, type CaseOp, type CaseStore } from '../../src/cases/store.ts';
import { workIdOf, workStateOf } from '../../src/cases/work.ts';
import { workKeyOf } from '../../src/domain/ids.ts';
import type { OutboxStore } from '../../src/outbox/store.ts';
import { newOutboxDoc, type OutboxDoc } from '../../src/outbox/types.ts';
import { AT, newCaseId, sampleCase, sampleProposal, sampleRun, sampleTimeline, sampleUsage, uniqueTenant } from './case-fixtures.ts';

export interface CaseStoreTarget {
  store: CaseStore;
  outbox: OutboxStore;
}

const create = (doc: CaseOp['doc']): CaseOp => ({ op: 'create', doc });
const replace = (doc: CaseOp['doc'], etag: string): CaseOp => ({ op: 'replace', doc, etag });

async function assertWriteError(promise: Promise<unknown>, reason: CaseWriteError['reason'], index?: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CaseWriteError, `expected a CaseWriteError, got ${String(error)}`);
    assert.equal(error.reason, reason);
    if (index !== undefined) assert.equal(error.index, index);
    return true;
  });
}

const minutes = (count: number): string => new Date(Date.parse(AT) + count * 60_000).toISOString();

/**
 * The behaviour every case store must have. It runs against the in-memory twin in the unit tests and
 * against the Cosmos DB emulator in the integration tests, which is what keeps the twin honest.
 * Each test uses its own tenant, so the shared emulator needs no cleanup between tests.
 */
export function defineCaseStoreConformance(label: string, open: () => CaseStoreTarget): void {
  describe(`case store conformance (${label})`, () => {
    it('writes a case aggregate in one batch and reads every document back with its ETag', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      const docs = [
        sampleCase(tenant, caseId),
        sampleRun(tenant, caseId),
        sampleTimeline(tenant, caseId, 1),
        sampleUsage(tenant, caseId, 'run-1', 1),
        sampleProposal(tenant, caseId, 1),
      ];
      const etags = await store.commit(tenant, caseId, docs.map(create));
      assert.equal(etags.length, docs.length);
      assert.equal(new Set(etags).size, docs.length, 'each document has its own ETag');
      for (const etag of etags) assert.ok(etag.length > 0);

      const read = await store.get('case', tenant, caseId, 'case');
      assert.deepEqual(read?.doc, docs[0]);
      assert.equal(read?.etag, etags[0]);
      assert.deepEqual((await store.get('run', tenant, caseId, 'run-1'))?.doc, docs[1]);
      assert.deepEqual((await store.get('usage', tenant, caseId, 'usage-run-1-0001'))?.doc, docs[3]);
      assert.deepEqual((await store.get('proposal', tenant, caseId, 'proposal-1'))?.doc, docs[4]);
    });

    it('answers a missing document, or a document of another kind, with null', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      await store.commit(tenant, caseId, [create(sampleCase(tenant, caseId)), create(sampleRun(tenant, caseId))]);
      assert.equal(await store.get('case', tenant, caseId, 'no-such-doc'), null);
      assert.equal(await store.get('run', tenant, caseId, 'case'), null, 'the case document is not a run');
      assert.equal(await store.get('case', tenant, newCaseId(), 'case'), null);
    });

    it('replaces only with the current ETag and issues a new one with every write', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      const original = sampleCase(tenant, caseId);
      const [first] = await store.commit(tenant, caseId, [create(original)]);
      assert.ok(first);

      const [second] = await store.commit(tenant, caseId, [replace({ ...original, status: 'investigating' }, first)]);
      assert.ok(second);
      assert.notEqual(second, first);

      await assertWriteError(store.commit(tenant, caseId, [replace({ ...original, status: 'needs_attention' }, first)]), 'stale', 0);
      assert.equal((await store.get('case', tenant, caseId, 'case'))?.doc.status, 'investigating');

      const [third] = await store.commit(tenant, caseId, [replace({ ...original, status: 'awaiting_approval' }, second)]);
      assert.ok(third);
      assert.equal((await store.get('case', tenant, caseId, 'case'))?.etag, third);
    });

    it('rejects a create of an existing id and a replace of a missing document, naming the operation', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      await store.commit(tenant, caseId, [create(sampleCase(tenant, caseId))]);
      await assertWriteError(
        store.commit(tenant, caseId, [create(sampleRun(tenant, caseId)), create(sampleCase(tenant, caseId))]),
        'exists',
        1,
      );
      await assertWriteError(store.commit(tenant, caseId, [replace(sampleRun(tenant, caseId, 2), '"unknown"')]), 'missing', 0);
    });

    it('is atomic: one failed operation leaves nothing of the batch behind', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      const base = sampleCase(tenant, caseId);
      const [etag] = await store.commit(tenant, caseId, [create(base)]);
      assert.ok(etag);

      await assertWriteError(
        store.commit(tenant, caseId, [
          create(sampleRun(tenant, caseId)),
          create(sampleTimeline(tenant, caseId, 1)),
          replace({ ...base, status: 'investigating' }, '"stale-etag"'),
        ]),
        'stale',
      );
      assert.equal(await store.get('run', tenant, caseId, 'run-1'), null);
      assert.deepEqual((await store.listTimeline(tenant, caseId, 0, 10)).items, []);
      const unchanged = await store.get('case', tenant, caseId, 'case');
      assert.equal(unchanged?.doc.status, 'queued');
      assert.equal(unchanged?.etag, etag);
    });

    it('bounds a batch and keeps every document inside its partition', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      await assert.rejects(store.commit(tenant, caseId, []), RangeError);

      const tooMany: CaseOp[] = Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, index) =>
        create(sampleTimeline(tenant, caseId, index + 1)),
      );
      await assert.rejects(store.commit(tenant, caseId, tooMany), RangeError);

      await assert.rejects(store.commit(tenant, caseId, [create(sampleCase(tenant, newCaseId()))]), RangeError);
      await assert.rejects(store.commit(tenant, caseId, [create(sampleCase(uniqueTenant(), caseId))]), RangeError);

      const largest: CaseOp[] = Array.from({ length: MAX_BATCH_OPERATIONS }, (_, index) => create(sampleTimeline(tenant, caseId, index + 1)));
      assert.equal((await store.commit(tenant, caseId, largest)).length, MAX_BATCH_OPERATIONS);
    });

    it('lets exactly one of several concurrent creates of the same document win', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => store.commit(tenant, caseId, [create(sampleCase(tenant, caseId))])),
      );
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof CaseWriteError && outcome.reason.reason === 'exists');
      }
    });

    it('lets exactly one of several concurrent replaces that share an ETag win', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      const base = sampleCase(tenant, caseId);
      const [etag] = await store.commit(tenant, caseId, [create(base)]);
      assert.ok(etag);
      const outcomes = await Promise.allSettled(
        ['investigating', 'awaiting_approval', 'rejected', 'approved', 'credited'].map((status) =>
          store.commit(tenant, caseId, [replace({ ...base, status: status as CaseDoc['status'] }, etag)]),
        ),
      );
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof CaseWriteError && outcome.reason.reason === 'stale');
      }
    });

    it('keeps tenants apart on every read', async () => {
      const { store } = open();
      const tenantA = uniqueTenant('a');
      const tenantB = uniqueTenant('b');
      const caseId = newCaseId();
      await store.commit(tenantA, caseId, [create(sampleCase(tenantA, caseId)), create(sampleTimeline(tenantA, caseId, 1))]);

      assert.equal(await store.get('case', tenantB, caseId, 'case'), null);
      assert.deepEqual((await store.listTimeline(tenantB, caseId, 0, 10)).items, []);
      assert.deepEqual((await store.listCases(tenantB, null, 10, null, new Date(AT))).items, []);
      assert.equal((await store.listCases(tenantA, null, 10, null, new Date(AT))).items.length, 1);
    });

    it('lists a tenant newest first with a keyset cursor and without the free-text description', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const ids = Array.from({ length: 5 }, () => newCaseId());
      for (const [index, caseId] of ids.entries()) {
        await store.commit(tenant, caseId, [create(sampleCase(tenant, caseId, {}, minutes(index)))]);
      }
      const now = new Date(minutes(60));

      const first = await store.listCases(tenant, null, 2, null, now);
      assert.deepEqual(first.items.map((row) => row.caseId), [ids[4], ids[3]]);
      assert.ok(first.next !== null);
      const second = await store.listCases(tenant, null, 2, first.next, now);
      assert.deepEqual(second.items.map((row) => row.caseId), [ids[2], ids[1]]);
      assert.ok(second.next !== null);
      const third = await store.listCases(tenant, null, 2, second.next, now);
      assert.deepEqual(third.items.map((row) => row.caseId), [ids[0]]);
      assert.equal(third.next, null);

      const exact = await store.listCases(tenant, null, 5, null, now);
      assert.equal(exact.items.length, 5);
      assert.equal(exact.next, null, 'a page that holds everything has no cursor');

      for (const row of first.items) {
        assert.equal(row.tenantId, tenant);
        assert.equal('description' in row, false, 'the description is never projected');
        assert.equal('invoiceIds' in row, false);
        assert.equal('nextSeq' in row, false);
      }
    });

    it('filters by the derived status, treating a lapsed approval as expired', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const now = new Date(minutes(120));
      const proposal = (approvalExpiresAt: string) => ({
        version: 1,
        kind: 'credit' as const,
        status: 'pending_approval' as const,
        amount: { amountMinor: 4900, currency: 'USD' as const },
        approvalExpiresAt,
      });
      const cases: [string, Partial<CaseDoc>][] = [
        ['investigating', { status: 'investigating' }],
        ['waiting', { status: 'awaiting_approval', latestProposal: proposal(minutes(180)) }],
        ['lapsed', { status: 'awaiting_approval', latestProposal: proposal(minutes(60)) }],
        ['expired', { status: 'expired', latestProposal: { ...proposal(minutes(30)), status: 'expired' } }],
        ['finding', { status: 'finding_reported' }],
      ];
      const byName = new Map<string, string>();
      for (const [index, [name, overrides]] of cases.entries()) {
        const caseId = newCaseId();
        byName.set(name, caseId);
        await store.commit(tenant, caseId, [create(sampleCase(tenant, caseId, overrides, minutes(index)))]);
      }
      const idsOf = async (status: CaseDoc['status'] | null): Promise<string[]> =>
        (await store.listCases(tenant, status, 10, null, now)).items.map((row) => row.caseId).sort();

      assert.deepEqual(await idsOf(null), [...byName.values()].sort());
      assert.deepEqual(await idsOf('investigating'), [byName.get('investigating')]);
      assert.deepEqual(await idsOf('awaiting_approval'), [byName.get('waiting')]);
      assert.deepEqual(await idsOf('expired'), [byName.get('lapsed'), byName.get('expired')].sort());
      assert.deepEqual(await idsOf('finding_reported'), [byName.get('finding')]);
      assert.deepEqual(await idsOf('credited'), []);
    });

    it('lists a timeline oldest first by sequence, strictly after a cursor', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      const shuffled = [5, 1, 7, 3, 2, 6, 4];
      await store.commit(tenant, caseId, [create(sampleCase(tenant, caseId)), ...shuffled.map((seq) => create(sampleTimeline(tenant, caseId, seq)))]);

      const first = await store.listTimeline(tenant, caseId, 0, 3);
      assert.deepEqual(first.items.map((item) => item.seq), [1, 2, 3]);
      assert.equal(first.next, 3);
      const second = await store.listTimeline(tenant, caseId, 3, 3);
      assert.deepEqual(second.items.map((item) => item.seq), [4, 5, 6]);
      assert.equal(second.next, 6);
      const third = await store.listTimeline(tenant, caseId, 6, 3);
      assert.deepEqual(third.items.map((item) => item.seq), [7]);
      assert.equal(third.next, null);
      assert.deepEqual((await store.listTimeline(tenant, caseId, 7, 3)).items, []);
    });

    it('lists usage per run and finds calls that were reserved but never settled', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      await store.commit(tenant, caseId, [
        create(sampleCase(tenant, caseId)),
        create(sampleUsage(tenant, caseId, 'run-1', 1)),
        create(sampleUsage(tenant, caseId, 'run-1', 2, { outcome: 'reserved', latencyMs: null })),
        create(sampleUsage(tenant, caseId, 'run-1', 3, { outcome: 'failed', errorCode: 'dependency_unavailable' })),
        create(sampleUsage(tenant, caseId, 'run-2', 1, { outcome: 'reserved', latencyMs: null })),
      ]);

      const run1 = await store.listUsage(tenant, caseId, 'run-1', 0, 10);
      assert.deepEqual(run1.items.map((event) => event.seq), [1, 2, 3]);
      assert.equal((await store.listUsage(tenant, caseId, 'run-2', 0, 10)).items.length, 1);
      const paged = await store.listUsage(tenant, caseId, 'run-1', 1, 1);
      assert.deepEqual(paged.items.map((event) => event.seq), [2]);
      assert.equal(paged.next, 2);

      const reserved = await store.listReservedUsage(tenant, caseId, 'run-1');
      assert.deepEqual(reserved.map((entry) => entry.doc.seq), [2]);
      const [entry] = reserved;
      assert.ok(entry);
      await store.commit(tenant, caseId, [replace({ ...entry.doc, outcome: 'ambiguous' }, entry.etag)]);
      assert.deepEqual(await store.listReservedUsage(tenant, caseId, 'run-1'), []);
    });

    it('lists runs by revision and proposals by version, one case at a time', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      const otherCase = newCaseId();
      await store.commit(tenant, caseId, [
        create(sampleCase(tenant, caseId)),
        create(sampleRun(tenant, caseId, 2)),
        create(sampleRun(tenant, caseId, 1)),
        create(sampleProposal(tenant, caseId, 2)),
        create(sampleProposal(tenant, caseId, 1)),
      ]);
      await store.commit(tenant, otherCase, [create(sampleCase(tenant, otherCase)), create(sampleRun(tenant, otherCase, 1))]);

      assert.deepEqual((await store.listRuns(tenant, caseId)).map((run) => run.revision), [1, 2]);
      assert.deepEqual((await store.listProposals(tenant, caseId)).map((proposal) => proposal.version), [1, 2]);
      assert.equal((await store.listRuns(tenant, otherCase)).length, 1);
      assert.deepEqual(await store.listProposals(tenant, otherCase), []);
    });

    it('carries outbox work in the same batch and lets the outbox store claim it', async () => {
      const { store, outbox } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      const item = newOutboxDoc({
        tenantId: tenant,
        caseId,
        kind: 'investigation.start',
        key: 'run-1',
        payload: { runId: 'run-1' },
        now: new Date(AT),
      });
      await store.commit(tenant, caseId, [create(sampleCase(tenant, caseId)), create(item)]);

      const stored = await outbox.read(tenant, caseId, item.id);
      assert.ok(stored);
      assert.equal(stored.state, 'pending');
      assert.ok((stored._etag ?? '').length > 0);
      assert.equal(await store.get('case', tenant, caseId, item.id), null, 'an outbox item is not a case document');

      assert.equal(await outbox.create(item), false, 'a deterministic id makes the enqueue create-only');
      const claimed = await outbox.replace({ ...stored, state: 'claimed', attempts: 1 }, stored._etag ?? '');
      assert.equal(claimed?.state, 'claimed');
      assert.equal(await outbox.replace({ ...stored, state: 'completed' }, stored._etag ?? ''), null, 'a stale ETag is refused');
    });

    it('reads an outbox item and a credit result through the case store, the result being create-only', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const caseId = newCaseId();
      const item = newOutboxDoc({ tenantId: tenant, caseId, kind: 'credit.execute', key: 'v1', payload: { proposalVersion: 1 }, now: new Date(AT) });
      const result = newCreditResultDoc({
        tenantId: tenant,
        caseId,
        proposalVersion: 1,
        amount: { amountMinor: 4900, currency: 'USD' },
        provider: { name: 'simulated-ledger', reference: 'ref-1', idempotencyKey: 'credit-1', reconciled: false },
        now: new Date(AT),
      });
      await store.commit(tenant, caseId, [create(sampleCase(tenant, caseId)), create(item), create(result)]);

      assert.deepEqual((await store.get('outbox', tenant, caseId, item.id))?.doc, item);
      assert.deepEqual((await store.get('credit_result', tenant, caseId, result.id))?.doc, result);
      assert.equal(await store.get('credit_result', tenant, caseId, item.id), null, 'an outbox item is not a credit result');
      await assertWriteError(store.commit(tenant, caseId, [create(result)]), 'exists', 0);
    });

    it('lists operator work by derived state, newest first, one tenant at a time', async () => {
      const { store } = open();
      const tenant = uniqueTenant();
      const now = new Date(minutes(600));
      const works = new Map<string, string>();
      let tick = 0;
      const put = async (name: string, build: (caseId: string, at: string) => CaseOp['doc']): Promise<void> => {
        tick += 1;
        const caseId = newCaseId();
        const doc = build(caseId, minutes(tick));
        await store.commit(tenant, caseId, [create(doc)]);
        works.set(name, workIdOf(caseId, doc.id));
      };
      const proposal = (overrides: Partial<ProposalDoc>) => (caseId: string, at: string) =>
        sampleProposal(tenant, caseId, 1, { createdAt: at, workKey: workKeyOf(at, caseId, 'proposal-1'), ...overrides });
      const run = (overrides: Partial<RunDoc>) => (caseId: string, at: string) =>
        sampleRun(tenant, caseId, 1, { createdAt: at, workKey: workKeyOf(at, caseId, 'run-1'), ...overrides });
      const outboxItem = (key: string, overrides: Partial<OutboxDoc>) => (caseId: string, at: string) => ({
        ...newOutboxDoc({ tenantId: tenant, caseId, kind: 'credit.execute', key, payload: { proposalVersion: 1 }, now: new Date(at) }),
        ...overrides,
      });

      await put('waiting', proposal({ approvalExpiresAt: minutes(700) }));
      await put('lapsed', proposal({ approvalExpiresAt: minutes(300) }));
      await put('approved', proposal({ status: 'approved' }));
      await put('finding', proposal({ kind: 'finding', status: 'reported', approvalExpiresAt: null, amount: null }));
      await put('failed', run({ state: 'failed', stopReason: 'tool_error' }));
      await put('blocked', run({ state: 'blocked', stopReason: 'live_not_approved' }));
      await put('exhausted', run({ state: 'budget_exhausted', stopReason: 'steps_exhausted' }));
      await put('finishedRun', run({ state: 'completed' }));
      await put('queuedRun', run({}));
      await put('poison', outboxItem('p', { state: 'poison', attempts: 5, lastError: { code: 'handler_failed', at: minutes(1) } }));
      await put('done', outboxItem('d', { state: 'completed', completedAt: minutes(5) }));
      await put('claimedLive', outboxItem('cl', { state: 'claimed', claimedBy: 'w', claimedUntil: minutes(601), attempts: 1 }));
      await put('claimedLapsed', outboxItem('cx', { state: 'claimed', claimedBy: 'w', claimedUntil: minutes(599), attempts: 1 }));
      await put('overdue', outboxItem('o', { notBefore: minutes(580) }));
      await put('late', outboxItem('l', { notBefore: minutes(597) }));

      const listed = async (state: WorkState): Promise<(string | undefined)[]> => {
        const page = await store.listWork(tenant, state, 50, null, now);
        for (const row of page.items) assert.equal(workStateOf(row, now), state, `${row.id} is listed under ${state}`);
        return page.items.map((row) => workIdOf(row.caseId, row.id));
      };
      assert.deepEqual(await listed('waiting'), [works.get('waiting')], 'an approval that lapsed is not waiting');
      assert.deepEqual(await listed('failed'), [works.get('blocked'), works.get('failed')]);
      assert.deepEqual(await listed('budget_exhausted'), [works.get('exhausted')]);
      assert.deepEqual(await listed('poison'), [works.get('poison')]);
      assert.deepEqual(await listed('completed'), [works.get('done')]);
      assert.deepEqual(
        await listed('recoverable'),
        [works.get('overdue'), works.get('claimedLapsed')],
        'a live claim and an item merely waiting for a retry are not recoverable',
      );

      const first = await store.listWork(tenant, 'recoverable', 1, null, now);
      assert.equal(first.items.length, 1);
      assert.ok(first.next !== null);
      const second = await store.listWork(tenant, 'recoverable', 1, first.next, now);
      assert.deepEqual(second.items.map((row) => workIdOf(row.caseId, row.id)), [works.get('claimedLapsed')]);
      assert.equal(second.next, null);
      assert.equal((await store.listWork(tenant, 'recoverable', 2, null, now)).next, null, 'a page that holds everything has no cursor');

      for (const row of (await store.listWork(tenant, 'waiting', 5, null, now)).items) {
        assert.equal('explanation' in row, false, 'free text is never projected');
        assert.equal('digest' in row, false);
      }
      for (const row of (await store.listWork(tenant, 'poison', 5, null, now)).items) assert.equal('payload' in row, false);

      const stranger = uniqueTenant('other');
      for (const state of ['waiting', 'failed', 'budget_exhausted', 'poison', 'recoverable', 'completed'] as const) {
        assert.deepEqual((await store.listWork(stranger, state, 50, null, now)).items, [], `${state} work of another tenant is never listed`);
      }
    });
  });
}
