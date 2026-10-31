import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import { BASE_RUN_LIMITS, CASE_LIMITS } from '../../src/config/limits.ts';
import { identity, objectIdFor, type Api, type Identity } from '../support/api.ts';
import { assertProblem } from '../support/assertions.ts';
import { approver, docsOfType, DUPLICATE, newKey, operator, OUTBOX_ID, representative, TENANT, usd, type Schemas } from '../support/case-flow.ts';
import { restartHost } from '../support/control.ts';
import { creditFlow, expectOk, expectProblem, foreignOperator, type RecoverRequest, type Run } from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';

/**
 * A run that spends its allowance stops before the next call, and only an operator can give it more. The host is
 * restarted with a step limit of three, so a four-call investigation cannot finish; the cases of this file are
 * the only ones made while that limit holds, and the host goes back to its normal limits when the file is done.
 */

const STEP_LIMIT = 3;
const RESUME_STEPS = BASE_RUN_LIMITS.steps;
const RUN_ID = 'run-1';
const REASON = 'The investigation needs more steps than its first allowance gave it.';

const FIRST_CALL = 'get_account';
/** The calls the demo investigator makes for a case that cites two invoices. */
const PLAN: readonly string[] = [FIRST_CALL, 'get_policy', 'get_invoice', 'get_invoice', 'submit_proposal'];

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;

after(
  async () => {
    try {
      await restartHost(process.env, undefined, { settings: {} });
    } finally {
      cosmos.dispose();
    }
  },
  { timeout: 360_000 },
);

const flow = creditFlow(() => ({ stack, api, cosmos }));
const { admission, allWork, awaitCase, awaitCompletedOutbox, awaitOutbox, awaitWork, createCase, credited, creditsOf, etagsOf, getCase, getProposal, inspect, kindsOf, recover, storedDocs, timelineOf, usagePages, workIdOf } = flow;

type Allowance = Schemas['Allowance'];

const operatorB = identity(TENANT, 'Operator', 'b');
const resumeOutboxId = (grant: number): string => `${OUTBOX_ID}-g${String(grant)}`;
const sequence = (length: number): number[] => Array.from({ length }, (_, index) => index + 1);

function resume(who: Identity, workId: string, allowance?: Allowance) {
  const body: RecoverRequest = allowance === undefined ? { action: 'resume', reason: REASON } : { action: 'resume', reason: REASON, allowance };
  return recover(who, workId, body);
}

async function runOf(caseId: string): Promise<Run> {
  const { data, response } = await api.client(representative).GET('/cases/{caseId}/runs/{runId}', { params: { path: { caseId, runId: RUN_ID } } });
  assert.equal(response.status, 200);
  assert.ok(data);
  return data;
}

async function holdsSlot(caseId: string): Promise<boolean> {
  return (await admission(TENANT))?.slots.some((slot) => slot.runKey === `${caseId}:${RUN_ID}`) ?? false;
}

async function usageNames(caseId: string): Promise<string[]> {
  return (await usagePages(representative, caseId, RUN_ID, 3)).flat().map((event) => event.name);
}

interface Stopped {
  readonly caseId: string;
  readonly workId: string;
}

/** A case whose first run spent its step allowance, with the work item that ran it finished. */
async function stopped(label: string): Promise<Stopped> {
  const { accepted } = await createCase(representative, newKey(label), DUPLICATE);
  const caseId = accepted.case.caseId;
  const { limits } = await runOf(caseId);
  assert.equal(limits.steps, STEP_LIMIT, `the restarted host did not give the new run its step limit (limits ${JSON.stringify(limits)})`);
  await awaitCase(representative, caseId, 'needs_attention', 150_000).catch(async (error: unknown) => {
    const run = await runOf(caseId);
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`${cause} (the run is ${run.state} after ${String(run.usage.steps)} of ${String(run.limits.steps)} steps)`, { cause: error });
  });
  await awaitCompletedOutbox(caseId);
  return { caseId, workId: workIdOf(caseId, RUN_ID) };
}

interface Scene {
  readonly stopped: Stopped;
  readonly resumable: Stopped;
  readonly limited: Stopped;
  readonly contested: Stopped;
}

let scene: Scene;

// The hooks of a file start together, so the restart and the cases that need it must share one.
before(
  async () => {
    stack = readStackConnection();
    api = connectApi(stack);
    cosmos = openEmulator(stack);
    await restartHost(process.env, undefined, { settings: { RESOLVE_LIMIT_RUN_STEPS: String(STEP_LIMIT) } });

    const [first, second, third, fourth] = await Promise.all([stopped('bud-stop'), stopped('bud-resume'), stopped('bud-grants'), stopped('bud-race')]);
    scene = { stopped: first, resumable: second, limited: third, contested: fourth };
  },
  { timeout: 600_000 },
);

