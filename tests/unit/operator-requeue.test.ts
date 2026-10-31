import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CASE_DOC_ID, runKeyFor } from '../../src/cases/documents.ts';
import { MAX_ATTEMPTS } from '../../src/cases/retry.ts';
import { CaseWriteError } from '../../src/cases/store.ts';
import { OUTBOX_LIMITS, RECOVERABLE_GRACE_MS } from '../../src/config/limits.ts';
import {
  actors,
  allWork,
  approve,
  awaitingApproval,
  caseOf,
  creditedCase,
  creditWorkId,
  expectProblem,
  investigationWorkId,
  kindsOf,
  messagesOf,
  ok,
  OPERATOR_ID,
  openCase,
  proposalWorkId,
  recover,
  runWorkId,
  tamper,
  timelineOf,
  type Actors,
  type DecisionAcceptedView,
  type RecoverAcceptedView,
  type TimelineView,
} from '../support/decision-flow.ts';
import type { CallOptions } from '../support/handler-harness.ts';
import {
  batchCount,
  batchesFor,
  claimCredit,
  commitCalls,
  creditOutbox,
  exhaustedRun,
  MARKER,
  opsOf,
  poisonedCredit,
  REASON,
  requeueBody,
  slotsOf,
  snapshot,
  startsOf,
  stoppedAt,
  transient,
} from '../support/operator-flow.ts';

const REQUEUE_OPS = ['replace:case', 'replace:outbox', 'create:timeline'];

const requeued = (workId: string, state: string): RecoverAcceptedView => ({ workId, action: 'requeue', state, grantNumber: null });

async function lastEntry(who: Actors, caseId: string): Promise<TimelineView> {
  const entry = (await timelineOf(who.operator, caseId)).at(-1);
  assert.ok(entry, 'the timeline has entries');
  return entry;
}

const requeueEntries = async (who: Actors, caseId: string): Promise<TimelineView[]> =>
  (await timelineOf(who.operator, caseId)).filter((item) => item.kind === 'work_requeued');

