import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { progressOf, STEP_STATE_LABEL, type StepState } from '../../web/src/progress.ts';
import { schemaEnum } from '../support/contract-doc.ts';

const statesOf = (status: string, proposalStatus: string | null = null): StepState[] =>
  progressOf(status, proposalStatus).map((step) => step.state);

const SUBMITTED_ONLY: StepState[] = ['done', 'upcoming', 'upcoming', 'upcoming', 'upcoming'];

/** Submitted, Investigating, Proposal, Decision, Credit. `needs_attention` is the case with no approved proposal. */
const EXPECTED: Readonly<Record<string, StepState[]>> = {
  queued: ['done', 'current', 'upcoming', 'upcoming', 'upcoming'],
  investigating: ['done', 'current', 'upcoming', 'upcoming', 'upcoming'],
  awaiting_approval: ['done', 'done', 'done', 'current', 'upcoming'],
  finding_reported: ['done', 'done', 'done', 'skipped', 'skipped'],
  approved: ['done', 'done', 'done', 'done', 'current'],
  credited: ['done', 'done', 'done', 'done', 'done'],
  rejected: ['done', 'done', 'done', 'stopped', 'skipped'],
  expired: ['done', 'done', 'done', 'stopped', 'skipped'],
  needs_attention: ['done', 'stopped', 'upcoming', 'upcoming', 'upcoming'],
};

describe('progressOf', () => {
  it('lists the five steps in order, whatever the status', () => {
    for (const status of [...schemaEnum('CaseStatus'), 'unknown']) {
      const steps = progressOf(status, null);
      assert.deepEqual(
        steps.map((step) => step.key),
        ['submitted', 'investigating', 'proposal', 'decision', 'credit'],
        status,
      );
      assert.deepEqual(
        steps.map((step) => step.label),
        ['Submitted', 'Investigating', 'Proposal', 'Decision', 'Credit (simulated)'],
        status,
      );
    }
  });

  it('is tested for exactly the statuses in the contract', () => {
    assert.deepEqual(Object.keys(EXPECTED).sort(), [...schemaEnum('CaseStatus')].sort());
  });

  for (const [status, states] of Object.entries(EXPECTED)) {
    it(`shows ${status}`, () => {
      assert.deepEqual(statesOf(status), states);
    });
  }

  it('does not treat any contract status as an unknown one', () => {
    for (const status of schemaEnum('CaseStatus')) assert.notDeepEqual(statesOf(status), SUBMITTED_ONLY, status);
  });

  it('shows only the submission for a status it does not know, including inherited names', () => {
    for (const status of ['', 'unknown', 'QUEUED', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.deepEqual(statesOf(status), SUBMITTED_ONLY, JSON.stringify(status));
    }
  });

  it('stops a case that needs attention at the credit once its proposal was approved', () => {
    assert.deepEqual(statesOf('needs_attention', 'approved'), ['done', 'done', 'done', 'done', 'stopped']);
  });

  it('stops a case that needs attention at the investigation when no proposal was approved', () => {
    for (const proposalStatus of [null, 'rejected', 'expired', 'reported', 'superseded']) {
      assert.deepEqual(statesOf('needs_attention', proposalStatus), EXPECTED['needs_attention'], String(proposalStatus));
    }
  });

  it('only lets the proposal status change the steps for a case that needs attention', () => {
    for (const status of schemaEnum('CaseStatus')) {
      if (status === 'needs_attention') continue;
      for (const proposalStatus of [null, ...schemaEnum('ProposalStatus')]) {
        assert.deepEqual(statesOf(status, proposalStatus), statesOf(status, null), `${status} ${String(proposalStatus)}`);
      }
    }
  });

  it('puts finished steps first and shows at most one step in progress', () => {
    for (const status of [...schemaEnum('CaseStatus'), 'unknown']) {
      for (const proposalStatus of [null, 'approved', 'rejected']) {
        const states = statesOf(status, proposalStatus);
        const firstOpen = states.findIndex((state) => state !== 'done');
        if (firstOpen !== -1) {
          assert.ok(
            states.slice(firstOpen).every((state) => state !== 'done'),
            `${status} ${String(proposalStatus)}: ${states.join(', ')}`,
          );
        }
        assert.ok(states.filter((state) => state === 'current').length <= 1, status);
      }
    }
  });

  it('returns a new list each time, so a caller cannot change what the next one sees', () => {
    const first = progressOf('queued', null);
    first.pop();
    assert.equal(progressOf('queued', null).length, 5);
  });
});

describe('STEP_STATE_LABEL', () => {
  it('words every step state, each differently, so the state is never only a colour or a symbol', () => {
    assert.deepEqual(STEP_STATE_LABEL, {
      done: 'done',
      current: 'in progress',
      upcoming: 'not started',
      stopped: 'stopped',
      skipped: 'not needed',
    });
    assert.equal(new Set(Object.values(STEP_STATE_LABEL)).size, Object.keys(STEP_STATE_LABEL).length);
  });

  it('has a label for every state that progressOf can produce', () => {
    for (const status of [...schemaEnum('CaseStatus'), 'unknown']) {
      for (const proposalStatus of [null, 'approved']) {
        for (const state of statesOf(status, proposalStatus)) assert.ok(Object.hasOwn(STEP_STATE_LABEL, state), state);
      }
    }
  });
});