describe('a run that spends its step allowance', () => {
  it('stops before the next call, keeps what it did and makes no proposal', { timeout: 60_000 }, async () => {
    const { caseId } = scene.stopped;

    const run = await runOf(caseId);
    assert.equal(run.state, 'budget_exhausted');
    assert.equal(run.stopReason, 'steps_exhausted');
    assert.equal(run.limits.steps, STEP_LIMIT, 'the run carries the limit it was created with');
    assert.equal(run.usage.steps, STEP_LIMIT, 'the call that would have been the fourth step was never made or counted');
    assert.equal(run.usage.toolCalls, STEP_LIMIT);
    assert.equal(run.allowanceGrants, 0);
    assert.ok(run.startedAt && run.finishedAt);

    const detail = await getCase(representative, caseId);
    assert.equal(detail.status, 'needs_attention');
    assert.equal(detail.latestProposal, null);
    assertProblem(await api.get(`/api/cases/${caseId}/proposals/1`, { as: representative }), 404, 'not_found');

    const events = (await usagePages(representative, caseId, RUN_ID, 2)).flat();
    assert.deepEqual(
      events.map((event) => [event.seq, event.name, event.outcome]),
      PLAN.slice(0, STEP_LIMIT).map((name, index) => [index + 1, name, 'succeeded']),
    );

    const timeline = await timelineOf(representative, caseId);
    const kinds = timeline.map((item) => item.kind);
    assert.equal(kinds.filter((kind) => kind === 'run_budget_exhausted').length, 1);
    assert.equal(kinds.at(-1), 'run_budget_exhausted');
    assert.ok(!kinds.includes('proposal_submitted'), 'nothing was proposed');
    const stop = timeline.find((item) => item.kind === 'run_budget_exhausted');
    assert.equal(stop?.actor.type, 'system');
    assert.equal(stop?.data?.['reason'], 'steps_exhausted');

    assert.equal(await holdsSlot(caseId), false, 'a stopped run holds no concurrency slot');
  });

  it('is listed for the operator as budget exhausted, offering only a resume', { timeout: 90_000 }, async () => {
    const { caseId, workId } = scene.stopped;
    const run = await runOf(caseId);

    const listed = await awaitWork(operator, 'budget_exhausted', workId);
    assert.equal(listed.kind, 'investigation_run');
    assert.equal(listed.state, 'budget_exhausted');
    assert.equal(listed.caseId, caseId);
    assert.equal(listed.attempts, 1);
    assert.deepEqual(listed.actions, ['resume']);
    assert.deepEqual(listed.lastError, { code: 'steps_exhausted', message: 'The run used its step allowance.' });
    assert.equal(listed.summary, `Run ${RUN_ID} stopped at its allowance (steps_exhausted); 0 of ${String(CASE_LIMITS.resumeGrantsPerRun)} resume grants used.`);
    assert.equal(listed.claimedUntil, null);
    assert.equal(listed.createdAt, run.createdAt);
    assert.deepEqual(listed.usage, run.usage);

    assert.deepEqual(expectOk(await inspect(operator, workId), 200), listed, 'inspecting the item shows what the listing shows');
    for (const state of ['failed', 'waiting'] as const) {
      assert.equal((await allWork(operator, state)).some((item) => item.workId === workId), false, `a run that ran out of allowance is not ${state}`);
    }
  });
});

describe('a resume that is refused', () => {
  it('changes nothing', { timeout: 90_000 }, async () => {
    const { caseId, workId } = scene.stopped;
    const runBefore = await runOf(caseId);
    const etagsBefore = await etagsOf(TENANT, caseId);

    expectProblem(await resume(representative, workId, { steps: 1 }), 403, 'forbidden_role');
    expectProblem(await resume(approver, workId, { steps: 1 }), 403, 'forbidden_role');
    expectProblem(await resume(foreignOperator, workId, { steps: 1 }), 404, 'not_found');

    const needsAllowance = await resume(operator, workId);
    expectProblem(needsAllowance, 400, 'validation_failed');
    assert.deepEqual(needsAllowance.problem?.errors?.map((error) => [error.pointer, error.code]), [['/allowance', 'allowance_required']]);
    const notApplicable = await recover(operator, workId, { action: 'requeue', reason: REASON, allowance: { steps: 1 } });
    expectProblem(notApplicable, 400, 'validation_failed');
    assert.deepEqual(notApplicable.problem?.errors?.map((error) => [error.pointer, error.code]), [['/allowance', 'allowance_not_applicable']]);

    expectProblem(await resume(operator, workId, { steps: 0 }), 400, 'validation_failed');
    expectProblem(await resume(operator, workId, { steps: RESUME_STEPS + 1 }), 400, 'validation_failed');
    expectProblem(await resume(operator, workId, { tokens: 100 }), 409, 'allowance_does_not_cover_stop');
    expectProblem(await recover(operator, workId, { action: 'requeue', reason: REASON }), 409, 'recovery_not_applicable');

    assert.deepEqual(await etagsOf(TENANT, caseId), etagsBefore, 'nothing was written');
    assert.deepEqual(await runOf(caseId), runBefore, 'the run is as it was');
    assert.equal(await holdsSlot(caseId), false, 'a refused resume takes no concurrency slot');
    assert.deepEqual(expectOk(await inspect(operator, workId), 200).actions, ['resume'], 'it can still be resumed');
  });
});

