import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CASE_LIMITS } from '../../src/config/limits.ts';
import {
  caseSignature,
  decisionAccess,
  evidenceTarget,
  isActive,
  latestProposal,
  latestRun,
  MAX_EVIDENCE_INVOICES,
  nextPollDelay,
  pollPlan,
  revisionAccess,
  snapshotConsistent,
  type PollPlan,
} from '../../web/src/case-state.ts';
import type { Actor, Role } from '../../web/src/types.ts';
import { schemaEnum } from '../support/contract-doc.ts';
import { APPROVER_ID, briefOf, caseDetail, creditResult, proposal, REPRESENTATIVE_ID, run, session } from '../support/web-fixtures.ts';

const ACTIVE = ['queued', 'investigating', 'approved'];
const WAITING = ['awaiting_approval', 'needs_attention'];
const SETTLED = ['finding_reported', 'credited', 'rejected', 'expired'];
const REVISABLE = ['rejected', 'expired', 'finding_reported'];

const viewer = (roles: Role[], principalId = APPROVER_ID) => session({ roles, principalId });

describe('case status groups', () => {
  it('cover every contract status exactly once', () => {
    assert.deepEqual([...ACTIVE, ...WAITING, ...SETTLED].sort(), [...schemaEnum('CaseStatus')].sort());
  });
});

describe('caseSignature', () => {
  const base = caseDetail({ creditResult: null });
  const signature = caseSignature(base);

  it('is the same for the same case read again', () => {
    assert.equal(caseSignature(structuredClone(base)), signature);
  });

  it('changes when the status, update time, revision, latest proposal, latest run or credit changes', () => {
    const changed = {
      status: caseDetail({ status: 'approved' }),
      updatedAt: caseDetail({ updatedAt: '2026-10-29T10:00:00.000Z' }),
      revision: caseDetail({ revision: 2 }),
      proposalStatus: caseDetail({ latestProposal: briefOf(proposal({ status: 'approved' })) }),
      proposalVersion: caseDetail({ latestProposal: briefOf(proposal({ version: 2 })) }),
      noProposal: caseDetail({ latestProposal: null }),
      runState: caseDetail({ latestRun: run({ state: 'running' }) }),
      noRun: caseDetail({ latestRun: null }),
      credit: caseDetail({ creditResult: creditResult() }),
    };
    for (const [name, detail] of Object.entries(changed)) assert.notEqual(caseSignature(detail), signature, name);
  });

  it('tells two credit results apart', () => {
    assert.notEqual(
      caseSignature(caseDetail({ creditResult: creditResult({ resultId: 'result-1' }) })),
      caseSignature(caseDetail({ creditResult: creditResult({ resultId: 'result-2' }) })),
    );
  });
});

describe('isActive and pollPlan', () => {
  it('poll quickly while the system is working', () => {
    for (const status of ACTIVE) {
      assert.equal(isActive(status), true, status);
      assert.deepEqual(pollPlan(status), { firstMs: 1500, maxMs: 5000 }, status);
    }
  });

  it('poll slowly while a person has to act', () => {
    for (const status of WAITING) {
      assert.equal(isActive(status), false, status);
      assert.deepEqual(pollPlan(status), { firstMs: 15_000, maxMs: 15_000 }, status);
    }
  });

  it('do not poll a settled case', () => {
    for (const status of SETTLED) {
      assert.equal(isActive(status), false, status);
      assert.equal(pollPlan(status), null, status);
    }
  });

  it('do not poll a status they do not know, including inherited names', () => {
    for (const status of ['', 'unknown', 'QUEUED', 'constructor', 'toString', '__proto__']) {
      assert.equal(isActive(status), false, status);
      assert.equal(pollPlan(status), null, status);
    }
  });
});

