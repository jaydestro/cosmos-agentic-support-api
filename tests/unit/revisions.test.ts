import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CASE_DOC_ID, runKeyFor } from '../../src/cases/documents.ts';
import { MAX_ATTEMPTS } from '../../src/cases/retry.ts';
import { CaseWriteError } from '../../src/cases/store.ts';
import { CASE_LIMITS } from '../../src/config/limits.ts';
import { creditKeyFor } from '../../src/credits/provider.ts';
import { newCaseId } from '../support/case-fixtures.ts';
import {
  actors,
  approve,
  APPROVER_ID,
  awaitingApproval,
  caseOf,
  creditedCase,
  DUPLICATE,
  expectProblem,
  kindsOf,
  MISSING_EVIDENCE,
  ok,
  openCase,
  proposalOf,
  reject,
  REPRESENTATIVE_ID,
  revise,
  tamper,
  TENANT,
  timelineOf,
  type Actors,
  type CreditView,
  type DecisionAcceptedView,
  type DecisionView,
  type OpenOptions,
  type Pending,
  type RunView,
} from '../support/decision-flow.ts';
import { BASE_CONFIG } from '../support/handler-harness.ts';
import type { BatchRecord } from '../support/memory-case-store.ts';

const REASON = 'Please look at the second invoice again.';
// Plain letters and digits only, so JSON escaping can never hide the text from a log search.
const MARKER = 'zq4471';

const transient = (code = 429): Error => Object.assign(new Error('throttled'), { code });
const snapshot = (who: Actors, caseId: string) => structuredClone(who.world.memory.docs(TENANT, caseId));
const batchCount = (who: Actors): number => who.world.memory.batches.length;
const batchesFor = (who: Actors, caseId: string): BatchRecord[] => who.world.memory.batches.filter((batch) => batch.caseId === caseId);
const commitCalls = (who: Actors, caseId: string): number =>
  who.world.memory.calls.filter((call) => call.method === 'commit' && call.caseId === caseId).length;
const opsOf = (batch: BatchRecord | undefined): string[] => (batch?.ops ?? []).map((op) => `${op.op}:${op.type}`);
const outboxOf = (who: Actors, kind: string) => who.world.memory.outboxDocs().filter((doc) => doc.kind === kind);
const startsOf = (who: Actors, caseId: string) => outboxOf(who, 'investigation.start').filter((doc) => doc.caseId === caseId);
const slotsOf = (who: Actors): string[] => who.world.memory.doc('admission', TENANT, '_tenant', 'tenant').slots.map((slot) => slot.runKey);
const limited = (): Actors => actors({ config: { tenantLimits: { ...BASE_CONFIG.tenantLimits, concurrentRuns: 1 } } });

function expiryOf(pending: Pending): number {
  assert.ok(pending.proposal.approvalExpiresAt, 'a credit proposal expires');
  return Date.parse(pending.proposal.approvalExpiresAt);
}

async function rejectedCase(who: Actors, options: OpenOptions = {}): Promise<Pending> {
  const pending = await awaitingApproval(who, options);
  ok<DecisionView>(await reject(who.approver, pending), 200);
  return pending;
}

async function runsOf(who: Actors, caseId: string): Promise<RunView[]> {
  return ok<{ items: RunView[] }>(await who.representative.call('listInvestigationRuns', { params: { caseId } })).items;
}

async function creditOf(who: Actors, caseId: string) {
  return await who.representative.call('getCreditResult', { params: { caseId } });
}

