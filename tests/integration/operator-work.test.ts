import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import type { Api } from '../support/api.ts';
import { assertProblem, jsonBody } from '../support/assertions.ts';
import {
  approver,
  BOREALIS,
  docsOfType,
  DUPLICATE,
  operator,
  OUTBOX_ID,
  representative,
  stranger,
  TENANT,
  usd,
  type DocOfType,
  type Schemas,
} from '../support/case-flow.ts';
import { creditFlow, creditOutboxId, expectOk, expectProblem, foreignOperator, type Pending, type WorkItem, type WorkState } from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';

/**
 * What an operator sees of work that waits, finished, stopped or is stuck, through the real listing queries on the
 * Cosmos DB emulator. The suite shares one database, so every check is about the items this file made and about
 * properties of the whole listing (order, no repeats, tenant scope), never about how many items there are.
 */

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;

after(() => {
  cosmos.dispose();
});

const flow = creditFlow(() => ({ stack, api, cosmos }));
const { allWork, amend, approve, awaitCase, awaitingApproval, awaitOutbox, awaitWork, credited, etagsOf, getProposal, holdCredit, inspect, kindsOf, recover, shiftApprovalDeadline, statusOf, storedDocs, workIdOf, workPages } = flow;

const WORK_STATES: readonly WorkState[] = ['waiting', 'failed', 'poison', 'recoverable', 'budget_exhausted', 'completed'];

const proposalWorkId = (pending: Pending): string => workIdOf(pending.caseId, 'proposal-1');
const idsOf = (items: readonly WorkItem[]): string[] => items.map((item) => item.workId);

function assertNewestFirst(items: readonly WorkItem[]): void {
  for (let index = 1; index < items.length; index += 1) {
    const newer = items[index - 1];
    const older = items[index];
    assert.ok(newer && older);
    assert.ok(newer.createdAt >= older.createdAt, `${newer.workId} (${newer.createdAt}) is listed before ${older.workId} (${older.createdAt})`);
  }
}

function assertListedOnce(items: readonly WorkItem[]): void {
  assert.equal(new Set(idsOf(items)).size, items.length, 'no item is listed twice');
}

async function listedIn(state: WorkState, workId: string): Promise<WorkItem | undefined> {
  return (await allWork(operator, state)).find((item) => item.workId === workId);
}

interface Scene {
  readonly waiting: readonly Pending[];
  readonly foreign: Pending;
  readonly poisoned: Pending;
  readonly finished: Pending;
}

let scene: Scene;

// The hooks of a file start together, so the connection and the cases that need it must share one.
before(
  async () => {
    stack = readStackConnection();
    api = connectApi(stack);
    cosmos = openEmulator(stack);

    // One at a time, so their proposals have a known order.
    const waiting: Pending[] = [];
    for (let count = 0; count < 3; count += 1) waiting.push(await awaitingApproval(representative, DUPLICATE, 'ow-wait'));
    const foreign = await awaitingApproval(stranger, BOREALIS, 'ow-foreign');

    // The provider already holds a different credit under this approval's key, which stops the execution for good.
    const poisoned = await awaitingApproval(representative, DUPLICATE, 'ow-poison');
    await holdCredit(poisoned.caseId, 1, usd(100));
    expectOk(await approve(approver, poisoned), 202);
    await awaitWork(operator, 'poison', workIdOf(poisoned.caseId, creditOutboxId()));
    await awaitCase(representative, poisoned.caseId, 'needs_attention');

    const finished = await awaitingApproval(representative, DUPLICATE, 'ow-done');
    await credited(finished);
    scene = { waiting, foreign, poisoned, finished };
  },
  { timeout: 300_000 },
);