describe('nextPollDelay', () => {
  const FAST: PollPlan = { firstMs: 1500, maxMs: 5000 };
  const SLOW: PollPlan = { firstMs: 15_000, maxMs: 15_000 };

  it('starts again from the first delay after a change', () => {
    assert.equal(nextPollDelay(FAST, 5000, true), 1500);
    assert.equal(nextPollDelay(FAST, 1500, true), 1500);
    assert.equal(nextPollDelay(SLOW, 15_000, true), 15_000);
  });

  it('backs off by half again while nothing changes, up to the longest delay', () => {
    const seen: number[] = [];
    let delay = FAST.firstMs;
    for (let step = 0; step < 6; step += 1) {
      delay = nextPollDelay(FAST, delay, false);
      seen.push(delay);
    }
    assert.deepEqual(seen, [2250, 3375, 5000, 5000, 5000, 5000]);
  });

  it('never goes below the first delay or above the longest', () => {
    assert.equal(nextPollDelay(FAST, 0, false), 1500);
    assert.equal(nextPollDelay(FAST, 100, false), 1500);
    assert.equal(nextPollDelay(FAST, 1_000_000, false), 5000);
  });

  it('stays at one delay for a plan that does not back off', () => {
    for (const previous of [1, 15_000, 99_999]) assert.equal(nextPollDelay(SLOW, previous, false), 15_000, String(previous));
  });
});

describe('latestProposal and latestRun', () => {
  it('find the highest proposal version whatever the order', () => {
    const [v1, v2, v3] = [1, 2, 3].map((version) => proposal({ version }));
    assert.ok(v1 !== undefined && v2 !== undefined && v3 !== undefined);
    assert.equal(latestProposal([]), null);
    assert.equal(latestProposal([v1]), v1);
    assert.equal(latestProposal([v2, v3, v1]), v3);
    assert.equal(latestProposal([v3, v1, v2]), v3);
  });

  it('find the run with the highest revision whatever the order', () => {
    const [r1, r2, r3] = [1, 2, 3].map((revision) => run({ revision, runId: `run-${revision}` }));
    assert.ok(r1 !== undefined && r2 !== undefined && r3 !== undefined);
    assert.equal(latestRun([]), null);
    assert.equal(latestRun([r1]), r1);
    assert.equal(latestRun([r2, r3, r1]), r3);
    assert.equal(latestRun([r3, r1, r2]), r3);
  });

  it('leave the list they were given as it was', () => {
    const proposals = [proposal({ version: 2 }), proposal({ version: 1 })];
    const runs = [run({ revision: 2, runId: 'run-2' }), run({ revision: 1, runId: 'run-1' })];
    latestProposal(proposals);
    latestRun(runs);
    assert.deepEqual(
      proposals.map((item) => item.version),
      [2, 1],
    );
    assert.deepEqual(
      runs.map((item) => item.revision),
      [2, 1],
    );
  });
});