describe('requesting a revision', () => {
  it('queues the next run for a rejected proposal and says where to poll', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    const reply = await revise(who.representative, caseId, REASON);
    const run = ok<RunView>(reply, 202);
    assert.equal(run.runId, 'run-2');
    assert.equal(run.caseId, caseId);
    assert.equal(run.revision, 2);
    assert.equal(run.state, 'queued');
    assert.equal(run.mode, 'demo');
    assert.equal(run.allowanceGrants, 0);
    assert.equal(run.limits['steps'], BASE_CONFIG.runLimits.steps, 'every run starts from the configured limits');
    assert.equal(run.usage.steps + run.usage.toolCalls + run.usage.modelCalls, 0);
    assert.equal(reply.headers['Location'], `/api/cases/${caseId}/runs/run-2`);
    assert.equal(reply.headers['Retry-After'], '2');

    const detail = await caseOf(who.representative, caseId);
    assert.equal(detail.status, 'queued');
    assert.equal(detail.revision, 2);
    assert.equal(detail.latestRun?.runId, 'run-2');
  });

  it('records who asked and why, in the batch that queues the investigation', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    const before = batchesFor(who, caseId).length;
    ok<RunView>(await revise(who.representative, caseId, REASON), 202);

    const written = batchesFor(who, caseId).slice(before);
    assert.equal(written.length, 1, 'one atomic batch');
    assert.deepEqual(opsOf(written[0]), ['replace:case', 'create:timeline', 'create:timeline', 'create:run', 'create:outbox']);

    const items = await timelineOf(who.representative, caseId);
    assert.deepEqual(kindsOf(items).slice(-3), ['decision_rejected', 'revision_requested', 'run_queued']);
    const requested = items.at(-2);
    assert.deepEqual(requested?.actor, { type: 'user', id: REPRESENTATIVE_ID });
    assert.equal(requested?.summary, 'Revision 2 requested.');
    assert.deepEqual(requested?.data, { fromVersion: 1, toRevision: 2, reason: REASON });
    const queued = items.at(-1);
    assert.equal(queued?.actor.type, 'system');
    assert.deepEqual(queued?.data, { runId: 'run-2', mode: 'demo' });
    assert.deepEqual(
      items.map((item) => item.seq),
      items.map((_, index) => index + 1),
      'the timeline has no gaps',
    );

    const starts = startsOf(who, caseId);
    assert.deepEqual(starts.map((doc) => doc.id).sort(), ['out-investigation-start-run-1', 'out-investigation-start-run-2']);
    const second = starts.find((doc) => doc.id === 'out-investigation-start-run-2');
    assert.equal(second?.state, 'pending');
    assert.deepEqual(second?.payload, { runId: 'run-2', revision: 2 });
  });

  it('leaves the rejected proposal, its decision and the first run as they were', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    const earlier = { proposal: await proposalOf(who.representative, caseId, 1), runs: await runsOf(who, caseId) };
    assert.equal(earlier.proposal.status, 'rejected');
    assert.equal(earlier.proposal.decision?.outcome, 'rejected');

    ok<RunView>(await revise(who.representative, caseId), 202);
    await who.representative.drain();

    assert.deepEqual(await proposalOf(who.representative, caseId, 1), earlier.proposal);
    const runs = await runsOf(who, caseId);
    assert.deepEqual(runs.map((run) => run.runId), ['run-1', 'run-2']);
    assert.deepEqual(runs[0], earlier.runs[0], 'the usage of the first run is not touched');
    assert.equal(runs[1]?.state, 'completed');
    assert.ok((runs[1]?.usage.steps ?? 0) > 0, 'the new run counts its own usage');
  });

  it('needs a fresh approval, because the revised proposal is a new version with its own digest', async () => {
    const who = actors();
    const first = await rejectedCase(who);
    const { caseId } = first;
    ok<RunView>(await revise(who.representative, caseId), 202);
    await who.representative.drain();

    const detail = await caseOf(who.representative, caseId);
    assert.equal(detail.status, 'awaiting_approval');
    assert.equal(detail.revision, 2);
    const second: Pending = { caseId, proposal: await proposalOf(who.representative, caseId, 2) };
    assert.equal(second.proposal.status, 'pending_approval');
    assert.equal(second.proposal.version, 2);
    assert.equal(second.proposal.runId, 'run-2');
    assert.equal(second.proposal.decision, null);
    assert.notEqual(second.proposal.digest, first.proposal.digest);

    expectProblem(await approve(who.approver, first), 409, 'proposal_already_decided');
    expectProblem(await approve(who.approver, second, { proposalDigest: first.proposal.digest }), 409, 'proposal_digest_mismatch');
    assert.equal(outboxOf(who, 'credit.execute').length, 0, 'nothing is queued for execution before the new proposal is approved');

    ok<DecisionAcceptedView>(await approve(who.approver, second), 202);
    assert.deepEqual(outboxOf(who, 'credit.execute').map((doc) => doc.id), ['out-credit-execute-v2']);
  });

  it('issues the credit for the approved revision under its own key, and none for the rejected proposal', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    ok<RunView>(await revise(who.representative, caseId), 202);
    await who.representative.drain();
    expectProblem(await creditOf(who, caseId), 404, 'not_found');
    assert.equal(who.world.provider.credits().length, 0);

    const second: Pending = { caseId, proposal: await proposalOf(who.representative, caseId, 2) };
    ok(await approve(who.approver, second), 202);
    await who.approver.drain();

    const credit = ok<CreditView>(await creditOf(who, caseId));
    assert.equal(credit.proposalVersion, 2);
    assert.equal(credit.provider.idempotencyKey, creditKeyFor(caseId, 2));
    assert.deepEqual(who.world.provider.credits().map((held) => held.key), [creditKeyFor(caseId, 2)]);
    assert.equal((await caseOf(who.representative, caseId)).status, 'credited');
  });

  it('stores the reasons as untrusted text and never logs them', async () => {
    const who = actors();
    const pending = await awaitingApproval(who);
    ok(await reject(who.approver, pending, `The seats differ ${MARKER}a.`));
    ok<RunView>(await revise(who.representative, pending.caseId, `Please recheck ${MARKER}b.`), 202);
    await who.representative.drain();

    const items = await timelineOf(who.representative, pending.caseId);
    assert.equal(items.find((item) => item.kind === 'revision_requested')?.data?.['reason'], `Please recheck ${MARKER}b.`);
    assert.equal(items.find((item) => item.kind === 'decision_rejected')?.data?.['reason'], `The seats differ ${MARKER}a.`);
    assert.equal(who.lines().filter((line) => line.includes(MARKER)).length, 0);
  });

  it('is not idempotent: a repeat after the first was accepted is refused and starts nothing', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    ok<RunView>(await revise(who.representative, caseId, REASON), 202);
    const settled = snapshot(who, caseId);
    const written = batchCount(who);
    expectProblem(await revise(who.representative, caseId, REASON), 409, 'revision_not_allowed');
    assert.equal(batchCount(who), written);
    assert.deepEqual(snapshot(who, caseId), settled);
    assert.equal((await runsOf(who, caseId)).length, 2);
  });

  it('allows three revisions and then reports the limit', async () => {
    const who = actors();
    let pending = await rejectedCase(who);
    const { caseId } = pending;
    for (let revision = 2; revision <= CASE_LIMITS.maxRuns; revision += 1) {
      ok<RunView>(await revise(who.representative, caseId), 202);
      await who.representative.drain();
      pending = { caseId, proposal: await proposalOf(who.representative, caseId, revision) };
      assert.equal(pending.proposal.status, 'pending_approval');
      ok(await reject(who.approver, pending));
    }

    const settled = snapshot(who, caseId);
    const written = batchCount(who);
    expectProblem(await revise(who.representative, caseId), 409, 'revision_limit_reached');
    assert.equal(batchCount(who), written);
    assert.deepEqual(snapshot(who, caseId), settled);
    assert.deepEqual((await runsOf(who, caseId)).map((run) => run.runId), ['run-1', 'run-2', 'run-3', 'run-4']);
    assert.equal((await caseOf(who.representative, caseId)).status, 'rejected');
  });
});