describe('work that waits for a person', () => {
  it('is listed newest first, page by page, without repeating or skipping an item', { timeout: 120_000 }, async () => {
    const pages = await workPages(operator, 'waiting', 2);
    assert.ok(pages.length >= 2, 'more than one page of waiting approvals');
    for (const page of pages.slice(0, -1)) assert.equal(page.length, 2, 'every page but the last is full');
    const items = pages.flat();
    assertListedOnce(items);
    assertNewestFirst(items);

    const mine = scene.waiting.map(proposalWorkId);
    assert.deepEqual(
      idsOf(items).filter((id) => mine.includes(id)),
      [...mine].reverse(),
      'all three of this file are listed, and the proposal submitted last comes first',
    );
  });

  it('describes a waiting approval and gives an operator no way to decide it', async () => {
    const [first] = scene.waiting;
    assert.ok(first);
    const workId = proposalWorkId(first);
    const listed = await listedIn('waiting', workId);
    assert.ok(listed);
    assert.equal(listed.caseId, first.caseId);
    assert.equal(listed.kind, 'proposal_approval');
    assert.equal(listed.state, 'waiting');
    assert.equal(listed.attempts, 0);
    assert.equal(listed.lastError, null);
    assert.equal(listed.claimedUntil, null);
    assert.equal(listed.usage, null);
    assert.deepEqual(listed.actions, []);
    assert.match(listed.summary, /^Credit proposal v1/);
    assert.deepEqual(expectOk(await inspect(operator, workId), 200), listed, 'inspecting gives the item the listing showed');

    const before = await etagsOf(TENANT, first.caseId);
    expectProblem(await recover(operator, workId, { action: 'requeue', reason: 'Trying to push an approval through.' }), 409, 'recovery_not_applicable');
    expectProblem(await recover(operator, workId, { action: 'resume', reason: 'Trying to push an approval through.', allowance: { steps: 1 } }), 409, 'recovery_not_applicable');
    assert.deepEqual(await etagsOf(TENANT, first.caseId), before, 'nothing was written');
    const proposal = await getProposal(representative, first.caseId, 1);
    assert.equal(proposal.status, 'pending_approval');
    assert.equal(proposal.decision, null);
  });

  it('keeps its place between pages while newer work arrives', { timeout: 120_000 }, async () => {
    const page = (token?: string) => api.get(`/api/operator/work?state=waiting&limit=2${token === undefined ? '' : `&continuationToken=${token}`}`, { as: operator });
    const first = jsonBody<Schemas['WorkItemPage']>(await page());
    assert.equal(first.items.length, 2);
    assert.ok(first.continuationToken);

    const arrived = await awaitingApproval(representative, DUPLICATE, 'ow-arrives');
    const second = jsonBody<Schemas['WorkItemPage']>(await page(first.continuationToken));
    assert.ok(second.items.length > 0);
    const seen = new Set(idsOf(first.items));
    assert.equal(second.items.some((item) => seen.has(item.workId)), false, 'the second page repeats nothing of the first');
    assert.equal(idsOf(second.items).includes(proposalWorkId(arrived)), false, 'work newer than the cursor does not shift the page');
    assert.ok((first.items[1]?.createdAt ?? '') >= (second.items[0]?.createdAt ?? ''), 'the second page continues where the first stopped');

    const fresh = jsonBody<Schemas['WorkItemPage']>(await page());
    assert.ok(idsOf(fresh.items).includes(proposalWorkId(arrived)), 'a fresh listing starts with the new work');
  });

  it('stops listing an approval once its time has run out', async () => {
    const pending = await awaitingApproval(representative, DUPLICATE, 'ow-lapses');
    const workId = proposalWorkId(pending);
    await awaitWork(operator, 'waiting', workId);

    // Test-only: the deadline moves into the past, standing in for the passing of the approval window.
    await shiftApprovalDeadline(pending.caseId, 1, new Date(Date.now() - 60_000));
    for (const state of WORK_STATES) assert.equal(await listedIn(state, workId), undefined, `an expired approval is not ${state} work`);
    expectProblem(await inspect(operator, workId), 404, 'not_found');
  });
});

