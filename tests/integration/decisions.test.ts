import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import { creditKeyFor } from '../../src/credits/provider.ts';
import type { Api } from '../support/api.ts';
import { assertProblem } from '../support/assertions.ts';
import {
  approver,
  docsOfType,
  MISSING_EVIDENCE,
  newKey,
  operator,
  representative,
  stranger,
  TENANT,
  usd,
} from '../support/case-flow.ts';
import {
  approverB,
  creditFlow,
  creditOutboxId,
  dual,
  expectOk,
  expectProblem,
  foreignApprover,
  REASON,
  type Pending,
} from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';

/**
 * Human decisions and the credit they lead to, through the real host, the Cosmos DB change feed trigger and the
 * emulator. Every claim about "one effect" is checked in the provider's own container, not only in what the API says.
 */

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;

before(() => {
  stack = readStackConnection();
  api = connectApi(stack);
  cosmos = openEmulator(stack);
});

after(() => {
  cosmos.dispose();
});

const flow = creditFlow(() => ({ stack, api, cosmos }));
const {
  approve,
  awaitCase,
  awaitingApproval,
  createCase,
  creditOf,
  creditsOf,
  credited,
  etagsOf,
  getCase,
  getProposal,
  kindsOf,
  reject,
  revise,
  shiftApprovalDeadline,
  storedDocs,
  timelineOf,
} = flow;

const countOf = (kinds: readonly string[], kind: string): number => kinds.filter((candidate) => candidate === kind).length;