describe('a case that cannot be revised', () => {
  const NOT_REVISABLE: [string, (who: Actors) => Promise<string>][] = [
    ['queued', (who) => openCase(who)],
    ['awaiting_approval', async (who) => (await awaitingApproval(who)).caseId],
    [
      'approved',
      async (who) => {
        const pending = await awaitingApproval(who);
        ok(await approve(who.approver, pending), 202);
        return pending.caseId;
      },
    ],
    ['credited', async (who) => (await creditedCase(who)).caseId],
    [
      'investigating',
      async (who) => {
        const caseId = await openCase(who);
        await tamper(who, caseId, 'case', CASE_DOC_ID, (doc) => {
          doc.status = 'investigating';
        });
        return caseId;
      },
    ],
    [
      'needs_attention',
      async (who) => {
        const caseId = await openCase(who);
        await tamper(who, caseId, 'case', CASE_DOC_ID, (doc) => {
          doc.status = 'needs_attention';
        });
        return caseId;
      },
    ],
  ];

  for (const [status, setup] of NOT_REVISABLE) {
    it(`is refused while the case is ${status}, and nothing is written`, async () => {
      const who = actors();
      const caseId = await setup(who);
      assert.equal((await caseOf(who.representative, caseId)).status, status);
      const settled = snapshot(who, caseId);
      const written = batchCount(who);
      const starts = startsOf(who, caseId).length;
      expectProblem(await revise(who.representative, caseId), 409, 'revision_not_allowed');
      assert.equal(batchCount(who), written);
      assert.deepEqual(snapshot(who, caseId), settled);
      assert.equal(startsOf(who, caseId).length, starts);
    });
  }

  it('answers not found for a case that does not exist or belongs to another tenant', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    const written = batchCount(who);
    expectProblem(await revise(who.representative, newCaseId()), 404, 'not_found');
    expectProblem(await revise(who.foreignApprover, caseId), 404, 'not_found');
    assert.equal(batchCount(who), written);
  });

  const BAD_BODIES: [string, unknown][] = [
    ['no reason', {}],
    ['an empty reason', { reason: '' }],
    ['a reason over 500 characters', { reason: 'x'.repeat(501) }],
    ['a reason that is not text', { reason: 5 }],
    ['an unknown property', { reason: REASON, comment: 'extra' }],
  ];
  for (const [label, body] of BAD_BODIES) {
    it(`is refused with ${label}`, async () => {
      const who = actors();
      const { caseId } = await rejectedCase(who);
      const written = batchCount(who);
      const reply = await who.representative.call('requestRevision', { params: { caseId }, body });
      expectProblem(reply, 400, 'validation_failed');
      assert.equal(batchCount(who), written);
    });
  }
});