describe('work that finished or was given up on', () => {
  it('lists a credit and the investigation behind it as completed', { timeout: 120_000 }, async () => {
    const items = await allWork(operator, 'completed');
    assertListedOnce(items);
    assertNewestFirst(items);

    const credit = items.find((item) => item.workId === workIdOf(scene.finished.caseId, creditOutboxId()));
    assert.ok(credit, 'the executed credit is listed');
    assert.equal(credit.kind, 'outbox');
    assert.equal(credit.state, 'completed');
    assert.equal(credit.attempts, 1);
    assert.equal(credit.lastError, null);
    assert.deepEqual(credit.actions, []);
    assert.ok(items.some((item) => item.workId === workIdOf(scene.finished.caseId, OUTBOX_ID)), 'the investigation start is listed');
    assert.deepEqual(expectOk(await inspect(operator, credit.workId), 200), credit);
  });

  it('lists work that was given up on with the reason, and in no other state', { timeout: 120_000 }, async () => {
    const workId = workIdOf(scene.poisoned.caseId, creditOutboxId());
    const listed = await listedIn('poison', workId);
    assert.ok(listed);
    assert.equal(listed.kind, 'outbox');
    assert.equal(listed.state, 'poison');
    assert.equal(listed.attempts, 1);
    assert.equal(listed.lastError?.code, 'provider_key_conflict');
    assert.match(listed.summary, /poison/);
    assert.deepEqual(listed.actions, ['requeue']);
    assert.deepEqual(expectOk(await inspect(operator, workId), 200), listed);

    for (const state of WORK_STATES.filter((candidate) => candidate !== 'poison')) {
      assert.equal(await listedIn(state, workId), undefined, `poisoned work is not ${state} work`);
    }
  });

  it('lists a run that failed and offers no recovery for it', async () => {
    const { caseId } = await awaitingApproval(representative, DUPLICATE, 'ow-failed');
    const workId = workIdOf(caseId, 'run-1');

    // Test-only: no scenario of this sample fails a run that way, so the stored run is changed.
    await amend<DocOfType<'run'>>(caseId, 'run-1', (doc) => ({ ...doc, state: 'failed', stopReason: 'tool_error' }));
    const listed = await awaitWork(operator, 'failed', workId);
    assert.equal(listed.kind, 'investigation_run');
    assert.equal(listed.attempts, 1);
    assert.deepEqual(listed.lastError, { code: 'tool_error', message: 'A tool failed in a way retrying cannot fix.' });
    assert.deepEqual(listed.actions, []);
    assert.deepEqual(expectOk(await inspect(operator, workId), 200), listed);

    const before = await etagsOf(TENANT, caseId);
    expectProblem(await recover(operator, workId, { action: 'requeue', reason: 'Trying to run it again.' }), 409, 'recovery_not_applicable');
    expectProblem(await recover(operator, workId, { action: 'resume', reason: 'Trying to run it again.', allowance: { steps: 1 } }), 409, 'recovery_not_applicable');
    assert.deepEqual(await etagsOf(TENANT, caseId), before, 'nothing was written');
  });
});

