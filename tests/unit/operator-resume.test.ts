import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runKeyFor } from '../../src/cases/documents.ts';
import { MAX_ATTEMPTS } from '../../src/cases/retry.ts';
import { CaseWriteError } from '../../src/cases/store.ts';
import { workIdOf } from '../../src/cases/work.ts';
import { outboxId } from '../../src/outbox/types.ts';
import {
  actors,
  allWork,
  approve,
  awaitingApproval,
  caseOf,
  creditWorkId,
  expectProblem,
  kindsOf,
  ok,
  OPERATOR_ID,
  openCase,
  proposalOf,
  proposalWorkId,
  recover,
  reject,
  revise,
  runWorkId,
  tamper,
  timelineOf,
  type Actors,
  type DecisionAcceptedView,
  type DecisionView,
  type RecoverAcceptedView,
  type RunView,
  type TimelineView,
} from '../support/decision-flow.ts';
import { as, BASE_CONFIG } from '../support/handler-harness.ts';
import {
  batchCount,
  batchesFor,
  commitCalls,
  exhaustedRun,
  MARKER,
  opsOf,
  poisonedCredit,
  REASON,
  resumeBody,
  runsOf,
  slotsOf,
  snapshot,
  startsOf,
  stoppedAt,
  transient,
} from '../support/operator-flow.ts';

const RESUME_OPS = ['replace:case', 'replace:run', 'create:timeline', 'create:outbox'];
const FIRST_START = outboxId('investigation.start', 'run-1');
const FIRST_GRANT = outboxId('investigation.start', 'run-1-g1');

const resumed = (workId: string, grantNumber: number): RecoverAcceptedView => ({ workId, action: 'resume', state: 'budget_exhausted', grantNumber });

interface Target {
  who: Actors;
  caseId: string;
  workId: string;
}

/** A case whose investigation was cut off after two steps and now waits for an operator. */
async function stopped(): Promise<Target> {
  const who = stoppedAt({ steps: 2 });
  const caseId = await exhaustedRun(who);
  return { who, caseId, workId: runWorkId(caseId) };
}

async function onlyRun(who: Actors, caseId: string): Promise<RunView> {
  const [run, ...others] = await runsOf(who, caseId);
  assert.deepEqual(others, [], 'the case has one run');
  assert.ok(run);
  return run;
}

async function lastEntry(who: Actors, caseId: string): Promise<TimelineView> {
  const entry = (await timelineOf(who.operator, caseId)).at(-1);
  assert.ok(entry, 'the timeline has entries');
  return entry;
}

const resumeEntries = async (who: Actors, caseId: string): Promise<TimelineView[]> =>
  (await timelineOf(who.operator, caseId)).filter((item) => item.kind === 'run_resumed');

const grantStarts = (who: Actors, caseId: string) => startsOf(who, caseId).filter((doc) => doc.id !== FIRST_START);

const eventsOf = async (who: Actors, caseId: string): Promise<Record<string, unknown>[]> =>
  ok<{ items: Record<string, unknown>[] }>(await who.operator.call('listRunUsageEvents', { params: { caseId, runId: 'run-1' } })).items;