describe('who may request a revision', () => {
  it('lets an approver of the tenant ask for one', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    ok<RunView>(await revise(who.approver, caseId), 202);
    const items = await timelineOf(who.representative, caseId);
    assert.equal(items.find((item) => item.kind === 'revision_requested')?.actor.id, APPROVER_ID);
  });

  it('refuses an operator, who may inspect and recover work but not steer a case', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    const written = batchCount(who);
    expectProblem(await revise(who.operator, caseId), 403, 'forbidden_role');
    assert.equal(batchCount(who), written);
  });
});

describe('revising after the approval lapsed', () => {
  it('waits for the deadline, then records the lapse in the same write as the revision', async () => {
    const who = actors();
    const pending = await awaitingApproval(who);
    const { caseId } = pending;

    who.world.clock.set(new Date(expiryOf(pending) - 1));
    expectProblem(await revise(who.representative, caseId), 409, 'revision_not_allowed');

    who.world.clock.set(new Date(expiryOf(pending)));
    const before = batchesFor(who, caseId).length;
    ok<RunView>(await revise(who.representative, caseId), 202);
    const written = batchesFor(who, caseId).slice(before);
    assert.equal(written.length, 1);
    assert.deepEqual(opsOf(written[0]), [
      'replace:case',
      'replace:proposal',
      'create:timeline',
      'create:timeline',
      'create:timeline',
      'create:run',
      'create:outbox',
    ]);
    assert.equal((await proposalOf(who.representative, caseId, 1)).status, 'expired');
    assert.deepEqual(kindsOf(await timelineOf(who.representative, caseId)).slice(-3), ['approval_expired', 'revision_requested', 'run_queued']);
  });

  it('does not record the lapse twice when a decision attempt already did', async () => {
    const who = actors();
    const pending = await awaitingApproval(who);
    who.world.clock.set(new Date(expiryOf(pending)));
    expectProblem(await approve(who.approver, pending), 409, 'approval_expired');

    ok<RunView>(await revise(who.representative, pending.caseId), 202);
    const items = await timelineOf(who.representative, pending.caseId);
    assert.equal(kindsOf(items).filter((kind) => kind === 'approval_expired').length, 1);
  });

  it('gives the revised proposal its own window and keeps the lapsed one closed', async () => {
    const who = actors();
    const pending = await awaitingApproval(who);
    who.world.clock.set(new Date(expiryOf(pending)));
    ok<RunView>(await revise(who.representative, pending.caseId), 202);
    await who.representative.drain();

    const second: Pending = { caseId: pending.caseId, proposal: await proposalOf(who.representative, pending.caseId, 2) };
    assert.equal(second.proposal.status, 'pending_approval');
    assert.ok(expiryOf(second) > expiryOf(pending));
    expectProblem(await approve(who.approver, pending), 409, 'approval_expired');
    ok(await approve(who.approver, second), 202);
  });
});

