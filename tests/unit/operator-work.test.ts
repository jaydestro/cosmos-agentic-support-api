import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXHAUSTION_REASONS } from '../../src/agent/budget.ts';
import { STOP_DIMENSION } from '../../src/cases/recover.ts';
import { workIdOf } from '../../src/cases/work.ts';
import { BASE_RUN_LIMITS, OUTBOX_LIMITS, RECOVERABLE_GRACE_MS } from '../../src/config/limits.ts';
import { encodeCursor } from '../../src/http/cursor.ts';
import { newCaseId } from '../support/case-fixtures.ts';
import {
  actors,
  allWork,
  approve,
  awaitingApproval,
  creditedCase,
  creditWorkId,
  expectProblem,
  inspectWork,
  investigationWorkId,
  listWork,
  ok,
  openCase,
  proposalWorkId,
  recover,
  reject,
  runWorkId,
  tamper,
  type Actors,
  type DecisionAcceptedView,
  type DecisionView,
  type Harness,
  type Page,
  type Pending,
  type WorkView,
} from '../support/decision-flow.ts';
import { BASE_CONFIG, contract, harness, NOW } from '../support/handler-harness.ts';
import { batchCount, claimCredit, CREDIT_OUTBOX_ID, exhaustedRun, poisonedCredit, snapshot, stoppedAt } from '../support/operator-flow.ts';

const STATES = ['waiting', 'failed', 'poison', 'recoverable', 'budget_exhausted', 'completed'] as const;
const ALLOWANCE_KEYS = ['steps', 'toolCalls', 'modelCalls', 'tokens', 'costMicroUsd', 'activeMs'] as const;
const ALLOWANCE_FLOOR = { steps: 1, toolCalls: 1, modelCalls: 1, tokens: 1, costMicroUsd: 1, activeMs: 1_000 } as const;

const BOREALIS_REPRESENTATIVE_ID = '00000000-0000-4000-8000-0000000000d3';
const BOREALIS_DUPLICATE = {
  accountId: 'acct_borealis_0001',
  category: 'duplicate_charge',
  description: 'Charged twice in September.',
  invoiceIds: ['inv_borealis_0001_a', 'inv_borealis_0001_b'],
  requestedCredit: { amountMinor: 5900, currency: 'EUR' },
};

const ids = (items: readonly WorkView[]): string[] => items.map((item) => item.workId).sort();
const sorted = (...workIds: string[]): string[] => [...workIds].sort();

/** Opens a case of the other tenant and delivers its investigation, which ends with a credit proposal. */
async function borealisCase(who: Actors): Promise<string> {
  const representative = harness({
    world: who.world,
    tenant: 'borealis',
    principalId: BOREALIS_REPRESENTATIVE_ID,
    roles: ['Representative'],
    config: { tenantLimits: { ...BASE_CONFIG.tenantLimits, concurrentRuns: 10 } },
  });
  const reply = await representative.call('createCase', { headers: { 'Idempotency-Key': who.nextKey() }, body: BOREALIS_DUPLICATE });
  const { caseId } = ok<{ case: { caseId: string } }>(reply, 202).case;
  await who.representative.drain();
  return caseId;
}

/** Opens cases whose proposals wait for a decision, each created one second after the one before it. */
async function waitingProposals(who: Actors, count: number): Promise<Pending[]> {
  const found: Pending[] = [];
  for (let index = 0; index < count; index += 1) {
    found.push(await awaitingApproval(who));
    who.world.clock.advance(1_000);
  }
  return found;
}

async function pagesOf(h: Harness, state: string, limit: number): Promise<Page<WorkView>[]> {
  const pages: Page<WorkView>[] = [];
  let token: string | null = null;
  do {
    const query: Record<string, string> = token === null ? { limit: String(limit) } : { limit: String(limit), continuationToken: token };
    const page = ok<Page<WorkView>>(await listWork(h, state, query));
    pages.push(page);
    token = page.continuationToken;
  } while (token !== null);
  return pages;
}