describe('work that is not progressing', () => {
  it('lists an item whose claim ran out, and a requeue of it creates nothing new', { timeout: 180_000 }, async () => {
    const pending = await awaitingApproval(representative, DUPLICATE, 'ow-stale');
    const { caseId } = pending;
    const workId = workIdOf(caseId, OUTBOX_ID);
    const docsBefore = await storedDocs(TENANT, caseId);

    // Test-only: a worker that claimed the item and died. Nothing delivers the item again, which is what this listing is for.
    const claimedUntil = new Date(Date.now() + 15_000).toISOString();
    await amend<DocOfType<'outbox'>>(caseId, OUTBOX_ID, (doc) => ({
      ...doc,
      state: 'claimed',
      attempts: 1,
      claimedBy: 'it-dead-worker',
      claimedUntil,
      completedAt: null,
    }));
    assert.equal(await listedIn('recoverable', workId), undefined, 'a claim that is still live is work in progress');
    expectProblem(await inspect(operator, workId), 404, 'not_found');

    const stuck = await awaitWork(operator, 'recoverable', workId, 90_000);
    assert.equal(stuck.kind, 'outbox');
    assert.equal(stuck.state, 'recoverable');
    assert.equal(stuck.claimedUntil, claimedUntil);
    assert.deepEqual(stuck.actions, ['requeue']);
    assert.deepEqual(expectOk(await inspect(operator, workId), 200), stuck);

    const accepted = expectOk(await recover(operator, workId, { action: 'requeue', reason: 'The worker that claimed this is gone.' }), 202);
    assert.deepEqual({ workId: accepted.workId, action: accepted.action, state: accepted.state, grantNumber: accepted.grantNumber }, { workId, action: 'requeue', state: 'recoverable', grantNumber: null });
    const finished = await awaitOutbox(caseId, OUTBOX_ID, 'completed');
    assert.equal(finished.attempts, 1, 'a requeue starts the attempts again');

    const docsAfter = await storedDocs(TENANT, caseId);
    for (const type of ['run', 'usage', 'proposal'] as const) {
      assert.equal(docsOfType(docsAfter, type).length, docsOfType(docsBefore, type).length, `no ${type} was added by running a finished investigation again`);
    }
    assert.equal(await statusOf(caseId), 'awaiting_approval');
    assert.deepEqual(await getProposal(representative, caseId, 1), pending.proposal, 'the pending proposal is exactly the one that was there');
    assert.equal((await kindsOf(representative, caseId)).filter((kind) => kind === 'work_requeued').length, 1);
  });
});

describe('who may see which work', () => {
  it('lists only the work of the operator’s own tenant', { timeout: 120_000 }, async () => {
    const ours = idsOf(await allWork(operator, 'waiting'));
    const theirs = idsOf(await allWork(foreignOperator, 'waiting'));
    assert.ok(theirs.includes(proposalWorkId(scene.foreign)), 'the other tenant sees its own approval');
    assert.equal(ours.includes(proposalWorkId(scene.foreign)), false);
    for (const pending of scene.waiting) assert.equal(theirs.includes(proposalWorkId(pending)), false);

    const poisonId = workIdOf(scene.poisoned.caseId, creditOutboxId());
    assert.equal((await allWork(foreignOperator, 'poison')).some((item) => item.workId === poisonId), false);
    assert.equal((await allWork(foreignOperator, 'completed')).some((item) => item.caseId === scene.finished.caseId), false);
  });

  it('answers for another tenant’s work exactly as for work that does not exist, and writes nothing', async () => {
    const workId = workIdOf(scene.poisoned.caseId, creditOutboxId());
    const unknown = workIdOf(`case_${'0'.repeat(32)}`, creditOutboxId());
    const before = await etagsOf(TENANT, scene.poisoned.caseId);

    const foreignRead = await inspect(foreignOperator, workId);
    const unknownRead = await inspect(foreignOperator, unknown);
    expectProblem(foreignRead, 404, 'not_found');
    expectProblem(unknownRead, 404, 'not_found');
    assert.equal(foreignRead.problem?.title, unknownRead.problem?.title);
    expectProblem(await recover(foreignOperator, workId, { action: 'requeue', reason: 'Another tenant reaching for this.' }), 404, 'not_found');
    assert.deepEqual(await etagsOf(TENANT, scene.poisoned.caseId), before, 'nothing was written');
  });

  it('refuses everyone who is not an operator, and anyone who is not signed in', async () => {
    const workId = workIdOf(scene.poisoned.caseId, creditOutboxId());
    const recovery = { action: 'requeue', reason: 'Not an operator.' };
    const before = await etagsOf(TENANT, scene.poisoned.caseId);

    for (const who of [representative, approver]) {
      assertProblem(await api.get('/api/operator/work?state=poison', { as: who }), 403, 'forbidden_role');
      assertProblem(await api.get(`/api/operator/work/${workId}`, { as: who }), 403, 'forbidden_role');
      assertProblem(await api.post(`/api/operator/work/${workId}/recover`, { as: who, body: recovery }), 403, 'forbidden_role');
    }
    assertProblem(await api.get('/api/operator/work?state=poison', { as: null }), 401, 'unauthenticated');
    assertProblem(await api.get(`/api/operator/work/${workId}`, { as: null }), 401, 'unauthenticated');
    assertProblem(await api.post(`/api/operator/work/${workId}/recover`, { as: null, body: recovery }), 401, 'unauthenticated');
    assert.deepEqual(await etagsOf(TENANT, scene.poisoned.caseId), before, 'nothing was written');
  });
});