describe('a resume that is allowed', () => {
  it('carries every counter over, plays the plan again and still waits for a person to approve', { timeout: 300_000 }, async () => {
    const { caseId, workId } = scene.resumable;
    const before = await runOf(caseId);
    assert.equal(before.usage.steps, STEP_LIMIT);

    const accepted = expectOk(await resume(operator, workId, { steps: RESUME_STEPS }), 202);
    assert.deepEqual(accepted, { workId, action: 'resume', state: 'budget_exhausted', grantNumber: 1 });

    await awaitCase(representative, caseId, 'awaiting_approval', 120_000);
    await awaitOutbox(caseId, resumeOutboxId(1), 'completed');

    const run = await runOf(caseId);
    assert.equal(run.state, 'completed');
    assert.equal(run.stopReason, null);
    assert.equal(run.allowanceGrants, 1);
    assert.equal(run.limits.steps, STEP_LIMIT + RESUME_STEPS, 'the grant is added to the limit the run had');
    assert.equal(run.usage.steps, STEP_LIMIT + PLAN.length, 'the steps spent before the stop still count');
    assert.equal(run.usage.toolCalls, STEP_LIMIT + PLAN.length);
    assert.equal(run.createdAt, before.createdAt);
    assert.equal(run.startedAt, before.startedAt, 'the run keeps the time it first started');

    const events = (await usagePages(representative, caseId, RUN_ID, 3)).flat();
    assert.deepEqual(
      events.map((event) => event.seq),
      sequence(STEP_LIMIT + PLAN.length),
      'the usage history goes on from where it stopped',
    );
    assert.deepEqual(
      events.map((event) => event.name),
      [...PLAN.slice(0, STEP_LIMIT), ...PLAN],
      'what ran before the stop, then the whole plan again',
    );
    assert.ok(events.every((event) => event.outcome === 'succeeded'));

    const timeline = await timelineOf(representative, caseId);
    const resumed = timeline.filter((item) => item.kind === 'run_resumed');
    assert.equal(resumed.length, 1);
    assert.deepEqual(resumed[0]?.actor, { type: 'user', id: objectIdFor(operator.label) });
    assert.equal(resumed[0]?.data?.['grant'], 1);
    assert.equal(resumed[0]?.data?.['grantedSteps'], RESUME_STEPS);
    assert.equal(resumed[0]?.data?.['reason'], REASON);
    assert.deepEqual(
      timeline.filter((item) => item.kind === 'run_started').map((item) => item.data?.['resumed']),
      [false, true],
    );

    const docs = await storedDocs(TENANT, caseId);
    assert.deepEqual(
      docsOfType(docs, 'outbox')
        .map((doc) => [doc.id, doc.kind, doc.state])
        .sort(),
      [
        [OUTBOX_ID, 'investigation.start', 'completed'],
        [resumeOutboxId(1), 'investigation.start', 'completed'],
      ],
    );
    assert.equal(await holdsSlot(caseId), false, 'the finished run holds no concurrency slot');
    assert.deepEqual(await creditsOf(caseId), [], 'a resume issues nothing');
    assert.ok(!docs.some((doc) => doc.id === 'credit-result'));

    assert.equal((await allWork(operator, 'budget_exhausted')).some((item) => item.workId === workId), false, 'the run no longer waits for an operator');
    expectProblem(await inspect(operator, workId), 404, 'not_found');
    assert.equal((await awaitWork(operator, 'completed', workIdOf(caseId, resumeOutboxId(1)))).kind, 'outbox');
    assert.ok(!(await kindsOf(representative, caseId)).includes('decision_approved'));

    const proposal = await getProposal(representative, caseId, 1);
    assert.equal(proposal.status, 'pending_approval');
    assert.equal(proposal.runId, RUN_ID);
    assert.deepEqual(proposal.amount, usd(4900));
    const credit = await credited({ caseId, proposal });
    assert.deepEqual(credit.amount, usd(4900));
    assert.equal((await creditsOf(caseId)).length, 1, 'one credit, and only after the approval');
  });
});