describe('requeueing work an operator found stuck', () => {
  describe('poisoned work', () => {
    it('puts the work back with a fresh attempt count, restores the case, and records who did it and why', async () => {
      const who = actors();
      const caseId = await poisonedCredit(who);
      const poisoned = structuredClone(creditOutbox(who, caseId));
      assert.equal(poisoned.state, 'poison');
      assert.equal(poisoned.attempts, 1);
      assert.equal((await caseOf(who.operator, caseId)).status, 'needs_attention');
      assert.equal((await allWork(who.operator, 'poison')).length, 1);

      who.world.clock.advance(5_000);
      const at = who.world.clock.now().toISOString();
      const workId = creditWorkId(caseId);
      const reply = await recover(who.operator, workId, requeueBody());
      assert.deepEqual(ok<RecoverAcceptedView>(reply, 202), requeued(workId, 'poison'));
      assert.deepEqual(opsOf(batchesFor(who, caseId).at(-1)), REQUEUE_OPS);

      const item = creditOutbox(who, caseId);
      assert.equal(item.state, 'pending');
      assert.equal(item.attempts, 0);
      assert.equal(item.claimedBy, null);
      assert.equal(item.claimedUntil, null);
      assert.equal(item.completedAt, null);
      assert.equal(item.notBefore, at);
      assert.equal(item.updatedAt, at);
      assert.deepEqual(item.lastError, poisoned.lastError, 'the last failure stays visible until the next outcome');
      assert.equal(item.createdAt, poisoned.createdAt);
      assert.equal(item.workKey, poisoned.workKey, 'the position in the operator list never changes');
      assert.deepEqual(item.payload, poisoned.payload);

      assert.equal((await caseOf(who.operator, caseId)).status, 'approved');
      assert.deepEqual(await allWork(who.operator, 'poison'), []);
      assert.deepEqual(await allWork(who.operator, 'recoverable'), []);

      const entry = await lastEntry(who, caseId);
      assert.equal(entry.kind, 'work_requeued');
      assert.equal(entry.actor.type, 'user');
      assert.equal(entry.actor.id, OPERATOR_ID);
      assert.equal(entry.summary, 'Operator requeued credit.execute work.');
      assert.deepEqual(entry.data, { workId, from: 'poison', attempts: 1, errorCode: 'provider_key_conflict', reason: REASON });

      assert.equal(messagesOf(who.operator.lines).filter((message) => message === 'work recovery accepted').length, 1);
      assert.ok(
        who.lines().every((line) => !line.includes(MARKER)),
        'what the operator wrote is stored with the case and never logged',
      );
    });

    it('poisons the work again, counting from zero, when the cause is still there, and accepts another requeue', async () => {
      const who = actors();
      const caseId = await poisonedCredit(who);
      const workId = creditWorkId(caseId);
      ok<RecoverAcceptedView>(await recover(who.operator, workId, requeueBody()), 202);
      assert.deepEqual(await who.operator.drain(), ['poisoned']);

      const item = creditOutbox(who, caseId);
      assert.equal(item.state, 'poison');
      assert.equal(item.attempts, 1, 'the second life started from zero attempts');
      assert.equal((await caseOf(who.operator, caseId)).status, 'needs_attention');
      assert.deepEqual(kindsOf((await timelineOf(who.operator, caseId)).slice(-3)), ['work_poisoned', 'work_requeued', 'work_poisoned']);
      assert.deepEqual(
        who.world.provider.credits().map((credit) => credit.amount.amountMinor),
        [100],
        'nothing was issued while the conflict stood',
      );

      ok<RecoverAcceptedView>(await recover(who.operator, workId, requeueBody('Trying once more.')), 202);
      assert.equal(creditOutbox(who, caseId).state, 'pending');
      assert.equal((await requeueEntries(who, caseId)).length, 2);
      assert.equal((await caseOf(who.operator, caseId)).status, 'approved');
    });
  });

  describe('work its worker left behind', () => {
    it('requeues work held by a worker that vanished once the claim has lapsed, and the credit is issued once', async () => {
      const who = actors();
      const pending = await awaitingApproval(who);
      const { caseId } = pending;
      ok<DecisionAcceptedView>(await approve(who.approver, pending), 202);
      await claimCredit(who, caseId);
      const workId = creditWorkId(caseId);

      who.world.clock.advance(OUTBOX_LIMITS.claimLeaseMs - 1);
      expectProblem(await recover(who.operator, workId, requeueBody()), 409, 'recovery_not_applicable');
      assert.deepEqual(await who.operator.drain(), [], 'a live claim is nobody else’s to deliver');

      who.world.clock.advance(1);
      assert.equal((await allWork(who.operator, 'recoverable')).length, 1);
      const reply = await recover(who.operator, workId, requeueBody());
      assert.deepEqual(ok<RecoverAcceptedView>(reply, 202), requeued(workId, 'recoverable'));
      assert.deepEqual(opsOf(batchesFor(who, caseId).at(-1)), REQUEUE_OPS);
      assert.equal(creditOutbox(who, caseId).claimedBy, null);
      assert.equal((await caseOf(who.operator, caseId)).status, 'approved', 'the case was never parked, so it keeps its status');
      assert.deepEqual(await allWork(who.operator, 'recoverable'), []);

      assert.deepEqual(await who.approver.drain(), ['completed']);
      assert.equal((await caseOf(who.operator, caseId)).status, 'credited');
      assert.equal(who.world.provider.credits().length, 1);
    });

    it('requeues work nobody delivered, but only once the grace period has passed', async () => {
      const who = actors();
      const pending = await awaitingApproval(who);
      const { caseId } = pending;
      ok<DecisionAcceptedView>(await approve(who.approver, pending), 202);
      const workId = creditWorkId(caseId);

      who.world.clock.advance(RECOVERABLE_GRACE_MS);
      expectProblem(await recover(who.operator, workId, requeueBody()), 409, 'recovery_not_applicable');

      who.world.clock.advance(1);
      const reply = await recover(who.operator, workId, requeueBody());
      assert.deepEqual(ok<RecoverAcceptedView>(reply, 202), requeued(workId, 'recoverable'));

      assert.deepEqual(await who.approver.drain(), ['completed']);
      assert.equal((await caseOf(who.operator, caseId)).status, 'credited');
      assert.equal(who.world.provider.credits().length, 1);
    });
  });

  describe('an investigation that could not start', () => {
    it('parks the case when the start is poisoned and sets it going again from the requeue once the cause is repaired', async () => {
      const who = actors();
      const caseId = await openCase(who);
      const workId = investigationWorkId(caseId);
      await tamper(who, caseId, 'case', CASE_DOC_ID, (doc) => {
        doc.latestRunId = 'run-2';
      });
      assert.deepEqual(await who.operator.drain(), ['poisoned']);

      const [start, ...others] = startsOf(who, caseId);
      assert.deepEqual(others, []);
      assert.equal(start?.state, 'poison');
      assert.equal(start.attempts, 1);
      assert.equal(start.lastError?.code, 'run_superseded');
      assert.equal((await caseOf(who.operator, caseId)).status, 'needs_attention');
      const notice = await lastEntry(who, caseId);
      assert.equal(notice.kind, 'work_poisoned');
      assert.equal(notice.actor.type, 'system');
      assert.deepEqual(notice.data, { workId, workKind: 'investigation.start', errorCode: 'run_superseded', attempts: 1 });
      assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-1')], 'the run never started, so it still holds its slot');

      await tamper(who, caseId, 'case', CASE_DOC_ID, (doc) => {
        doc.latestRunId = 'run-1';
      });
      const reply = await recover(who.operator, workId, requeueBody());
      assert.deepEqual(ok<RecoverAcceptedView>(reply, 202), requeued(workId, 'poison'));
      assert.equal((await caseOf(who.operator, caseId)).status, 'queued');
      const entry = await lastEntry(who, caseId);
      assert.equal(entry.kind, 'work_requeued');
      assert.equal(entry.summary, 'Operator requeued investigation.start work.');
      assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-1')], 'a requeue takes no second slot');

      assert.deepEqual(await who.operator.drain(), ['completed']);
      assert.equal((await caseOf(who.operator, caseId)).status, 'awaiting_approval');
      assert.deepEqual(slotsOf(who), [], 'the finished run freed its slot');
    });
  });

  describe('work that is not stuck', () => {
    interface Target {
      who: Actors;
      caseId: string;
      workId: string;
    }

    const NOT_STUCK: [string, () => Promise<Target>][] = [
      [
        'a proposal that waits for a decision',
        async () => {
          const who = actors();
          const { caseId } = await awaitingApproval(who);
          return { who, caseId, workId: proposalWorkId(caseId) };
        },
      ],
      [
        'an investigation that finished',
        async () => {
          const who = actors();
          const { caseId } = await awaitingApproval(who);
          return { who, caseId, workId: investigationWorkId(caseId) };
        },
      ],
      [
        'a credit that was issued',
        async () => {
          const who = actors();
          const { caseId } = await creditedCase(who);
          return { who, caseId, workId: creditWorkId(caseId) };
        },
      ],
      [
        'work that was not delivered yet',
        async () => {
          const who = actors();
          const caseId = await openCase(who);
          return { who, caseId, workId: investigationWorkId(caseId) };
        },
      ],
      [
        'work a live worker holds',
        async () => {
          const who = actors();
          const pending = await awaitingApproval(who);
          ok<DecisionAcceptedView>(await approve(who.approver, pending), 202);
          await claimCredit(who, pending.caseId);
          return { who, caseId: pending.caseId, workId: creditWorkId(pending.caseId) };
        },
      ],
      [
        'a run that stopped at its allowance',
        async () => {
          const who = stoppedAt({ steps: 2 });
          const caseId = await exhaustedRun(who);
          return { who, caseId, workId: runWorkId(caseId) };
        },
      ],
      [
        'a run that failed',
        async () => {
          const who = actors();
          const { caseId } = await awaitingApproval(who);
          await tamper(who, caseId, 'run', 'run-1', (doc) => {
            doc.state = 'failed';
            doc.stopReason = 'tool_error';
          });
          return { who, caseId, workId: runWorkId(caseId) };
        },
      ],
      [
        'work that was just requeued',
        async () => {
          const who = actors();
          const caseId = await poisonedCredit(who);
          const workId = creditWorkId(caseId);
          ok<RecoverAcceptedView>(await recover(who.operator, workId, requeueBody()), 202);
          return { who, caseId, workId };
        },
      ],
    ];

    for (const [name, setup] of NOT_STUCK) {
      it(`refuses ${name} and writes nothing`, async () => {
        const { who, caseId, workId } = await setup();
        const settled = snapshot(who, caseId);
        const batches = batchCount(who);
        expectProblem(await recover(who.operator, workId, requeueBody()), 409, 'recovery_not_applicable');
        assert.deepEqual(snapshot(who, caseId), settled);
        assert.equal(batchCount(who), batches);
      });
    }
  });

  describe('a request that does not describe a requeue', () => {
    const INVALID: [string, unknown][] = [
      ['no action', { reason: REASON }],
      ['an action nobody defined', { action: 'restart', reason: REASON }],
      ['no reason', { action: 'requeue' }],
      ['an empty reason', { action: 'requeue', reason: '' }],
      ['a reason over 500 characters', { action: 'requeue', reason: 'x'.repeat(501) }],
      ['a reason that is not text', { action: 'requeue', reason: 42 }],
      ['a property the contract does not define', { action: 'requeue', reason: REASON, force: true }],
    ];

    for (const [name, body] of INVALID) {
      it(`answers 400 for ${name} and writes nothing`, async () => {
        const who = actors();
        const caseId = await poisonedCredit(who);
        const settled = snapshot(who, caseId);
        const batches = batchCount(who);
        expectProblem(await recover(who.operator, creditWorkId(caseId), body), 400, 'validation_failed');
        assert.deepEqual(snapshot(who, caseId), settled);
        assert.equal(batchCount(who), batches);
      });
    }

    it('names the allowance as the problem when a requeue brings one', async () => {
      const who = actors();
      const caseId = await poisonedCredit(who);
      const settled = snapshot(who, caseId);
      const body = { action: 'requeue', reason: REASON, allowance: { steps: 1 } };
      const problem = expectProblem(await recover(who.operator, creditWorkId(caseId), body), 400, 'validation_failed');
      assert.deepEqual(
        problem.errors?.map(({ pointer, code }) => ({ pointer, code })),
        [{ pointer: '/allowance', code: 'allowance_not_applicable' }],
      );
      assert.deepEqual(snapshot(who, caseId), settled);
    });

    it('refuses a body that is empty, not JSON, or missing, and writes nothing', async () => {
      const who = actors();
      const caseId = await poisonedCredit(who);
      const settled = snapshot(who, caseId);
      const batches = batchCount(who);
      const attempts: { name: string; options: CallOptions; status: number; code: string }[] = [
        { name: 'an empty body', options: { rawBody: '' }, status: 400, code: 'invalid_json' },
        { name: 'a body that is not JSON', options: { rawBody: '{"action":' }, status: 400, code: 'invalid_json' },
        { name: 'no body at all', options: {}, status: 415, code: 'unsupported_media_type' },
      ];
      for (const { name, options, status, code } of attempts) {
        const reply = await who.operator.call('recoverWorkItem', { params: { workId: creditWorkId(caseId) }, ...options });
        assert.equal(reply.status, status, name);
        expectProblem(reply, status, code);
      }
      assert.deepEqual(snapshot(who, caseId), settled);
      assert.equal(batchCount(who), batches);
    });
  });

  describe('losing writes while requeueing', () => {
    it('requeues once when two operators act at the same moment', async () => {
      const who = actors();
      const caseId = await poisonedCredit(who);
      const workId = creditWorkId(caseId);
      const commits = commitCalls(who, caseId);
      const replies = await Promise.all([
        recover(who.operator, workId, requeueBody('First opinion.')),
        recover(who.operator, workId, requeueBody('Second opinion.')),
      ]);
      assert.equal(commitCalls(who, caseId) - commits, 2, 'both requests really raced for the write');

      assert.deepEqual(replies.map((reply) => reply.status).sort(), [202, 409]);
      const loser = replies.find((reply) => reply.status === 409);
      assert.ok(loser);
      expectProblem(loser, 409, 'recovery_not_applicable');
      assert.equal((await requeueEntries(who, caseId)).length, 1);
      assert.equal(creditOutbox(who, caseId).state, 'pending');
      assert.equal(creditOutbox(who, caseId).attempts, 0);
    });

    it('retries after losing a race to an unrelated writer and still requeues once', async () => {
      const who = actors();
      const caseId = await poisonedCredit(who);
      let lost = 1;
      let attempts = 0;
      who.world.memory.hooks.beforeCommit = (batch) => {
        if (batch.caseId === caseId) {
          attempts += 1;
          if (lost > 0) {
            lost -= 1;
            throw new CaseWriteError('stale', 0);
          }
        }
      };
      try {
        ok<RecoverAcceptedView>(await recover(who.operator, creditWorkId(caseId), requeueBody()), 202);
      } finally {
        who.world.memory.hooks.beforeCommit = undefined;
      }
      assert.equal(lost, 0);
      assert.equal(attempts, 2);
      assert.equal((await requeueEntries(who, caseId)).length, 1);
      assert.equal(creditOutbox(who, caseId).state, 'pending');
    });

    it('gives up with a conflict when every attempt loses its race', async () => {
      const who = actors();
      const caseId = await poisonedCredit(who);
      const settled = snapshot(who, caseId);
      let attempts = 0;
      who.world.memory.hooks.beforeCommit = (batch) => {
        if (batch.caseId === caseId) {
          attempts += 1;
          throw new CaseWriteError('stale', 0);
        }
      };
      try {
        expectProblem(await recover(who.operator, creditWorkId(caseId), requeueBody()), 409, 'concurrent_update');
      } finally {
        who.world.memory.hooks.beforeCommit = undefined;
      }
      assert.equal(attempts, MAX_ATTEMPTS);
      assert.deepEqual(snapshot(who, caseId), settled);

      ok<RecoverAcceptedView>(await recover(who.operator, creditWorkId(caseId), requeueBody()), 202);
    });

    it('answers 503 and writes nothing while the database keeps failing', async () => {
      const who = actors();
      const caseId = await poisonedCredit(who);
      const settled = snapshot(who, caseId);
      who.world.memory.hooks.beforeCommit = (batch) => {
        if (batch.caseId === caseId) throw transient(429);
      };
      try {
        const reply = await recover(who.operator, creditWorkId(caseId), requeueBody());
        expectProblem(reply, 503, 'dependency_unavailable');
        assert.equal(reply.headers['Retry-After'], '5');
      } finally {
        who.world.memory.hooks.beforeCommit = undefined;
      }
      assert.deepEqual(snapshot(who, caseId), settled);
    });

    it('reports a conflict when the answer to its write was lost, although the work did go back to the queue', async () => {
      const who = actors();
      const caseId = await poisonedCredit(who);
      let lost = 1;
      who.world.memory.hooks.afterCommit = (batch) => {
        if (batch.caseId === caseId && lost > 0) {
          lost -= 1;
          throw transient(408);
        }
      };
      try {
        expectProblem(await recover(who.operator, creditWorkId(caseId), requeueBody()), 409, 'recovery_not_applicable');
      } finally {
        who.world.memory.hooks.afterCommit = undefined;
      }
      assert.equal(lost, 0, 'the answer of a committed write really was lost');

      const item = creditOutbox(who, caseId);
      assert.equal(item.state, 'pending');
      assert.equal(item.attempts, 0);
      assert.equal((await requeueEntries(who, caseId)).length, 1, 'the retry did not requeue a second time');
      assert.equal((await allWork(who.operator, 'poison')).length, 0);
    });
  });

  it('keeps the work of one tenant out of reach of the operator of another', async () => {
    const who = actors();
    const caseId = await poisonedCredit(who);
    const settled = snapshot(who, caseId);
    const batches = batchCount(who);
    expectProblem(await recover(who.foreignOperator, creditWorkId(caseId), requeueBody()), 404, 'not_found');
    assert.deepEqual(snapshot(who, caseId), settled);
    assert.equal(batchCount(who), batches);
    assert.equal(creditOutbox(who, caseId).state, 'poison');
  });
});