describe('operator work listing', () => {
  describe('work that waits for a human', () => {
    it('lists a proposal that awaits a decision, until its window closes', async () => {
      const who = actors();
      const { caseId, proposal } = await awaitingApproval(who);
      assert.ok(proposal.approvalExpiresAt);

      const [item, ...rest] = await allWork(who.operator, 'waiting');
      assert.deepEqual(rest, []);
      assert.equal(item?.workId, proposalWorkId(caseId));
      assert.equal(item.caseId, caseId);
      assert.equal(item.kind, 'proposal_approval');
      assert.equal(item.state, 'waiting');
      assert.equal(item.summary, `Credit proposal v1 of USD 49.00 awaits a human decision until ${proposal.approvalExpiresAt}.`);
      assert.equal(item.attempts, 0);
      assert.equal(item.lastError, null);
      assert.equal(item.claimedUntil, null);
      assert.equal(item.usage, null);
      assert.deepEqual(item.actions, []);

      const deadline = Date.parse(proposal.approvalExpiresAt);
      who.world.clock.set(new Date(deadline - 1));
      assert.deepEqual(ids(await allWork(who.operator, 'waiting')), [proposalWorkId(caseId)]);
      who.world.clock.set(new Date(deadline));
      assert.deepEqual(await allWork(who.operator, 'waiting'), []);
      expectProblem(await inspectWork(who.operator, proposalWorkId(caseId)), 404, 'not_found');
    });

    it('stops listing a proposal once it is approved or rejected', async () => {
      const who = actors();
      const first = await awaitingApproval(who);
      const second = await awaitingApproval(who);
      const third = await awaitingApproval(who);
      assert.equal((await allWork(who.operator, 'waiting')).length, 3);

      ok<DecisionAcceptedView>(await approve(who.approver, first), 202);
      ok<DecisionView>(await reject(who.approver, second));

      assert.deepEqual(ids(await allWork(who.operator, 'waiting')), [proposalWorkId(third.caseId)]);
    });
  });

  describe('work that stopped', () => {
    it('lists a run that stopped at its allowance, with the usage it used and the resume it allows', async () => {
      const who = stoppedAt({ steps: 2 });
      const caseId = await exhaustedRun(who);

      const [item, ...rest] = await allWork(who.operator, 'budget_exhausted');
      assert.deepEqual(rest, []);
      assert.equal(item?.workId, runWorkId(caseId));
      assert.equal(item.kind, 'investigation_run');
      assert.equal(item.state, 'budget_exhausted');
      assert.equal(item.summary, 'Run run-1 stopped at its allowance (steps_exhausted); 0 of 2 resume grants used.');
      assert.equal(item.attempts, 1);
      assert.deepEqual(item.lastError, { code: 'steps_exhausted', message: 'The run used its step allowance.' });
      assert.equal(item.claimedUntil, null);
      assert.equal(item.usage?.steps, 2);
      assert.equal(item.usage.toolCalls, 2);
      assert.equal(item.usage.modelCalls, 0);
      assert.deepEqual(item.actions, ['resume']);
    });

    it('lists a failed run and a blocked run, and offers no action for either', async () => {
      const who = actors();
      const failed = await awaitingApproval(who);
      const blocked = await awaitingApproval(who);
      await tamper(who, failed.caseId, 'run', 'run-1', (run) => {
        run.state = 'failed';
        run.stopReason = 'tool_error';
      });
      await tamper(who, blocked.caseId, 'run', 'run-1', (run) => {
        run.state = 'blocked';
        run.stopReason = 'live_not_approved';
      });

      const items = await allWork(who.operator, 'failed');
      assert.deepEqual(ids(items), sorted(runWorkId(failed.caseId), runWorkId(blocked.caseId)));
      const byId = new Map(items.map((item) => [item.workId, item]));
      assert.equal(byId.get(runWorkId(failed.caseId))?.summary, 'Run run-1 failed: tool_error.');
      assert.equal(byId.get(runWorkId(blocked.caseId))?.summary, 'Run run-1 was blocked: live_not_approved.');
      for (const item of items) {
        assert.equal(item.kind, 'investigation_run');
        assert.equal(item.state, 'failed');
        assert.deepEqual(item.actions, []);
      }
    });

    it('lists poisoned credit work with its error and attempts, and the requeue it allows', async () => {
      const who = actors();
      const caseId = await poisonedCredit(who);

      const [item, ...rest] = await allWork(who.operator, 'poison');
      assert.deepEqual(rest, []);
      assert.equal(item?.workId, creditWorkId(caseId));
      assert.equal(item.kind, 'outbox');
      assert.equal(item.state, 'poison');
      assert.ok(item.summary.includes(CREDIT_OUTBOX_ID));
      assert.equal(item.attempts, 1);
      assert.deepEqual(item.lastError, {
        code: 'provider_key_conflict',
        message: 'The provider already holds this credit key for a different credit.',
      });
      assert.equal(item.claimedUntil, null);
      assert.deepEqual(item.actions, ['requeue']);
    });

    it('lists a claim only once its lease has lapsed', async () => {
      const who = actors();
      const pending = await awaitingApproval(who);
      ok<DecisionAcceptedView>(await approve(who.approver, pending), 202);
      const claim = await claimCredit(who, pending.caseId);

      who.world.clock.advance(OUTBOX_LIMITS.claimLeaseMs - 1);
      assert.deepEqual(await allWork(who.operator, 'recoverable'), []);
      expectProblem(await inspectWork(who.operator, creditWorkId(pending.caseId)), 404, 'not_found');

      who.world.clock.advance(1);
      const [item, ...rest] = await allWork(who.operator, 'recoverable');
      assert.deepEqual(rest, []);
      assert.equal(item?.workId, creditWorkId(pending.caseId));
      assert.equal(item.state, 'recoverable');
      assert.equal(item.attempts, 1);
      assert.equal(item.claimedUntil, claim.claimedUntil);
      assert.equal(item.lastError, null);
      assert.deepEqual(item.actions, ['requeue']);
    });

    it('lists work that was never delivered only after the grace period', async () => {
      const who = actors();
      const pending = await awaitingApproval(who);
      ok<DecisionAcceptedView>(await approve(who.approver, pending), 202);

      who.world.clock.advance(RECOVERABLE_GRACE_MS);
      assert.deepEqual(await allWork(who.operator, 'recoverable'), []);

      who.world.clock.advance(1);
      const [item, ...rest] = await allWork(who.operator, 'recoverable');
      assert.deepEqual(rest, []);
      assert.equal(item?.workId, creditWorkId(pending.caseId));
      assert.equal(item.attempts, 0);
      assert.equal(item.claimedUntil, null);
      assert.deepEqual(item.actions, ['requeue']);
    });

    it('does not list work that is retrying on its own', async () => {
      const who = actors();
      const pending = await awaitingApproval(who);
      ok<DecisionAcceptedView>(await approve(who.approver, pending), 202);
      who.world.provider.failNextIssues(1);
      assert.deepEqual(await who.approver.drain(), ['retry_scheduled']);

      for (const state of ['waiting', 'failed', 'poison', 'recoverable', 'budget_exhausted'] as const) {
        assert.deepEqual(await allWork(who.operator, state), [], state);
      }
      expectProblem(await inspectWork(who.operator, creditWorkId(pending.caseId)), 404, 'not_found');
    });
  });

  describe('finished work', () => {
    it('lists the outbox work of a credited case, which needs no action', async () => {
      const who = actors();
      const { caseId } = await creditedCase(who);

      const items = await allWork(who.operator, 'completed');
      assert.deepEqual(ids(items), sorted(creditWorkId(caseId), investigationWorkId(caseId)));
      for (const item of items) {
        assert.equal(item.kind, 'outbox');
        assert.equal(item.state, 'completed');
        assert.equal(item.attempts, 1);
        assert.equal(item.lastError, null);
        assert.deepEqual(item.actions, []);
      }
    });
  });

  describe('tenant scope', () => {
    it('shows an operator the work of the own tenant in every state, and nothing of another tenant', async () => {
      const who = actors();
      const credited = await creditedCase(who);
      const poisoned = await poisonedCredit(who);
      const waiting = await awaitingApproval(who);
      const failed = await awaitingApproval(who);
      await tamper(who, failed.caseId, 'run', 'run-1', (run) => {
        run.state = 'failed';
        run.stopReason = 'tool_error';
      });
      const stalled = await awaitingApproval(who);
      ok<DecisionAcceptedView>(await approve(who.approver, stalled), 202);
      await claimCredit(who, stalled.caseId);
      who.world.clock.advance(OUTBOX_LIMITS.claimLeaseMs);
      const foreign = await borealisCase(who);

      const own = (state: string) => allWork(who.operator, state);
      assert.deepEqual(ids(await own('waiting')), sorted(proposalWorkId(waiting.caseId), proposalWorkId(failed.caseId)));
      assert.deepEqual(ids(await own('poison')), [creditWorkId(poisoned)]);
      assert.deepEqual(ids(await own('recoverable')), [creditWorkId(stalled.caseId)]);
      assert.deepEqual(ids(await own('failed')), [runWorkId(failed.caseId)]);
      assert.deepEqual(await own('budget_exhausted'), []);
      assert.deepEqual(
        ids(await own('completed')),
        sorted(
          creditWorkId(credited.caseId),
          investigationWorkId(credited.caseId),
          investigationWorkId(poisoned),
          investigationWorkId(waiting.caseId),
          investigationWorkId(failed.caseId),
          investigationWorkId(stalled.caseId),
        ),
      );

      const theirs = (state: string) => allWork(who.foreignOperator, state);
      assert.deepEqual(ids(await theirs('waiting')), [proposalWorkId(foreign)]);
      assert.deepEqual(ids(await theirs('completed')), [investigationWorkId(foreign)]);
      for (const state of ['failed', 'poison', 'recoverable', 'budget_exhausted'] as const) {
        assert.deepEqual(await theirs(state), [], state);
      }
    });

    it('hides a run that waits for an allowance from an operator of another tenant', async () => {
      const who = stoppedAt({ steps: 2 });
      const caseId = await exhaustedRun(who);
      assert.deepEqual(ids(await allWork(who.operator, 'budget_exhausted')), [runWorkId(caseId)]);
      for (const state of STATES) {
        assert.deepEqual(await allWork(who.foreignOperator, state), [], state);
      }
    });
  });
});