describe('what the operator endpoints ask for', () => {
  it('validates the state, the page size, the cursor and the work id', async () => {
    const list = (query: string) => api.get(`/api/operator/work${query}`, { as: operator });
    assertProblem(await list(''), 400, 'validation_failed');
    assertProblem(await list('?state=archived'), 400, 'validation_failed');
    assertProblem(await list('?state=waiting&limit=0'), 400, 'validation_failed');
    assertProblem(await list('?state=waiting&limit=51'), 400, 'validation_failed');
    assertProblem(await list('?state=waiting&continuationToken=garbage'), 400, 'invalid_continuation_token');

    assertProblem(await api.get('/api/operator/work/not-a-work-id', { as: operator }), 400, 'validation_failed');
    const unknown = workIdOf(`case_${'0'.repeat(32)}`, 'proposal-1');
    assertProblem(await api.get(`/api/operator/work/${unknown}`, { as: operator }), 404, 'not_found');
    assertProblem(await api.post(`/api/operator/work/${unknown}/recover`, { as: operator, body: { action: 'requeue', reason: 'Nothing is there.' } }), 404, 'not_found');
  });

  it('validates what a recovery asks for, before it touches any work', async () => {
    const workId = workIdOf(scene.poisoned.caseId, creditOutboxId());
    const before = await etagsOf(TENANT, scene.poisoned.caseId);
    const post = (body: unknown) => api.post(`/api/operator/work/${workId}/recover`, { as: operator, body });

    for (const body of [
      { action: 'delete', reason: 'Not an action.' },
      { action: 'requeue', reason: '' },
      { action: 'requeue' },
      { action: 'resume', reason: 'No such allowance.', allowance: {} },
      { action: 'resume', reason: 'Above the base limit.', allowance: { steps: 9 } },
      { action: 'resume', reason: 'Below the minimum.', allowance: { activeMs: 10 } },
      { action: 'resume', reason: 'An unknown limit.', allowance: { retriesPerCall: 1 } },
      { action: 'requeue', reason: 'Extra field.', approve: true },
    ]) {
      assertProblem(await post(body), 400, 'validation_failed');
    }

    const needsAllowance = await post({ action: 'resume', reason: 'No allowance was named.' });
    assertProblem(needsAllowance, 400, 'validation_failed');
    assert.deepEqual(jsonBody<Schemas['Problem']>(needsAllowance).errors?.map((error) => [error.pointer, error.code]), [['/allowance', 'allowance_required']]);
    const notApplicable = await post({ action: 'requeue', reason: 'A requeue grants nothing.', allowance: { steps: 1 } });
    assertProblem(notApplicable, 400, 'validation_failed');
    assert.deepEqual(jsonBody<Schemas['Problem']>(notApplicable).errors?.map((error) => [error.pointer, error.code]), [['/allowance', 'allowance_not_applicable']]);

    assert.deepEqual(await etagsOf(TENANT, scene.poisoned.caseId), before, 'nothing was written');
    assert.equal((await listedIn('poison', workId))?.attempts, 1, 'the poisoned item is as it was');
  });
});