describe('resume grants', () => {
  it('are limited to two per run, and each is added to the limits the run already has', { timeout: 360_000 }, async () => {
    const { caseId, workId } = scene.limited;

    for (let grant = 1; grant <= CASE_LIMITS.resumeGrantsPerRun; grant += 1) {
      const accepted = expectOk(await resume(operator, workId, { steps: 1 }), 202);
      assert.equal(accepted.grantNumber, grant);
      await awaitCase(representative, caseId, 'needs_attention', 120_000);
      await awaitOutbox(caseId, resumeOutboxId(grant), 'completed');

      const run = await runOf(caseId);
      assert.equal(run.state, 'budget_exhausted');
      assert.equal(run.stopReason, 'steps_exhausted');
      assert.equal(run.allowanceGrants, grant);
      assert.equal(run.limits.steps, STEP_LIMIT + grant, 'every grant adds to the limit the run has');
      assert.equal(run.usage.steps, STEP_LIMIT + grant, 'the plan starts again, so each grant buys the one step it names');

      const listed = await awaitWork(operator, 'budget_exhausted', workId);
      assert.equal(listed.attempts, grant + 1);
      assert.equal(listed.summary, `Run ${RUN_ID} stopped at its allowance (steps_exhausted); ${String(grant)} of ${String(CASE_LIMITS.resumeGrantsPerRun)} resume grants used.`);
      assert.deepEqual(listed.actions, grant < CASE_LIMITS.resumeGrantsPerRun ? ['resume'] : []);
    }

    const etagsBefore = await etagsOf(TENANT, caseId);
    const runBefore = await runOf(caseId);
    expectProblem(await resume(operator, workId, { steps: 1 }), 409, 'resume_grants_exhausted');
    assert.deepEqual(await etagsOf(TENANT, caseId), etagsBefore, 'nothing was written');
    assert.deepEqual(await runOf(caseId), runBefore);
    assert.equal(await holdsSlot(caseId), false);

    assert.deepEqual((await usagePages(representative, caseId, RUN_ID, 50)).flat().map((event) => event.seq), sequence(STEP_LIMIT + CASE_LIMITS.resumeGrantsPerRun));
    assert.deepEqual(await usageNames(caseId), [...PLAN.slice(0, STEP_LIMIT), FIRST_CALL, FIRST_CALL]);
    const grants = (await timelineOf(representative, caseId)).filter((item) => item.kind === 'run_resumed');
    assert.deepEqual(
      grants.map((item) => item.data?.['grant']),
      [1, 2],
    );
  });
});

describe('operators resuming the same run at once', () => {
  it('spend one grant and start one run', { timeout: 300_000 }, async () => {
    const { caseId, workId } = scene.contested;

    const callers = [operator, operatorB, operator, operatorB];
    const results = await Promise.all(callers.map((who) => resume(who, workId, { steps: RESUME_STEPS })));

    assert.ok(
      results.some((result) => result.status === 202),
      'one of them wins',
    );
    for (const result of results) {
      if (result.status === 202) {
        assert.deepEqual(result.data, { workId, action: 'resume', state: 'budget_exhausted', grantNumber: 1 });
      } else {
        assert.equal(result.status, 409, JSON.stringify(result.problem));
        assert.ok(['recovery_not_applicable', 'concurrent_update'].includes(result.problem?.code ?? ''), `unexpected refusal ${JSON.stringify(result.problem)}`);
      }
    }

    await awaitCase(representative, caseId, 'awaiting_approval', 120_000);
    await awaitOutbox(caseId, resumeOutboxId(1), 'completed');

    const run = await runOf(caseId);
    assert.equal(run.state, 'completed');
    assert.equal(run.allowanceGrants, 1, 'one grant was spent');
    assert.equal(run.limits.steps, STEP_LIMIT + RESUME_STEPS, 'the allowance was added once');
    assert.equal(run.usage.steps, STEP_LIMIT + PLAN.length);

    const timeline = await timelineOf(representative, caseId);
    assert.equal(timeline.filter((item) => item.kind === 'run_resumed').length, 1);
    assert.equal(timeline.filter((item) => item.kind === 'run_started').length, 2, 'the run was started once more, not once per request');
    const docs = await storedDocs(TENANT, caseId);
    assert.deepEqual(docsOfType(docs, 'outbox').map((doc) => doc.id).sort(), [OUTBOX_ID, resumeOutboxId(1)]);
    assert.equal(docsOfType(docs, 'proposal').length, 1);
    assert.deepEqual(await usageNames(caseId), [...PLAN.slice(0, STEP_LIMIT), ...PLAN]);
    assert.equal(await holdsSlot(caseId), false, 'no request left a concurrency slot behind');
  });
});