describe('approving a proposal', () => {
  it('credits it exactly once and records the effect everywhere it belongs', { timeout: 240_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId, proposal } = pending;
    assert.equal(proposal.status, 'pending_approval');
    assert.deepEqual(proposal.amount, usd(4900));

    const reply = await approve(approver, pending, { comment: 'Matches the invoices.' });
    const accepted = expectOk(reply, 202);
    assert.equal(reply.headers.get('location'), `/api/cases/${caseId}`);
    assert.equal(reply.headers.get('retry-after'), '2');
    assert.equal(accepted.decision.outcome, 'approved');
    assert.equal(accepted.decision.proposalDigest, proposal.digest);
    assert.equal(accepted.decision.policyVersion, proposal.policyRef?.version);
    assert.equal(accepted.decision.reason, 'Matches the invoices.');
    assert.equal(accepted.caseStatus, 'approved');

    const detail = await awaitCase(representative, caseId, 'credited');
    const result = expectOk(await creditOf(representative, caseId), 200);
    assert.equal(result.simulated, true);
    assert.equal(result.proposalVersion, 1);
    assert.deepEqual(result.amount, usd(4900));
    assert.equal(result.provider.idempotencyKey, creditKeyFor(caseId, 1));
    assert.equal(result.provider.reconciled, false);
    assert.equal(detail.creditResult?.resultId, result.resultId);

    const held = await creditsOf(caseId);
    assert.equal(held.length, 1, 'the provider holds one credit for the case');
    assert.equal(held[0]?.id, result.provider.idempotencyKey);
    assert.equal(held[0]?.reference, result.provider.reference);
    assert.deepEqual(held[0]?.amount, usd(4900));

    const kinds = (await timelineOf(representative, caseId)).map((item) => item.kind);
    const order = ['decision_approved', 'execution_queued', 'credit_executed'].map((kind) => kinds.indexOf(kind));
    assert.ok(order.every((index) => index >= 0), `the timeline names the decision, the queueing and the credit: ${kinds.join(', ')}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in that order');
    assert.equal(countOf(kinds, 'credit_executed'), 1);
    assert.equal(countOf(kinds, 'credit_reconciled'), 0);

    const docs = await storedDocs(TENANT, caseId);
    assert.equal(docsOfType(docs, 'credit_result').length, 1);
    assert.equal(docsOfType(docs, 'proposal')[0]?.status, 'executed');
    assert.equal(docsOfType(docs, 'outbox').find((doc) => doc.id === creditOutboxId())?.state, 'completed');
    assert.equal((await getProposal(representative, caseId, 1)).decision?.reason, 'Matches the invoices.');
  });

  it('turns repeated and concurrent approvals into one decision and one credit', { timeout: 240_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId } = pending;

    const replies = await Promise.all(Array.from({ length: 6 }, () => approve(approver, pending)));
    for (const reply of replies) {
      assert.ok(
        reply.status === 202 || (reply.status === 409 && reply.problem?.code === 'concurrent_update'),
        `a concurrent approval is accepted or told to retry: ${String(reply.status)} ${JSON.stringify(reply.problem)}`,
      );
    }
    const accepted = replies.flatMap((reply) => (reply.status === 202 ? [expectOk(reply, 202)] : []));
    assert.ok(accepted.length >= 1, 'at least one approval was accepted');
    const decisionId = accepted[0]?.decision.decisionId;
    for (const one of accepted) assert.equal(one.decision.decisionId, decisionId, 'all accepted approvals are the same decision');

    await awaitCase(representative, caseId, 'credited');
    const replay = expectOk(await approve(approver, pending), 202);
    assert.equal(replay.decision.decisionId, decisionId, 'an identical repeat replays the decision');
    assert.equal(replay.caseStatus, 'credited');
    expectProblem(await approve(approverB, pending), 409, 'proposal_already_decided');

    assert.equal((await creditsOf(caseId)).length, 1, 'one credit after six concurrent approvals and two repeats');
    const kinds = await kindsOf(representative, caseId);
    assert.equal(countOf(kinds, 'decision_approved'), 1);
    assert.equal(countOf(kinds, 'credit_executed'), 1);
    assert.equal(docsOfType(await storedDocs(TENANT, caseId), 'credit_result').length, 1);
  });

  it('lets exactly one of two competing decisions win, and keeps the credit consistent with the winner', { timeout: 300_000 }, async () => {
    const rounds = await Promise.all(Array.from({ length: 4 }, () => awaitingApproval()));
    const raced = await Promise.all(
      rounds.map(async (pending) => {
        const [approval, rejection] = await Promise.all([approve(approver, pending), reject(approverB, pending, REASON)]);
        return { pending, approval, rejection };
      }),
    );

    for (const { pending, approval, rejection } of raced) {
      const approved = approval.status === 202;
      const [won, lost] = approved ? [approval, rejection] : [rejection, approval];
      assert.equal(won.status, approved ? 202 : 200, `the winner is accepted: ${JSON.stringify(won.problem)}`);
      expectProblem(lost, 409, 'proposal_already_decided');

      const stored = await getProposal(representative, pending.caseId, 1);
      assert.equal(stored.decision?.outcome, approved ? 'approved' : 'rejected');
      if (approved) {
        await awaitCase(representative, pending.caseId, 'credited');
        assert.equal((await creditsOf(pending.caseId)).length, 1);
      } else {
        assert.equal((await getCase(representative, pending.caseId)).status, 'rejected');
        assert.equal((await creditsOf(pending.caseId)).length, 0, 'a rejected proposal is never credited');
        const outbox = docsOfType(await storedDocs(TENANT, pending.caseId), 'outbox');
        assert.equal(outbox.find((doc) => doc.id === creditOutboxId()), undefined, 'and never queued for execution');
      }
    }
  });

  it('refuses what it must refuse and writes nothing when it does', { timeout: 240_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId, proposal } = pending;
    const before = await etagsOf(TENANT, caseId);
    const path = `/api/cases/${caseId}/proposals/1`;
    const body = { policyVersion: proposal.policyRef?.version, proposalDigest: proposal.digest };

    expectProblem(await approve(representative, pending), 403, 'forbidden_role');
    expectProblem(await approve(operator, pending), 403, 'forbidden_role');
    expectProblem(await reject(representative, pending, REASON), 403, 'forbidden_role');
    expectProblem(await approve(foreignApprover, pending), 404, 'not_found');
    expectProblem(await reject(foreignApprover, pending, REASON), 404, 'not_found');
    expectProblem(await approve(approver, pending, { proposalDigest: `sha256:${'0'.repeat(64)}` }), 409, 'proposal_digest_mismatch');
    expectProblem(await reject(approver, pending, REASON, { proposalDigest: `sha256:${'0'.repeat(64)}` }), 409, 'proposal_digest_mismatch');
    expectProblem(await approve(approver, pending, { policyVersion: (proposal.policyRef?.version ?? 0) + 1 }), 409, 'policy_version_mismatch');
    expectProblem(await approve(approver, pending, { version: 2 }), 404, 'not_found');

    assertProblem(await api.post(`${path}/approve`, { as: null, body }), 401, 'unauthenticated');
    assertProblem(await api.post(`${path}/approve`, { as: approver, body: { policyVersion: body.policyVersion } }), 400, 'validation_failed');
    assertProblem(await api.post(`${path}/reject`, { as: approver, body: { ...body, reason: '' } }), 400, 'validation_failed');
    assertProblem(await api.post(`${path}/approve`, { as: approver, body: { ...body, extra: true } }), 400, 'validation_failed');

    assert.deepEqual(await etagsOf(TENANT, caseId), before, 'no document of the case was written');
    assert.equal((await getCase(representative, caseId)).status, 'awaiting_approval');
    assert.equal((await creditsOf(caseId)).length, 0);
  });

  it('does not let a person decide a case they created, and lets someone else decide it afterwards', { timeout: 240_000 }, async () => {
    const pending = await awaitingApproval(dual);
    const before = await etagsOf(TENANT, pending.caseId);

    expectProblem(await approve(dual, pending), 403, 'forbidden_separation_of_duties');
    expectProblem(await reject(dual, pending, REASON), 403, 'forbidden_separation_of_duties');
    assert.deepEqual(await etagsOf(TENANT, pending.caseId), before, 'the refusals wrote nothing');

    const result = await credited(pending, approver);
    assert.equal(result.proposalVersion, 1);
    assert.equal((await creditsOf(pending.caseId)).length, 1);
  });

  it('does not offer a finding for approval', { timeout: 240_000 }, async () => {
    const { accepted } = await createCase(representative, newKey('finding'), MISSING_EVIDENCE);
    const caseId = accepted.case.caseId;
    await awaitCase(representative, caseId, 'finding_reported');
    const proposal = await getProposal(representative, caseId, 1);
    assert.equal(proposal.kind, 'finding');
    assert.equal(proposal.status, 'reported');
    assert.equal(proposal.amount, null);

    const pending: Pending = { caseId, proposal };
    expectProblem(await approve(approver, pending, { policyVersion: 1 }), 409, 'proposal_not_decidable');
    expectProblem(await reject(approver, pending, REASON, { policyVersion: 1 }), 409, 'proposal_not_decidable');
    expectProblem(await creditOf(representative, caseId), 404, 'not_found');
    assert.equal((await creditsOf(caseId)).length, 0);
  });
});

describe('rejecting a proposal and asking for a revision', () => {
  it('records the reason, credits nothing, and keeps the reason out of the host log', { timeout: 240_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId } = pending;

    const rejected = expectOk(await reject(approver, pending, REASON), 200);
    assert.equal(rejected.outcome, 'rejected');
    assert.equal(rejected.reason, REASON);
    assert.equal((await getCase(representative, caseId)).status, 'rejected');

    const item = (await timelineOf(representative, caseId)).find((entry) => entry.kind === 'decision_rejected');
    assert.equal(item?.data?.['reason'], REASON, 'the reason is part of the case history');
    assert.equal(await creditsOf(caseId).then((held) => held.length), 0);
    assert.equal(docsOfType(await storedDocs(TENANT, caseId), 'outbox').find((doc) => doc.id === creditOutboxId()), undefined);
    expectProblem(await creditOf(representative, caseId), 404, 'not_found');

    expectProblem(await approve(approver, pending), 409, 'proposal_already_decided');
    const replay = expectOk(await reject(approver, pending, REASON), 200);
    assert.equal(replay.decisionId, rejected.decisionId, 'an identical rejection replays the decision');
    expectProblem(await reject(approver, pending, 'A different reason.'), 409, 'proposal_already_decided');

    const log = await readFile(stack.hostLog, 'utf8');
    assert.ok(!log.includes('zq4471'), 'a reason typed by a person never reaches the host log');
  });

  it('needs fresh approval for a revision, and credits only what was approved', { timeout: 300_000 }, async () => {
    const first = await awaitingApproval();
    const { caseId } = first;
    expectOk(await reject(approver, first, REASON), 200);

    const run = expectOk(await revise(representative, caseId, 'Please check the second invoice again.'), 202);
    assert.equal(run.revision, 2);
    assert.equal(run.caseId, caseId);
    await awaitCase(representative, caseId, 'awaiting_approval');

    const second: Pending = { caseId, proposal: await getProposal(representative, caseId, 2) };
    assert.equal(second.proposal.status, 'pending_approval');
    assert.notEqual(second.proposal.digest, first.proposal.digest);
    assert.equal((await getProposal(representative, caseId, 1)).status, 'rejected');

    expectProblem(await approve(approver, first), 409, 'proposal_already_decided');
    expectProblem(await approve(approver, second, { proposalDigest: first.proposal.digest }), 409, 'proposal_digest_mismatch');
    assert.equal((await creditsOf(caseId)).length, 0, 'nothing is credited before the revision is approved');

    const result = await credited(second);
    assert.equal(result.proposalVersion, 2);
    assert.equal(result.provider.idempotencyKey, creditKeyFor(caseId, 2));
    const held = await creditsOf(caseId);
    assert.equal(held.length, 1);
    assert.equal(held[0]?.id, creditKeyFor(caseId, 2));
    assert.equal((await getProposal(representative, caseId, 1)).status, 'rejected');
    assert.equal((await getProposal(representative, caseId, 2)).status, 'executed');
  });

  it('refuses a revision that is not allowed', { timeout: 240_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId } = pending;
    const before = await etagsOf(TENANT, caseId);

    expectProblem(await revise(representative, caseId, 'Nothing was decided yet.'), 409, 'revision_not_allowed');
    expectProblem(await revise(operator, caseId, REASON), 403, 'forbidden_role');
    expectProblem(await revise(stranger, caseId, REASON), 404, 'not_found');
    assertProblem(await api.post(`/api/cases/${caseId}/revisions`, { as: representative, body: { reason: '' } }), 400, 'validation_failed');
    assert.deepEqual(await etagsOf(TENANT, caseId), before, 'the refusals wrote nothing');
  });

  it('stops after three revisions', { timeout: 420_000 }, async () => {
    let pending = await awaitingApproval();
    const { caseId } = pending;
    for (const version of [2, 3, 4]) {
      expectOk(await reject(approver, pending, REASON), 200);
      expectOk(await revise(representative, caseId, `Revision ${String(version)}.`), 202);
      await awaitCase(representative, caseId, 'awaiting_approval');
      pending = { caseId, proposal: await getProposal(representative, caseId, version) };
    }
    expectOk(await reject(approver, pending, REASON), 200);
    expectProblem(await revise(representative, caseId, 'One too many.'), 409, 'revision_limit_reached');
    assert.equal((await getCase(representative, caseId)).status, 'rejected');

    const runs = await api.client(representative).GET('/cases/{caseId}/runs', { params: { path: { caseId } } });
    assert.equal(runs.data?.items.length, 4, 'four runs are the most a case can have');
  });
});

describe('an approval that is not decided in time', () => {
  it('expires, is refused once and recorded once, and can be revised', { timeout: 300_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId } = pending;

    // Test-only: the stored deadline is moved into the past, standing in for the passing of the approval window.
    await shiftApprovalDeadline(caseId, 1, new Date(Date.now() - 60_000));
    assert.equal((await getCase(representative, caseId)).status, 'expired', 'reads derive the expiry');

    expectProblem(await approve(approver, pending), 409, 'approval_expired');
    expectProblem(await approve(approver, pending), 409, 'approval_expired');
    expectProblem(await reject(approver, pending, REASON), 409, 'approval_expired');

    const docs = await storedDocs(TENANT, caseId);
    assert.equal(docsOfType(docs, 'proposal')[0]?.status, 'expired');
    assert.equal(docsOfType(docs, 'case')[0]?.status, 'expired');
    assert.equal(countOf(await kindsOf(representative, caseId), 'approval_expired'), 1, 'the expiry is recorded once');
    assert.equal((await creditsOf(caseId)).length, 0);

    expectOk(await revise(representative, caseId, 'The approval window lapsed.'), 202);
    await awaitCase(representative, caseId, 'awaiting_approval');
    const second: Pending = { caseId, proposal: await getProposal(representative, caseId, 2) };
    assert.equal(second.proposal.status, 'pending_approval');
    const result = await credited(second);
    assert.equal(result.proposalVersion, 2);
    assert.equal((await creditsOf(caseId)).length, 1);
  });
});