describe('snapshotConsistent', () => {
  const p1 = proposal({ version: 1, status: 'rejected' });
  const p2 = proposal({ version: 2, status: 'pending_approval' });
  const r1 = run({ runId: 'run-1', revision: 1, state: 'completed' });
  const r2 = run({ runId: 'run-2', revision: 2, state: 'completed' });
  const detail = caseDetail({ revision: 2, latestProposal: briefOf(p2), latestRun: r2 });

  it('accepts reads that describe the same moment, in any order', () => {
    assert.equal(snapshotConsistent(detail, [p1, p2], [r1, r2]), true);
    assert.equal(snapshotConsistent(detail, [p2, p1], [r2, r1]), true);
  });

  it('is not troubled by an older proposal or run that has changed since', () => {
    assert.equal(snapshotConsistent(detail, [proposal({ version: 1, status: 'superseded' }), p2], [run({ runId: 'run-1', revision: 1, state: 'failed' }), r2]), true);
  });

  it('refuses a proposal list that is newer or older than the case', () => {
    assert.equal(snapshotConsistent(detail, [p1, p2, proposal({ version: 3 })], [r1, r2]), false);
    assert.equal(snapshotConsistent(detail, [p1], [r1, r2]), false);
    assert.equal(snapshotConsistent(detail, [], [r1, r2]), false);
  });

  it('refuses a proposal whose status moved after the case was read', () => {
    assert.equal(snapshotConsistent(detail, [p1, proposal({ version: 2, status: 'approved' })], [r1, r2]), false);
  });

  it('refuses a run list that is newer or older than the case', () => {
    assert.equal(snapshotConsistent(detail, [p1, p2], [r1, r2, run({ runId: 'run-3', revision: 3 })]), false);
    assert.equal(snapshotConsistent(detail, [p1, p2], [r1]), false);
    assert.equal(snapshotConsistent(detail, [p1, p2], []), false);
  });

  it('refuses a run whose state moved after the case was read', () => {
    assert.equal(snapshotConsistent(detail, [p1, p2], [r1, run({ runId: 'run-2', revision: 2, state: 'failed' })]), false);
  });

  it('accepts a case with no proposal and no run only when none were listed', () => {
    const empty = caseDetail({ latestProposal: null, latestRun: null });
    assert.equal(snapshotConsistent(empty, [], []), true);
    assert.equal(snapshotConsistent(empty, [p1], []), false);
    assert.equal(snapshotConsistent(empty, [], [r1]), false);
  });

  it('accepts a case with a run but no proposal yet', () => {
    const investigating = caseDetail({ status: 'investigating', latestProposal: null, latestRun: run({ runId: 'run-1', revision: 1, state: 'running' }) });
    assert.equal(snapshotConsistent(investigating, [], [run({ runId: 'run-1', revision: 1, state: 'running' })]), true);
    assert.equal(snapshotConsistent(investigating, [], [run({ runId: 'run-1', revision: 1, state: 'completed' })]), false);
  });
});

describe('decisionAccess', () => {
  const pending = proposal({ status: 'pending_approval' });
  const approver = viewer(['Approver']);

  it('offers a decision to an approver who did not create the case', () => {
    assert.deepEqual(decisionAccess(approver, caseDetail(), pending), { kind: 'allowed' });
  });

  it('offers nothing when there is no proposal yet', () => {
    assert.deepEqual(decisionAccess(approver, caseDetail({ latestProposal: null }), null), { kind: 'none' });
  });

  it('shows a finding as a finding, which has nothing to approve', () => {
    for (const status of ['reported', 'pending_approval'] as const) {
      assert.deepEqual(decisionAccess(approver, caseDetail(), proposal({ kind: 'finding', status, amount: null })), { kind: 'finding' }, status);
    }
  });

  it('shows a proposal that is no longer pending as closed, whoever is looking', () => {
    for (const status of schemaEnum('ProposalStatus')) {
      if (status === 'pending_approval' || status === 'reported') continue;
      assert.deepEqual(decisionAccess(approver, caseDetail(), proposal({ status: status as typeof pending.status })), { kind: 'closed' }, status);
      assert.deepEqual(decisionAccess(viewer(['Representative']), caseDetail(), proposal({ status: status as typeof pending.status })), { kind: 'closed' }, status);
    }
  });

  it('does not offer a decision without the approver role', () => {
    for (const roles of [['Representative'], ['Operator'], ['Representative', 'Operator'], []] as Role[][]) {
      assert.deepEqual(decisionAccess(viewer(roles), caseDetail(), pending), { kind: 'not-approver' }, roles.join(','));
    }
  });

  it('does not offer a decision to the person who created the case, even with the approver role', () => {
    const both = viewer(['Representative', 'Approver'], REPRESENTATIVE_ID);
    assert.deepEqual(decisionAccess(both, caseDetail(), pending), { kind: 'creator' });
  });

  it('checks the role before the creator', () => {
    const creatorOnly = viewer(['Representative'], REPRESENTATIVE_ID);
    assert.deepEqual(decisionAccess(creatorOnly, caseDetail(), pending), { kind: 'not-approver' });
  });

  it('only counts a user as the creator, not an agent or the system that shares an id', () => {
    for (const type of ['agent', 'system'] as const) {
      const createdBy: Actor = { type, id: APPROVER_ID };
      assert.deepEqual(decisionAccess(approver, caseDetail({ createdBy }), pending), { kind: 'allowed' }, type);
    }
  });

  it('lets a different user approve a case someone else created', () => {
    const other = viewer(['Approver'], 'a9000000-0000-4000-8000-0000000000a9');
    assert.deepEqual(decisionAccess(other, caseDetail({ createdBy: { type: 'user', id: APPROVER_ID } }), pending), { kind: 'allowed' });
  });
});