describe('the listing request', () => {
  it('refuses a request without a state, or with one that is not a kind of work', async () => {
    const { operator } = actors();
    expectProblem(await operator.call('listOperatorWork', { query: {} }), 400, 'validation_failed');
    expectProblem(await listWork(operator, 'bogus'), 400, 'validation_failed');
    expectProblem(await listWork(operator, 'WAITING'), 400, 'validation_failed');
  });

  it('refuses a page size outside 1 to 50 and accepts the limits themselves', async () => {
    const { operator } = actors();
    for (const limit of ['0', '51', '-1', '2.5', 'many']) {
      expectProblem(await listWork(operator, 'waiting', { limit }), 400, 'validation_failed');
    }
    for (const limit of ['1', '50']) {
      assert.deepEqual(ok<Page<WorkView>>(await listWork(operator, 'waiting', { limit })), { items: [], continuationToken: null });
    }
  });

  it('refuses a token that is not shaped like one', async () => {
    const { operator } = actors();
    expectProblem(await listWork(operator, 'waiting', { continuationToken: '!!!' }), 400, 'validation_failed');
  });

  it('refuses a token that is well formed but is not a cursor of this listing', async () => {
    const { operator } = actors();
    const key = `${NOW.toISOString()}~${newCaseId()}~proposal-1`;
    const forged = {
      'text that is not JSON': 'AAAA',
      'JSON that is not an object': Buffer.from('7').toString('base64url'),
      'a cursor of another version': Buffer.from(JSON.stringify({ v: 2, k: key })).toString('base64url'),
      'a key that is not a work key': encodeCursor('not-a-work-key'),
      'a work key with extra text': encodeCursor(`${key}~extra`),
    };
    for (const [description, token] of Object.entries(forged)) {
      const problem = expectProblem(await listWork(operator, 'waiting', { continuationToken: token }), 400, 'invalid_continuation_token');
      assert.equal(problem.status, 400, description);
    }
  });

  it('treats a cursor as a position only: one before everything ends the list, one after everything starts it', async () => {
    const who = actors();
    const created = await waitingProposals(who, 2);
    const at = (iso: string) => encodeCursor(`${iso}~${newCaseId()}~proposal-1`);

    const before = ok<Page<WorkView>>(await listWork(who.operator, 'waiting', { continuationToken: at('2000-01-01T00:00:00.000Z') }));
    assert.deepEqual(before, { items: [], continuationToken: null });

    const after = ok<Page<WorkView>>(await listWork(who.operator, 'waiting', { continuationToken: at('2100-01-01T00:00:00.000Z') }));
    assert.deepEqual(ids(after.items), sorted(...created.map((pending) => proposalWorkId(pending.caseId))));
    assert.equal(after.continuationToken, null);
  });
});