describe('revising a finding', () => {
  it('investigates again and reports a new finding, which proposes no credit', async () => {
    const who = actors();
    const caseId = await openCase(who, { body: MISSING_EVIDENCE });
    await who.representative.drain();
    assert.equal((await caseOf(who.representative, caseId)).status, 'finding_reported');
    const first = await proposalOf(who.representative, caseId, 1);
    assert.equal(first.kind, 'finding');

    ok<RunView>(await revise(who.approver, caseId, 'The invoice was uploaded later.'), 202);
    assert.equal((await caseOf(who.representative, caseId)).status, 'queued');
    await who.representative.drain();

    const detail = await caseOf(who.representative, caseId);
    assert.equal(detail.status, 'finding_reported');
    assert.equal(detail.revision, 2);
    const second = await proposalOf(who.representative, caseId, 2);
    assert.equal(second.kind, 'finding');
    assert.equal(second.status, 'reported');
    assert.equal(second.approvalExpiresAt, null);
    assert.deepEqual(await proposalOf(who.representative, caseId, 1), first);
    assert.equal(who.world.provider.credits().length, 0);
    assert.equal(outboxOf(who, 'credit.execute').length, 0);
  });
});

describe('admitting a revision', () => {
  it('is refused while the tenant runs as many investigations as it may, and writes nothing', async () => {
    const who = limited();
    const { caseId } = await rejectedCase(who);
    await openCase(who);
    const settled = snapshot(who, caseId);
    const written = batchCount(who);

    const reply = await revise(who.representative, caseId);
    expectProblem(reply, 429, 'tenant_concurrency_limit');
    assert.equal(reply.headers['Retry-After'], '5');
    assert.equal(batchCount(who), written);
    assert.deepEqual(snapshot(who, caseId), settled);
    assert.equal((await caseOf(who.representative, caseId)).status, 'rejected');

    await who.representative.drain();
    ok<RunView>(await revise(who.representative, caseId), 202);
  });

  it('holds a slot for the revised run until it finishes', async () => {
    const who = limited();
    const { caseId } = await rejectedCase(who);
    ok<RunView>(await revise(who.representative, caseId), 202);
    assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-2')]);

    const submit = () => who.representative.call('createCase', { headers: { 'Idempotency-Key': who.nextKey() }, body: DUPLICATE });
    expectProblem(await submit(), 429, 'tenant_concurrency_limit');
    await who.representative.drain();
    assert.deepEqual(slotsOf(who), []);
    ok(await submit(), 202);
  });

  it('starts one run when two people ask at once with different reasons, and keeps the winner its slot', async () => {
    const who = limited();
    const { caseId } = await rejectedCase(who);
    const commits = commitCalls(who, caseId);
    const replies = await Promise.all([
      revise(who.representative, caseId, 'First opinion about the second invoice.'),
      revise(who.approver, caseId, 'Second opinion about the second invoice.'),
    ]);
    assert.equal(commitCalls(who, caseId) - commits, 2, 'both requests really raced for the write');

    assert.deepEqual(replies.map((reply) => reply.status).sort(), [202, 409]);
    const loser = replies.find((reply) => reply.status === 409);
    assert.ok(loser);
    expectProblem(loser, 409, 'revision_not_allowed');

    assert.deepEqual((await runsOf(who, caseId)).map((run) => run.runId), ['run-1', 'run-2']);
    assert.deepEqual(startsOf(who, caseId).map((doc) => doc.id).sort(), ['out-investigation-start-run-1', 'out-investigation-start-run-2']);
    assert.equal(kindsOf(await timelineOf(who.representative, caseId)).filter((kind) => kind === 'revision_requested').length, 1);
    assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-2')], 'the loser did not free the slot of the winner');
    expectProblem(await who.representative.call('createCase', { headers: { 'Idempotency-Key': who.nextKey() }, body: DUPLICATE }), 429, 'tenant_concurrency_limit');

    await who.representative.drain();
    assert.deepEqual(slotsOf(who), []);
    assert.equal((await caseOf(who.representative, caseId)).status, 'awaiting_approval');
  });

  it('never starts more than one run when the same request arrives twice at once', async () => {
    const who = limited();
    const { caseId } = await rejectedCase(who);
    const replies = await Promise.all([revise(who.representative, caseId), revise(who.representative, caseId)]);
    const statuses = replies.map((reply) => reply.status);
    assert.ok(statuses.every((status) => status === 202 || status === 409), JSON.stringify(statuses));
    assert.ok(statuses.includes(202), 'one of them was accepted');
    for (const reply of replies.filter((candidate) => candidate.status === 202)) {
      assert.equal(ok<RunView>(reply, 202).runId, 'run-2');
    }

    assert.deepEqual((await runsOf(who, caseId)).map((run) => run.runId), ['run-1', 'run-2']);
    assert.equal(startsOf(who, caseId).length, 2);
    assert.equal(kindsOf(await timelineOf(who.representative, caseId)).filter((kind) => kind === 'revision_requested').length, 1);
    assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-2')]);
  });
});