describe('revisionAccess', () => {
  const representative = viewer(['Representative']);

  it('counts the revisions left from the run limit', () => {
    for (const status of REVISABLE) {
      for (let revision = 1; revision < CASE_LIMITS.maxRuns; revision += 1) {
        assert.deepEqual(
          revisionAccess(representative, caseDetail({ status: status as 'rejected', revision })),
          { kind: 'allowed', remaining: CASE_LIMITS.maxRuns - revision },
          `${status} ${revision}`,
        );
      }
    }
  });

  it('stops at the run limit, and beyond it', () => {
    for (const revision of [CASE_LIMITS.maxRuns, CASE_LIMITS.maxRuns + 1]) {
      assert.deepEqual(revisionAccess(representative, caseDetail({ status: 'rejected', revision })), { kind: 'limit' }, String(revision));
    }
  });

  it('is only for a case that is rejected, expired or has a finding', () => {
    for (const status of schemaEnum('CaseStatus')) {
      const access = revisionAccess(representative, caseDetail({ status: status as 'rejected', revision: 1 }));
      assert.equal(access.kind === 'not-now', !REVISABLE.includes(status), status);
    }
  });

  it('agrees with the statuses the service lets a case be revised from', () => {
    const source = readFileSync(new URL('../../src/cases/revise.ts', import.meta.url), 'utf8');
    const list = /const REVISABLE: readonly CaseStatus\[\] = \[([^\]]*)\];/.exec(source)?.[1];
    if (list === undefined) assert.fail('src/cases/revise.ts no longer declares REVISABLE in the form this test reads');
    const served = [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] ?? '');
    assert.deepEqual([...served].sort(), [...REVISABLE].sort());
  });

  it('is open to a representative or an approver, and no one else', () => {
    const rejected = caseDetail({ status: 'rejected', revision: 1 });
    for (const roles of [['Representative'], ['Approver'], ['Representative', 'Approver']] as Role[][]) {
      assert.equal(revisionAccess(viewer(roles), rejected).kind, 'allowed', roles.join(','));
    }
    for (const roles of [['Operator'], []] as Role[][]) {
      assert.deepEqual(revisionAccess(viewer(roles), rejected), { kind: 'no-role' }, roles.join(',') || 'no roles');
    }
  });

  it('says it is not the time before it says anything about roles or limits', () => {
    assert.deepEqual(revisionAccess(viewer([]), caseDetail({ status: 'awaiting_approval', revision: CASE_LIMITS.maxRuns })), { kind: 'not-now' });
  });

  it('says the role is missing before it says the limit is reached', () => {
    assert.deepEqual(revisionAccess(viewer(['Operator']), caseDetail({ status: 'rejected', revision: CASE_LIMITS.maxRuns })), { kind: 'no-role' });
  });
});