describe('pagination', () => {
  it('pages through the work newest first and shows each item once', async () => {
    const who = actors();
    const created = await waitingProposals(who, 5);
    const newestFirst = created.map((pending) => proposalWorkId(pending.caseId)).reverse();

    const pages = await pagesOf(who.operator, 'waiting', 2);
    assert.deepEqual(
      pages.map((page) => page.items.length),
      [2, 2, 1],
    );
    assert.deepEqual(
      pages.flatMap((page) => page.items.map((item) => item.workId)),
      newestFirst,
    );
    assert.deepEqual(
      pages.map((page) => page.continuationToken === null),
      [false, false, true],
    );
  });

  it('ends a list on a full page without promising another', async () => {
    const who = actors();
    await waitingProposals(who, 5);

    const exact = await pagesOf(who.operator, 'waiting', 5);
    assert.equal(exact.length, 1);
    assert.equal(exact[0]?.items.length, 5);

    const short = await pagesOf(who.operator, 'waiting', 4);
    assert.deepEqual(
      short.map((page) => page.items.length),
      [4, 1],
    );

    const unbounded = ok<Page<WorkView>>(await listWork(who.operator, 'waiting'));
    assert.equal(unbounded.items.length, 5);
    assert.equal(unbounded.continuationToken, null);
  });

  it('keeps its place when work leaves the list or arrives between two pages', async () => {
    const who = actors();
    const created = await waitingProposals(who, 5);
    const newest = [...created].reverse();

    const first = ok<Page<WorkView>>(await listWork(who.operator, 'waiting', { limit: '2' }));
    assert.deepEqual(
      first.items.map((item) => item.workId),
      newest.slice(0, 2).map((pending) => proposalWorkId(pending.caseId)),
    );
    assert.ok(first.continuationToken);

    const heading = newest[2];
    assert.ok(heading);
    ok<DecisionView>(await reject(who.approver, heading));
    const arrived = await awaitingApproval(who);

    const second = ok<Page<WorkView>>(await listWork(who.operator, 'waiting', { limit: '5', continuationToken: first.continuationToken }));
    assert.deepEqual(
      second.items.map((item) => item.workId),
      newest.slice(3).map((pending) => proposalWorkId(pending.caseId)),
    );
    assert.equal(second.continuationToken, null);

    const fresh = await allWork(who.operator, 'waiting');
    assert.equal(fresh[0]?.workId, proposalWorkId(arrived.caseId));
    assert.equal(fresh.length, 5);
  });
});