describe('losing a write while revising', () => {
  it('recognises its own earlier write when the response was lost, instead of starting a second run', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    let lost = 1;
    who.world.memory.hooks.afterCommit = (batch) => {
      if (batch.caseId === caseId && lost > 0) {
        lost -= 1;
        throw transient();
      }
    };
    const run = ok<RunView>(await revise(who.representative, caseId, REASON), 202);
    assert.equal(run.runId, 'run-2');
    assert.equal(lost, 0, 'the response of a committed write really was lost');

    assert.equal((await runsOf(who, caseId)).length, 2);
    assert.equal(startsOf(who, caseId).length, 2);
    assert.equal(batchesFor(who, caseId).filter((batch) => batch.ops.some((op) => op.id === 'out-investigation-start-run-2')).length, 1);
    assert.equal(kindsOf(await timelineOf(who.representative, caseId)).filter((kind) => kind === 'revision_requested').length, 1);
  });

  it('gives up with a conflict when every attempt loses its race, and frees the slot it took', async () => {
    const who = limited();
    const { caseId } = await rejectedCase(who);
    const settled = snapshot(who, caseId);
    let attempts = 0;
    who.world.memory.hooks.beforeCommit = (batch) => {
      if (batch.caseId === caseId) {
        attempts += 1;
        throw new CaseWriteError('stale', 0);
      }
    };
    expectProblem(await revise(who.representative, caseId), 409, 'concurrent_update');
    assert.equal(attempts, MAX_ATTEMPTS);
    assert.deepEqual(snapshot(who, caseId), settled);
    assert.deepEqual(slotsOf(who), [], 'each attempt released the slot it took');

    who.world.memory.hooks.beforeCommit = undefined;
    ok<RunView>(await revise(who.representative, caseId), 202);
  });

  it('retries a transient dependency failure and still starts one run', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    let failures = 1;
    who.world.memory.hooks.beforeCommit = (batch) => {
      if (batch.caseId === caseId && failures > 0) {
        failures -= 1;
        throw transient();
      }
    };
    ok<RunView>(await revise(who.representative, caseId), 202);
    assert.equal(failures, 0);
    assert.equal((await runsOf(who, caseId)).length, 2);
    assert.equal(startsOf(who, caseId).length, 2);
  });

  it('leaves the slot to its lease and answers 503 when the outcome of the write cannot be determined', async () => {
    const who = actors();
    const { caseId } = await rejectedCase(who);
    const { memory } = who.world;
    let blind = false;
    memory.hooks.afterCommit = (batch) => {
      if (batch.caseId === caseId) {
        blind = true;
        throw transient(408);
      }
    };
    const read = memory.store.get.bind(memory.store);
    memory.store.get = (kind, tenantId, id, docId) => (blind ? Promise.reject(transient(503)) : read(kind, tenantId, id, docId));

    const reply = await revise(who.representative, caseId);
    expectProblem(reply, 503, 'dependency_unavailable');
    assert.equal(reply.headers['Retry-After'], '5');
    assert.ok(who.representative.lines.some((line) => line.includes('revision outcome is unknown')));

    memory.hooks.afterCommit = undefined;
    blind = false;
    assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-2')], 'neither released nor refunded');
    expectProblem(await revise(who.representative, caseId), 409, 'revision_not_allowed');

    await who.representative.drain();
    assert.deepEqual(slotsOf(who), [], 'the run that was recorded after all releases its slot when it finishes');
    assert.equal((await caseOf(who.representative, caseId)).status, 'awaiting_approval');
    assert.equal((await proposalOf(who.representative, caseId, 2)).status, 'pending_approval');
  });
});