describe('evidenceTarget', () => {
  const ref = (invoiceId: string, lineIndex: number | null) => ({ invoiceId, lineIndex });

  it('shows the invoices the representative named when nothing is proposed yet', () => {
    const target = evidenceTarget(caseDetail({ latestProposal: null }), null);
    assert.equal(target.accountId, 'acct_aurora_0001');
    assert.deepEqual(target.invoiceIds, ['inv_aurora_0001_a', 'inv_aurora_0001_b']);
    assert.equal(target.cited.size, 0);
    assert.equal(target.policyRef, null);
    assert.equal(target.awaitingDecision, false);
  });

  it('puts the cited invoices first, then the ones that were named, once each', () => {
    const detail = caseDetail({ invoiceIds: ['inv_a', 'inv_b', 'inv_c'] });
    const target = evidenceTarget(detail, proposal({ invoiceRefs: [ref('inv_c', null), ref('inv_x', 0), ref('inv_c', 1)] }));
    assert.deepEqual(target.invoiceIds, ['inv_c', 'inv_x', 'inv_a', 'inv_b']);
  });

  it('records whole-invoice and single-line citations separately', () => {
    const target = evidenceTarget(caseDetail(), proposal({ invoiceRefs: [ref('inv_a', null), ref('inv_b', 2), ref('inv_b', 0), ref('inv_b', 2)] }));
    assert.deepEqual([...target.cited.keys()], ['inv_a', 'inv_b']);
    assert.deepEqual(target.cited.get('inv_a'), { whole: true, lines: new Set<number>() });
    assert.deepEqual(target.cited.get('inv_b'), { whole: false, lines: new Set([2, 0]) });
  });

  it('keeps the lines of an invoice that is also cited as a whole', () => {
    for (const refs of [[ref('inv_a', 1), ref('inv_a', null)], [ref('inv_a', null), ref('inv_a', 1)]]) {
      const target = evidenceTarget(caseDetail(), proposal({ invoiceRefs: refs }));
      assert.deepEqual(target.cited.get('inv_a'), { whole: true, lines: new Set([1]) });
    }
  });

  it('shows at most the evidence limit, keeping the cited invoices', () => {
    const named = Array.from({ length: 12 }, (_, index) => `inv_named_${String(index).padStart(2, '0')}`);
    const target = evidenceTarget(caseDetail({ invoiceIds: named }), proposal({ invoiceRefs: [ref('inv_cited_1', null), ref('inv_cited_2', 0)] }));
    assert.equal(MAX_EVIDENCE_INVOICES, 10);
    assert.equal(target.invoiceIds.length, MAX_EVIDENCE_INVOICES);
    assert.deepEqual(target.invoiceIds.slice(0, 2), ['inv_cited_1', 'inv_cited_2']);
    assert.deepEqual(target.invoiceIds.slice(2), named.slice(0, MAX_EVIDENCE_INVOICES - 2));
  });

  it('passes on the policy citation and whether a decision is waiting', () => {
    const pending = evidenceTarget(caseDetail(), proposal({ status: 'pending_approval' }));
    assert.deepEqual(pending.policyRef, { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' });
    assert.equal(pending.awaitingDecision, true);
    for (const status of schemaEnum('ProposalStatus')) {
      if (status === 'pending_approval') continue;
      assert.equal(evidenceTarget(caseDetail(), proposal({ status: status as 'approved' })).awaitingDecision, false, status);
    }
    assert.equal(evidenceTarget(caseDetail(), proposal({ policyRef: null })).policyRef, null);
  });

  describe('key', () => {
    const base = evidenceTarget(caseDetail(), proposal());

    it('changes when what the evidence view shows changes', () => {
      const changed = {
        account: evidenceTarget(caseDetail({ accountId: 'acct_aurora_0002' }), proposal()),
        named: evidenceTarget(caseDetail({ invoiceIds: ['inv_aurora_0001_a', 'inv_aurora_0001_c'] }), proposal()),
        cited: evidenceTarget(caseDetail(), proposal({ invoiceRefs: [ref('inv_aurora_0001_a', null)] })),
        version: evidenceTarget(caseDetail(), proposal({ version: 2 })),
        digest: evidenceTarget(caseDetail(), proposal({ digest: `sha256:${'cd'.repeat(32)}` })),
        decided: evidenceTarget(caseDetail(), proposal({ status: 'approved' })),
        noProposal: evidenceTarget(caseDetail(), null),
      };
      for (const [name, target] of Object.entries(changed)) assert.notEqual(target.key, base.key, name);
    });

    it('does not change when only something the evidence view does not show changes', () => {
      const same = evidenceTarget(
        caseDetail({ updatedAt: '2026-10-29T12:00:00.000Z', description: 'Reworded.', status: 'awaiting_approval' }),
        proposal({ explanation: 'Reworded.', createdAt: '2026-10-29T09:30:00.000Z', approvalExpiresAt: '2026-11-02T09:00:00.000Z' }),
      );
      assert.equal(same.key, base.key);
    });
  });
});