describe('inspecting one item', () => {
  const LISTED = [
    {
      state: 'waiting',
      async setup() {
        const who = actors();
        const { caseId } = await awaitingApproval(who);
        return { who, workId: proposalWorkId(caseId) };
      },
    },
    {
      state: 'budget_exhausted',
      async setup() {
        const who = stoppedAt({ steps: 2 });
        return { who, workId: runWorkId(await exhaustedRun(who)) };
      },
    },
    {
      state: 'poison',
      async setup() {
        const who = actors();
        return { who, workId: creditWorkId(await poisonedCredit(who)) };
      },
    },
  ];

  for (const scenario of LISTED) {
    it(`returns the item the ${scenario.state} listing shows`, async () => {
      const { who, workId } = await scenario.setup();
      const [listed, ...rest] = await allWork(who.operator, scenario.state);
      assert.deepEqual(rest, []);
      assert.equal(listed?.workId, workId);
      assert.deepEqual(ok<WorkView>(await inspectWork(who.operator, workId)), listed);
    });
  }

  it('does not know work that is pending and not overdue', async () => {
    const who = actors();
    const caseId = await openCase(who);
    expectProblem(await inspectWork(who.operator, investigationWorkId(caseId)), 404, 'not_found');
  });

  it('does not know a claim whose lease is live', async () => {
    const who = actors();
    const pending = await awaitingApproval(who);
    ok<DecisionAcceptedView>(await approve(who.approver, pending), 202);
    await claimCredit(who, pending.caseId);
    expectProblem(await inspectWork(who.operator, creditWorkId(pending.caseId)), 404, 'not_found');
  });

  it('does not know a run that finished, or a document that is not work', async () => {
    const who = actors();
    const { caseId } = await awaitingApproval(who);
    expectProblem(await inspectWork(who.operator, runWorkId(caseId)), 404, 'not_found');
    expectProblem(await inspectWork(who.operator, workIdOf(caseId, 'case')), 404, 'not_found');
    expectProblem(await inspectWork(who.operator, workIdOf(caseId, 'tl-00001')), 404, 'not_found');
    expectProblem(await inspectWork(who.operator, proposalWorkId(caseId, 3)), 404, 'not_found');
    expectProblem(await inspectWork(who.operator, workIdOf(newCaseId(), 'proposal-1')), 404, 'not_found');
  });

  it('answers an operator of another tenant as if the work did not exist', async () => {
    const who = actors();
    const { caseId } = await awaitingApproval(who);
    expectProblem(await inspectWork(who.foreignOperator, proposalWorkId(caseId)), 404, 'not_found');
  });

  it('refuses an id the contract does not allow before looking anything up', async () => {
    const { operator } = actors();
    expectProblem(await inspectWork(operator, 'nonsense'), 400, 'validation_failed');
    expectProblem(await inspectWork(operator, `${newCaseId().toUpperCase()}~proposal-1`), 400, 'validation_failed');
  });
});