describe('resuming a run that stopped at its allowance', () => {
  describe('the grant', () => {
    it('queues the run again with the grant added to its limit, keeping everything it already used', async () => {
      const { who, caseId, workId } = await stopped();
      const before = await onlyRun(who, caseId);
      assert.equal(before.state, 'budget_exhausted');
      assert.equal(before.stopReason, 'steps_exhausted');
      assert.equal(before.allowanceGrants, 0);
      assert.equal(before.limits['steps'], 2);
      assert.deepEqual(slotsOf(who), [], 'a stopped run holds no slot');

      who.world.clock.advance(5_000);
      const reply = await recover(who.operator, workId, resumeBody({ steps: 8 }));
      assert.deepEqual(ok<RecoverAcceptedView>(reply, 202), resumed(workId, 1));
      assert.deepEqual(opsOf(batchesFor(who, caseId).at(-1)), RESUME_OPS);

      const run = await onlyRun(who, caseId);
      assert.equal(run.state, 'queued');
      assert.equal(run.stopReason, null);
      assert.equal(run.allowanceGrants, 1);
      assert.deepEqual(run.limits, { ...before.limits, steps: 10 });
      assert.deepEqual(run.usage, before.usage, 'nothing the run used was reset');
      assert.equal((await caseOf(who.operator, caseId)).status, 'queued');
      assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-1')], 'the resumed run holds a slot again');
      assert.deepEqual(await allWork(who.operator, 'budget_exhausted'), []);

      const entry = await lastEntry(who, caseId);
      assert.equal(entry.kind, 'run_resumed');
      assert.equal(entry.actor.type, 'user');
      assert.equal(entry.actor.id, OPERATOR_ID);
      assert.equal(entry.summary, 'Run run-1 resumed with allowance grant 1 of 2.');
      assert.deepEqual(entry.data, { runId: 'run-1', grant: 1, reason: REASON, grantedSteps: 8 });

      assert.deepEqual(startsOf(who, caseId).map((doc) => doc.id).sort(), [FIRST_START, FIRST_GRANT]);
      const [grant] = grantStarts(who, caseId);
      assert.equal(grant?.state, 'pending');
      assert.deepEqual(grant.payload, { runId: 'run-1', revision: 1 });
      assert.equal(startsOf(who, caseId).find((doc) => doc.id === FIRST_START)?.state, 'completed', 'the first start stays as the record of the first life');

      const accepted = who.operator.lines
        .map((line) => as<Record<string, unknown>>(JSON.parse(line)))
        .filter((line) => line['message'] === 'work recovery accepted');
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0]?.['action'], 'resume');
      assert.equal(accepted[0]?.['grantNumber'], 1);
      assert.ok(
        who.lines().every((line) => !line.includes(MARKER)),
        'what the operator wrote is stored with the case and never logged',
      );
    });

    it('runs again within the new allowance and ends with a proposal for a human, with the earlier usage events intact', async () => {
      const { who, caseId, workId } = await stopped();
      const earlier = await eventsOf(who, caseId);
      assert.equal(earlier.length, 2);

      ok<RecoverAcceptedView>(await recover(who.operator, workId, resumeBody({ steps: 8 })), 202);
      assert.deepEqual(await who.operator.drain(), ['completed']);

      const detail = await caseOf(who.operator, caseId);
      assert.equal(detail.status, 'awaiting_approval');
      assert.equal(detail.latestRun?.state, 'completed');
      assert.equal(detail.latestRun.usage.steps, 7, 'the two steps of the first life plus the five of the second');
      assert.equal(detail.latestRun.allowanceGrants, 1);
      assert.equal(detail.latestProposal?.status, 'pending_approval');
      assert.deepEqual(slotsOf(who), []);

      const later = await eventsOf(who, caseId);
      assert.equal(later.length, 7);
      assert.deepEqual(later.slice(0, earlier.length), earlier, 'usage recorded before the resume is untouched');

      const timeline = await timelineOf(who.operator, caseId);
      assert.deepEqual(kindsOf(timeline), [
        'case_created',
        'run_queued',
        'run_started',
        'tool_called',
        'tool_called',
        'run_budget_exhausted',
        'run_resumed',
        'run_started',
        'tool_called',
        'tool_called',
        'tool_called',
        'tool_called',
        'proposal_submitted',
      ]);
      assert.deepEqual(
        timeline.filter((item) => item.kind === 'run_started').map((item) => item.data?.['resumed']),
        [false, true],
      );

      assert.deepEqual(await allWork(who.operator, 'budget_exhausted'), []);
      assert.deepEqual(
        (await allWork(who.operator, 'completed')).map((item) => item.workId).sort(),
        [workIdOf(caseId, FIRST_START), workIdOf(caseId, FIRST_GRANT)],
      );
    });

    it('leaves the approval and the credit that follow a resumed run working as usual', async () => {
      const { who, caseId, workId } = await stopped();
      ok<RecoverAcceptedView>(await recover(who.operator, workId, resumeBody({ steps: 8 })), 202);
      assert.deepEqual(await who.operator.drain(), ['completed']);

      const proposal = await proposalOf(who.operator, caseId, 1);
      assert.equal(proposal.status, 'pending_approval');
      ok<DecisionAcceptedView>(await approve(who.approver, { caseId, proposal }), 202);
      assert.deepEqual(await who.approver.drain(), ['completed']);
      assert.equal((await caseOf(who.operator, caseId)).status, 'credited');
      assert.equal(who.world.provider.credits().length, 1);
    });

    it('adds each granted amount to the limit the run already has', async () => {
      const { who, caseId, workId } = await stopped();
      ok<RecoverAcceptedView>(await recover(who.operator, workId, resumeBody({ steps: 1, toolCalls: 2 })), 202);

      const run = await onlyRun(who, caseId);
      assert.equal(run.limits['steps'], 3);
      assert.equal(run.limits['toolCalls'], 14, 'a grant adds to the limit; it does not replace it');
      const entry = await lastEntry(who, caseId);
      assert.deepEqual(entry.data, { runId: 'run-1', grant: 1, reason: REASON, grantedSteps: 1, grantedToolCalls: 2 });
    });

    it('takes the smallest and the largest grants the contract allows, and leaves the retry limits alone', async () => {
      const smallest = await stopped();
      ok<RecoverAcceptedView>(await recover(smallest.who.operator, smallest.workId, resumeBody({ steps: 1, activeMs: 1_000 })), 202);
      const small = await onlyRun(smallest.who, smallest.caseId);
      assert.equal(small.limits['steps'], 3);

      const { who, caseId, workId } = await stopped();
      const before = await onlyRun(who, caseId);
      const grant = { steps: 8, toolCalls: 12, modelCalls: 8, tokens: 30_000, costMicroUsd: 250_000, activeMs: 90_000 };
      ok<RecoverAcceptedView>(await recover(who.operator, workId, resumeBody(grant)), 202);

      const expected: Record<string, number> = { ...before.limits };
      for (const [key, value] of Object.entries(grant)) expected[key] = (before.limits[key] ?? 0) + value;
      assert.deepEqual((await onlyRun(who, caseId)).limits, expected);
      assert.equal(expected['retriesPerCall'], before.limits['retriesPerCall']);
      assert.equal(expected['retriesPerRun'], before.limits['retriesPerRun']);
    });

    it('resumes the run of a revision without touching what the first run produced', async () => {
      const who = actors();
      const first = await awaitingApproval(who);
      const { caseId } = first;
      ok<DecisionView>(await reject(who.approver, first));
      const firstRun = await onlyRun(who, caseId);
      const rejected = await proposalOf(who.operator, caseId, 1);

      const tight = actors({ world: who.world, config: { runLimits: { ...BASE_CONFIG.runLimits, steps: 2 } } });
      ok<RunView>(await revise(tight.representative, caseId), 202);
      assert.deepEqual(await tight.operator.drain(), ['completed']);
      assert.equal((await caseOf(tight.operator, caseId)).latestRun?.state, 'budget_exhausted');

      const workId = runWorkId(caseId, 'run-2');
      const reply = await recover(tight.operator, workId, resumeBody({ steps: 8 }));
      assert.deepEqual(ok<RecoverAcceptedView>(reply, 202), resumed(workId, 1));

      const [one, two, ...others] = await runsOf(who, caseId);
      assert.deepEqual(others, []);
      assert.deepEqual(one, firstRun, 'the first run was not touched');
      assert.equal(two?.runId, 'run-2');
      assert.equal(two.state, 'queued');
      assert.equal(two.allowanceGrants, 1);
      assert.deepEqual(await proposalOf(who.operator, caseId, 1), rejected, 'the decision on the first proposal stands');
      const grant = startsOf(who, caseId).find((doc) => doc.id === outboxId('investigation.start', 'run-2-g1'));
      assert.deepEqual(grant?.payload, { runId: 'run-2', revision: 2 });

      assert.deepEqual(await who.operator.drain(), ['completed']);
      const detail = await caseOf(who.operator, caseId);
      assert.equal(detail.status, 'awaiting_approval');
      assert.equal(detail.revision, 2);
      const second = await proposalOf(who.operator, caseId, 2);
      assert.equal(second.status, 'pending_approval');

      ok<DecisionAcceptedView>(await approve(who.approver, { caseId, proposal: second }), 202);
      assert.deepEqual(await who.approver.drain(), ['completed']);
      assert.equal((await caseOf(who.operator, caseId)).status, 'credited');
      assert.equal(who.world.provider.credits().length, 1);
    });
  });

  describe('the cap on grants', () => {
    it('stops granting after two resumes of the same run, and keeps counting what the run used', async () => {
      const { who, caseId, workId } = await stopped();
      for (const grant of [1, 2]) {
        const reply = await recover(who.operator, workId, resumeBody({ steps: 1 }));
        assert.deepEqual(ok<RecoverAcceptedView>(reply, 202), resumed(workId, grant));
        assert.deepEqual(await who.operator.drain(), ['completed']);

        const run = await onlyRun(who, caseId);
        assert.equal(run.state, 'budget_exhausted', `the run used the allowance of grant ${String(grant)} and stopped again`);
        assert.equal(run.stopReason, 'steps_exhausted');
        assert.equal(run.allowanceGrants, grant);
        assert.equal(run.usage.steps, 2 + grant);
        assert.equal(run.limits['steps'], 2 + grant);
      }

      const [item, ...others] = await allWork(who.operator, 'budget_exhausted');
      assert.deepEqual(others, []);
      assert.equal(item?.summary, 'Run run-1 stopped at its allowance (steps_exhausted); 2 of 2 resume grants used.');
      assert.deepEqual(item.actions, []);

      const settled = snapshot(who, caseId);
      const batches = batchCount(who);
      expectProblem(await recover(who.operator, workId, resumeBody({ steps: 1 })), 409, 'resume_grants_exhausted');
      assert.deepEqual(snapshot(who, caseId), settled);
      assert.equal(batchCount(who), batches);
      assert.equal((await resumeEntries(who, caseId)).length, 2);
    });
  });

  describe('the dimension that stopped the run', () => {
    it('refuses an allowance for something else than what stopped the run', async () => {
      const { who, caseId, workId } = await stopped();
      const settled = snapshot(who, caseId);
      const batches = batchCount(who);
      expectProblem(await recover(who.operator, workId, resumeBody({ toolCalls: 3 })), 409, 'allowance_does_not_cover_stop');
      assert.deepEqual(snapshot(who, caseId), settled);
      assert.equal(batchCount(who), batches);
      assert.deepEqual(slotsOf(who), []);
    });

    it('accepts the dimension that stopped the run, whatever it is', async () => {
      const who = stoppedAt({ toolCalls: 2 });
      const caseId = await exhaustedRun(who);
      const workId = runWorkId(caseId);
      assert.equal((await onlyRun(who, caseId)).stopReason, 'tool_calls_exhausted');

      const settled = snapshot(who, caseId);
      expectProblem(await recover(who.operator, workId, resumeBody({ steps: 8 })), 409, 'allowance_does_not_cover_stop');
      assert.deepEqual(snapshot(who, caseId), settled);

      ok<RecoverAcceptedView>(await recover(who.operator, workId, resumeBody({ toolCalls: 8 })), 202);
      assert.deepEqual(await who.operator.drain(), ['completed']);
      assert.equal((await caseOf(who.operator, caseId)).status, 'awaiting_approval');
    });
  });

  describe('a request that does not grant an allowance', () => {
    const INVALID: [string, unknown][] = [
      ['an allowance with nothing in it', { action: 'resume', reason: REASON, allowance: {} }],
      ['an allowance that is not an object', { action: 'resume', reason: REASON, allowance: 8 }],
      ['more steps than one grant may add', { action: 'resume', reason: REASON, allowance: { steps: 9 } }],
      ['no steps at all', { action: 'resume', reason: REASON, allowance: { steps: 0 } }],
      ['a fraction of a step', { action: 'resume', reason: REASON, allowance: { steps: 1.5 } }],
      ['steps written as text', { action: 'resume', reason: REASON, allowance: { steps: '8' } }],
      ['less active time than the contract allows', { action: 'resume', reason: REASON, allowance: { steps: 8, activeMs: 999 } }],
      ['a limit nobody defined', { action: 'resume', reason: REASON, allowance: { steps: 8, retriesPerRun: 2 } }],
      ['no reason', { action: 'resume', allowance: { steps: 8 } }],
      ['an empty reason', { action: 'resume', reason: '', allowance: { steps: 8 } }],
      ['a reason over 500 characters', { action: 'resume', reason: 'x'.repeat(501), allowance: { steps: 8 } }],
    ];

    for (const [name, body] of INVALID) {
      it(`answers 400 for ${name} and writes nothing`, async () => {
        const { who, caseId, workId } = await stopped();
        const settled = snapshot(who, caseId);
        const batches = batchCount(who);
        expectProblem(await recover(who.operator, workId, body), 400, 'validation_failed');
        assert.deepEqual(snapshot(who, caseId), settled);
        assert.equal(batchCount(who), batches);
        assert.deepEqual(slotsOf(who), []);
      });
    }

    it('names the allowance as the problem when a resume brings none', async () => {
      const { who, caseId, workId } = await stopped();
      const settled = snapshot(who, caseId);
      const problem = expectProblem(await recover(who.operator, workId, { action: 'resume', reason: REASON }), 400, 'validation_failed');
      assert.deepEqual(
        problem.errors?.map(({ pointer, code }) => ({ pointer, code })),
        [{ pointer: '/allowance', code: 'allowance_required' }],
      );
      assert.deepEqual(snapshot(who, caseId), settled);
    });
  });

  describe('work that cannot be resumed', () => {
    const NOT_RESUMABLE: [string, () => Promise<Target>][] = [
      [
        'work that was poisoned',
        async () => {
          const who = actors();
          const caseId = await poisonedCredit(who);
          return { who, caseId, workId: creditWorkId(caseId) };
        },
      ],
      [
        'a proposal that waits for a decision',
        async () => {
          const who = actors();
          const { caseId } = await awaitingApproval(who);
          return { who, caseId, workId: proposalWorkId(caseId) };
        },
      ],
      [
        'a run that completed',
        async () => {
          const who = actors();
          const { caseId } = await awaitingApproval(who);
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
        'a run that was already resumed',
        async () => {
          const target = await stopped();
          ok<RecoverAcceptedView>(await recover(target.who.operator, target.workId, resumeBody({ steps: 8 })), 202);
          return target;
        },
      ],
      [
        'a run a later run has replaced',
        async () => {
          const target = await stopped();
          await tamper(target.who, target.caseId, 'case', 'case', (doc) => {
            doc.latestRunId = 'run-2';
          });
          return target;
        },
      ],
    ];

    for (const [name, setup] of NOT_RESUMABLE) {
      it(`refuses ${name} and writes nothing`, async () => {
        const { who, caseId, workId } = await setup();
        const settled = snapshot(who, caseId);
        const batches = batchCount(who);
        const slots = slotsOf(who);
        expectProblem(await recover(who.operator, workId, resumeBody({ steps: 8 })), 409, 'recovery_not_applicable');
        assert.deepEqual(snapshot(who, caseId), settled);
        assert.equal(batchCount(who), batches);
        assert.deepEqual(slotsOf(who), slots, 'a refusal takes no slot');
      });
    }
  });

  describe('the concurrency limit of the tenant', () => {
    it('needs a free slot, writes nothing without one, and succeeds once another run has finished', async () => {
      const who = stoppedAt({ steps: 2 }, 1);
      const caseId = await exhaustedRun(who);
      const workId = runWorkId(caseId);
      const other = await openCase(who);
      assert.deepEqual(slotsOf(who), [runKeyFor(other, 'run-1')], 'the other case holds the only slot');

      const settled = snapshot(who, caseId);
      const batches = batchCount(who);
      const refused = await recover(who.operator, workId, resumeBody({ steps: 8 }));
      expectProblem(refused, 429, 'tenant_concurrency_limit');
      assert.equal(refused.headers['Retry-After'], '5');
      assert.deepEqual(snapshot(who, caseId), settled);
      assert.equal(batchCount(who), batches);

      assert.deepEqual(await who.operator.drain(), ['completed'], 'the other run stops at its own allowance and frees its slot');
      assert.deepEqual(slotsOf(who), []);
      assert.deepEqual(ok<RecoverAcceptedView>(await recover(who.operator, workId, resumeBody({ steps: 8 })), 202), resumed(workId, 1));
      assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-1')]);
    });
  });

  describe('competing and failing writes', () => {
    it('records one grant when two operators resume the same run at the same moment', async () => {
      const { who, caseId, workId } = await stopped();
      const commits = commitCalls(who, caseId);
      const replies = await Promise.all([
        recover(who.operator, workId, resumeBody({ steps: 8 }, 'First opinion.')),
        recover(who.operator, workId, resumeBody({ steps: 8 }, 'Second opinion.')),
      ]);
      assert.equal(commitCalls(who, caseId) - commits, 2, 'both requests really raced for the write');

      const statuses = replies.map((reply) => reply.status);
      assert.ok(
        statuses.every((status) => status === 202 || status === 409),
        JSON.stringify(statuses),
      );
      assert.ok(statuses.includes(202), 'one of them was accepted');
      for (const reply of replies.filter((candidate) => candidate.status === 202)) {
        assert.equal(ok<RecoverAcceptedView>(reply, 202).grantNumber, 1, 'whoever is told it succeeded is told about the one grant');
      }

      const run = await onlyRun(who, caseId);
      assert.equal(run.allowanceGrants, 1);
      assert.equal(run.limits['steps'], 10, 'the grant was added once');
      assert.equal(grantStarts(who, caseId).length, 1);
      assert.equal((await resumeEntries(who, caseId)).length, 1);
      assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-1')], 'the run holds one slot');
    });

    it('does not resume a second time when a later request arrives after the first was accepted', async () => {
      const { who, caseId, workId } = await stopped();
      ok<RecoverAcceptedView>(await recover(who.operator, workId, resumeBody({ steps: 8 })), 202);
      who.world.clock.advance(1);
      expectProblem(await recover(who.operator, workId, resumeBody({ steps: 8 })), 409, 'recovery_not_applicable');
      assert.equal((await onlyRun(who, caseId)).allowanceGrants, 1);
      assert.equal(grantStarts(who, caseId).length, 1);
    });

    it('recognises its own earlier write when the answer was lost, instead of reporting a failure', async () => {
      const { who, caseId, workId } = await stopped();
      let lost = 1;
      who.world.memory.hooks.afterCommit = (batch) => {
        if (batch.caseId === caseId && lost > 0) {
          lost -= 1;
          throw transient(408);
        }
      };
      try {
        const reply = await recover(who.operator, workId, resumeBody({ steps: 8 }));
        assert.deepEqual(ok<RecoverAcceptedView>(reply, 202), resumed(workId, 1));
      } finally {
        who.world.memory.hooks.afterCommit = undefined;
      }
      assert.equal(lost, 0, 'the answer of a committed write really was lost');

      assert.equal((await onlyRun(who, caseId)).allowanceGrants, 1);
      assert.equal(grantStarts(who, caseId).length, 1);
      assert.equal((await resumeEntries(who, caseId)).length, 1);
      assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-1')]);
    });

    it('leaves the slot to its lease and answers 503 when it cannot tell whether its write happened', async () => {
      const { who, caseId, workId } = await stopped();
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

      try {
        const reply = await recover(who.operator, workId, resumeBody({ steps: 8 }));
        expectProblem(reply, 503, 'dependency_unavailable');
        assert.equal(reply.headers['Retry-After'], '5');
        assert.ok(who.operator.lines.some((line) => line.includes('resume outcome is unknown')));
        assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-1')], 'neither released nor refunded');
      } finally {
        memory.hooks.afterCommit = undefined;
        blind = false;
        memory.store.get = read;
      }

      assert.equal((await onlyRun(who, caseId)).allowanceGrants, 1, 'the write that was lost from view had happened');
      assert.deepEqual(await who.operator.drain(), ['completed']);
      assert.equal((await caseOf(who.operator, caseId)).status, 'awaiting_approval');
      assert.deepEqual(slotsOf(who), [], 'the resumed run freed its slot when it finished');
    });

    it('retries after losing a race to an unrelated writer and still resumes once', async () => {
      const { who, caseId, workId } = await stopped();
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
        ok<RecoverAcceptedView>(await recover(who.operator, workId, resumeBody({ steps: 8 })), 202);
      } finally {
        who.world.memory.hooks.beforeCommit = undefined;
      }
      assert.equal(lost, 0);
      assert.equal(attempts, 2);
      assert.equal((await onlyRun(who, caseId)).allowanceGrants, 1);
      assert.equal((await resumeEntries(who, caseId)).length, 1);
      assert.deepEqual(slotsOf(who), [runKeyFor(caseId, 'run-1')], 'the slot the lost attempt took was freed before the next one took it again');
    });

    it('gives up with a conflict when every attempt loses its race, and frees the slot each attempt took', async () => {
      const { who, caseId, workId } = await stopped();
      const settled = snapshot(who, caseId);
      let attempts = 0;
      who.world.memory.hooks.beforeCommit = (batch) => {
        if (batch.caseId === caseId) {
          attempts += 1;
          throw new CaseWriteError('stale', 0);
        }
      };
      try {
        expectProblem(await recover(who.operator, workId, resumeBody({ steps: 8 })), 409, 'concurrent_update');
      } finally {
        who.world.memory.hooks.beforeCommit = undefined;
      }
      assert.equal(attempts, MAX_ATTEMPTS);
      assert.deepEqual(snapshot(who, caseId), settled);
      assert.deepEqual(slotsOf(who), []);

      ok<RecoverAcceptedView>(await recover(who.operator, workId, resumeBody({ steps: 8 })), 202);
    });

    it('answers 503, writes nothing and frees its slot while the database keeps failing', async () => {
      const { who, caseId, workId } = await stopped();
      const settled = snapshot(who, caseId);
      who.world.memory.hooks.beforeCommit = (batch) => {
        if (batch.caseId === caseId) throw transient(429);
      };
      try {
        const reply = await recover(who.operator, workId, resumeBody({ steps: 8 }));
        expectProblem(reply, 503, 'dependency_unavailable');
        assert.equal(reply.headers['Retry-After'], '5');
      } finally {
        who.world.memory.hooks.beforeCommit = undefined;
      }
      assert.deepEqual(snapshot(who, caseId), settled);
      assert.deepEqual(slotsOf(who), []);
    });
  });

  describe('who may resume', () => {
    it('refuses every caller who is not an operator of the tenant, and writes nothing', async () => {
      const { who, caseId, workId } = await stopped();
      const settled = snapshot(who, caseId);
      const batches = batchCount(who);
      for (const caller of [who.representative, who.approver, who.secondApprover, who.dual, who.foreignApprover]) {
        expectProblem(await recover(caller, workId, resumeBody({ steps: 8 })), 403, 'forbidden_role');
      }
      expectProblem(await recover(who.foreignOperator, workId, resumeBody({ steps: 8 })), 404, 'not_found');
      assert.deepEqual(snapshot(who, caseId), settled);
      assert.equal(batchCount(who), batches, 'nothing was written for any tenant, admission included');
      assert.deepEqual(slotsOf(who), []);
    });
  });
});