describe('who may use the operator routes', () => {
  it('refuses every route to anyone who is not an operator, and changes nothing', async () => {
    const who = actors();
    const { caseId } = await awaitingApproval(who);
    const workId = proposalWorkId(caseId);
    const batches = batchCount(who);
    const stored = snapshot(who, caseId);

    for (const caller of [who.representative, who.approver, who.secondApprover, who.dual, who.foreignApprover]) {
      expectProblem(await listWork(caller, 'waiting'), 403, 'forbidden_role');
      expectProblem(await inspectWork(caller, workId), 403, 'forbidden_role');
      expectProblem(await recover(caller, workId, { action: 'requeue', reason: 'Try again.' }), 403, 'forbidden_role');
    }

    assert.equal(batchCount(who), batches);
    assert.deepEqual(snapshot(who, caseId), stored);
  });

  it('answers a recovery by an operator of another tenant as if the work did not exist, and changes nothing', async () => {
    const who = stoppedAt({ steps: 2 });
    const caseId = await exhaustedRun(who);
    const workId = runWorkId(caseId);
    const batches = batchCount(who);
    const stored = snapshot(who, caseId);

    expectProblem(await recover(who.foreignOperator, workId, { action: 'resume', reason: 'Give it more room.', allowance: { steps: 8 } }), 404, 'not_found');
    expectProblem(await recover(who.foreignOperator, workId, { action: 'requeue', reason: 'Try again.' }), 404, 'not_found');

    assert.equal(batchCount(who), batches);
    assert.deepEqual(snapshot(who, caseId), stored);
  });
});

describe('the tables recovery relies on', () => {
  const RETRY_STOPS: readonly string[] = ['retries_per_call_exhausted', 'retries_exhausted'];

  it('give every stop except the retry limits a limit an allowance can raise', () => {
    const raisable = EXHAUSTION_REASONS.filter((reason) => !RETRY_STOPS.includes(reason));
    assert.deepEqual(Object.keys(STOP_DIMENSION).sort(), [...raisable].sort());
    for (const reason of RETRY_STOPS) assert.equal(STOP_DIMENSION[reason], undefined, reason);
  });

  it('name only limits the contract lets one grant carry', () => {
    for (const dimension of Object.values(STOP_DIMENSION)) {
      assert.deepEqual(contract.validateComponent('Allowance', { [dimension]: ALLOWANCE_FLOOR[dimension] }), [], dimension);
    }
  });

  it('bound one grant between a floor and the agreed run limit of each dimension', () => {
    for (const key of ALLOWANCE_KEYS) {
      const floor = ALLOWANCE_FLOOR[key];
      assert.deepEqual(contract.validateComponent('Allowance', { [key]: floor }), [], `${key} at its floor`);
      assert.notDeepEqual(contract.validateComponent('Allowance', { [key]: floor - 1 }), [], `${key} below its floor`);
      assert.deepEqual(contract.validateComponent('Allowance', { [key]: BASE_RUN_LIMITS[key] }), [], `${key} at its cap`);
      assert.notDeepEqual(contract.validateComponent('Allowance', { [key]: BASE_RUN_LIMITS[key] + 1 }), [], `${key} above its cap`);
    }
  });

  it('keep the grace for overdue work longer than any retry delay', () => {
    assert.ok(Math.max(...OUTBOX_LIMITS.backoffMs) < RECOVERABLE_GRACE_MS);
  });
});
