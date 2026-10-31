import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TERMINAL_RUN_STATES,
  appendTimeline,
  approvalHasExpired,
  briefOf,
  deriveBrief,
  derivedStatus,
  isTerminalRun,
  newCaseDoc,
  newProposalDoc,
  newRunDoc,
  proposalDigest,
  runKeyFor,
  toCaseSummary,
  toProposal,
  toRun,
  toTimelineItem,
  toUsageEvent,
  type ProposalContent,
  type RunState,
} from '../../src/cases/documents.ts';
import { BASE_RUN_LIMITS } from '../../src/config/limits.ts';
import { loadContract } from '../../src/contract/load.ts';
import { addMs } from '../../src/domain/time.ts';
import { AT, newCaseId, sampleCase, sampleProposal, sampleRun, sampleTimeline, sampleUsage } from '../support/case-fixtures.ts';

const TENANT = 'aurora';
const NOW = new Date(AT);
const TTL_MS = 3 * 24 * 60 * 60 * 1000;
const contract = loadContract();

const credit = (): ProposalContent => ({
  kind: 'credit',
  amount: { amountMinor: 4900, currency: 'USD' },
  explanation: 'Two paid invoices cover one period.',
  invoiceRefs: [
    { invoiceId: 'inv_aurora_0001_b', lineIndex: null },
    { invoiceId: 'inv_aurora_0001_a', lineIndex: 0 },
  ],
  policyRef: { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' },
  findingCode: null,
  evidenceAssessment: 'consistent',
});

const finding = (): ProposalContent => ({
  kind: 'finding',
  amount: null,
  explanation: 'The cited invoice does not exist.',
  invoiceRefs: [],
  policyRef: null,
  findingCode: 'missing_evidence',
  evidenceAssessment: 'missing',
});

function proposalOf(content: ProposalContent, caseId: string, version = 1, now: Date = NOW) {
  return newProposalDoc({ tenantId: TENANT, caseId, runId: `run-${String(version)}`, version, content, now, approvalTtlMs: TTL_MS });
}

describe('proposal documents', () => {
  it('holds a credit for approval until the configured time', () => {
    const caseId = newCaseId();
    const doc = proposalOf(credit(), caseId);
    assert.equal(doc.id, 'proposal-1');
    assert.equal(doc.type, 'proposal');
    assert.equal(doc.tenantId, TENANT);
    assert.equal(doc.caseId, caseId);
    assert.equal(doc.status, 'pending_approval');
    assert.equal(doc.decision, null);
    assert.equal(doc.createdAt, NOW.toISOString());
    assert.equal(doc.approvalExpiresAt, addMs(NOW, TTL_MS).toISOString());
    assert.deepEqual(contract.validateComponent('Proposal', toProposal(doc, NOW)), []);
  });

  it('only reports a finding: nothing to approve, so no expiry and no decision', () => {
    const doc = proposalOf(finding(), newCaseId());
    assert.equal(doc.status, 'reported');
    assert.equal(doc.approvalExpiresAt, null);
    assert.equal(doc.decision, null);
    assert.equal(doc.amount, null);
    assert.deepEqual(contract.validateComponent('Proposal', toProposal(doc, NOW)), []);
    const muchLater = addMs(NOW, 10 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(toProposal(doc, muchLater).status, 'reported', 'a finding never expires');
  });

  it('numbers the proposal after the run that produced it', () => {
    const doc = proposalOf(credit(), newCaseId(), 3);
    assert.equal(doc.id, 'proposal-3');
    assert.equal(doc.version, 3);
    assert.equal(doc.runId, 'run-3');
  });

  it('shares nothing with the content it was built from', () => {
    const content = credit();
    const doc = proposalOf(content, newCaseId());
    const before = JSON.stringify(doc);
    if (content.amount !== null) content.amount.amountMinor = 1;
    const [first] = content.invoiceRefs;
    if (first !== undefined) first.invoiceId = 'inv_changed_after_the_fact';
    if (content.policyRef !== null) content.policyRef.version = 99;
    content.invoiceRefs.push({ invoiceId: 'inv_added_after_the_fact', lineIndex: null });
    assert.equal(JSON.stringify(doc), before);
  });

  it('summarises itself for the case without the explanation', () => {
    const doc = proposalOf(credit(), newCaseId());
    assert.deepEqual(briefOf(doc), {
      version: 1,
      kind: 'credit',
      status: 'pending_approval',
      amount: { amountMinor: 4900, currency: 'USD' },
      approvalExpiresAt: doc.approvalExpiresAt,
    });
  });

  describe('digest', () => {
    const caseId = newCaseId();
    const base = (): Parameters<typeof proposalDigest>[0] => ({ caseId, version: 1, runId: 'run-1', ...credit() });

    it('has the contract format and is stored with the proposal', () => {
      const doc = proposalOf(credit(), caseId);
      assert.match(doc.digest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(doc.digest, proposalDigest(base()));
      const fixture = sampleProposal(TENANT, caseId);
      assert.equal(fixture.digest, proposalDigest(fixture), 'a stored proposal digests its own fields');
    });

    it('does not depend on the order in which properties are written', () => {
      const shuffled = {
        evidenceAssessment: 'consistent' as const,
        findingCode: null,
        policyRef: { clauseId: 'dup-charge', version: 2, policyId: 'credit-policy' },
        invoiceRefs: [
          { lineIndex: null, invoiceId: 'inv_aurora_0001_b' },
          { lineIndex: 0, invoiceId: 'inv_aurora_0001_a' },
        ],
        explanation: 'Two paid invoices cover one period.',
        amount: { currency: 'USD' as const, amountMinor: 4900 },
        kind: 'credit' as const,
        runId: 'run-1',
        version: 1,
        caseId,
      };
      assert.equal(proposalDigest(shuffled), proposalDigest(base()));
    });

    const changes: [string, (value: ReturnType<typeof base>) => ReturnType<typeof base>][] = [
      ['the case', (v) => ({ ...v, caseId: newCaseId() })],
      ['the version', (v) => ({ ...v, version: 2 })],
      ['the run', (v) => ({ ...v, runId: 'run-2' })],
      ['the kind', (v) => ({ ...v, kind: 'finding' })],
      ['the amount', (v) => ({ ...v, amount: { amountMinor: 4901, currency: 'USD' } })],
      ['the currency', (v) => ({ ...v, amount: { amountMinor: 4900, currency: 'EUR' } })],
      ['the explanation', (v) => ({ ...v, explanation: `${v.explanation} ` })],
      ['the order of the invoice references', (v) => ({ ...v, invoiceRefs: v.invoiceRefs.toReversed() })],
      ['an invoice reference', (v) => ({ ...v, invoiceRefs: [{ invoiceId: 'inv_aurora_0001_b', lineIndex: 1 }, ...v.invoiceRefs.slice(1)] })],
      ['a dropped invoice reference', (v) => ({ ...v, invoiceRefs: v.invoiceRefs.slice(0, 1) })],
      ['the policy version', (v) => ({ ...v, policyRef: { policyId: 'credit-policy', version: 1, clauseId: 'dup-charge' } })],
      ['the policy clause', (v) => ({ ...v, policyRef: { policyId: 'credit-policy', version: 2, clauseId: 'outage-sla' } })],
      ['the policy', (v) => ({ ...v, policyRef: { policyId: 'other-policy', version: 2, clauseId: 'dup-charge' } })],
      ['the finding code', (v) => ({ ...v, findingCode: 'no_credit_due' })],
      ['the evidence assessment', (v) => ({ ...v, evidenceAssessment: 'missing' })],
    ];
    for (const [what, change] of changes) {
      it(`changes with ${what}`, () => {
        assert.notEqual(proposalDigest(change(base())), proposalDigest(base()));
      });
    }

    it('does not change as the proposal is decided, expires or is stored', () => {
      const doc = proposalOf(credit(), caseId);
      const decided = { ...doc, status: 'approved' as const, createdAt: '2030-01-01T00:00:00.000Z', approvalExpiresAt: null };
      decided.decision = {
        decisionId: 'dec-1',
        caseId,
        proposalVersion: 1,
        policyVersion: 2,
        proposalDigest: doc.digest,
        outcome: 'approved',
        reason: null,
        decidedBy: { type: 'user', id: 'approver-1' },
        decidedAt: AT,
      };
      assert.equal(proposalDigest(decided), doc.digest);
    });
  });
});

describe('approval expiry', () => {
  const pending = (approvalExpiresAt: string | null) => ({ status: 'pending_approval' as const, approvalExpiresAt });

  it('has passed from the expiry instant on, not before', () => {
    const expiry = '2026-03-04T10:00:00.000Z';
    assert.equal(approvalHasExpired(pending(expiry), new Date('2026-03-04T09:59:59.999Z')), false);
    assert.equal(approvalHasExpired(pending(expiry), new Date(expiry)), true);
    assert.equal(approvalHasExpired(pending(expiry), new Date('2026-03-04T10:00:00.001Z')), true);
  });

  it('applies only to a proposal still waiting for a decision', () => {
    const later = new Date('2030-01-01T00:00:00.000Z');
    for (const status of ['reported', 'approved', 'rejected', 'expired', 'executed', 'superseded'] as const) {
      assert.equal(approvalHasExpired({ status, approvalExpiresAt: '2026-03-04T10:00:00.000Z' }, later), false, status);
    }
    assert.equal(approvalHasExpired(pending(null), later), false);
  });

  describe('as seen by a reader', () => {
    const waiting = () => {
      const doc = sampleCase(TENANT, newCaseId(), { status: 'awaiting_approval' });
      doc.latestProposal = { version: 1, kind: 'credit', status: 'pending_approval', amount: { amountMinor: 4900, currency: 'USD' }, approvalExpiresAt: '2026-03-04T10:00:00.000Z' };
      return doc;
    };
    const before = new Date('2026-03-04T09:00:00.000Z');
    const after = new Date('2026-03-04T10:00:00.000Z');

    it('shows an overdue approval as expired without touching what is stored', () => {
      const doc = waiting();
      const stored = JSON.stringify(doc);
      assert.equal(derivedStatus(doc, before), 'awaiting_approval');
      assert.equal(derivedStatus(doc, after), 'expired');
      const summary = toCaseSummary(doc, after);
      assert.equal(summary.status, 'expired');
      assert.equal(summary.latestProposal?.status, 'expired');
      assert.equal(toCaseSummary(doc, before).latestProposal?.status, 'pending_approval');
      assert.equal(JSON.stringify(doc), stored);
    });

    it('derives expiry only for a case that is awaiting approval', () => {
      for (const status of ['queued', 'investigating', 'finding_reported', 'approved', 'credited', 'rejected', 'needs_attention'] as const) {
        assert.equal(derivedStatus({ status, latestProposal: waiting().latestProposal }, after), status, status);
      }
      assert.equal(derivedStatus({ status: 'awaiting_approval', latestProposal: null }, after), 'awaiting_approval');
    });

    it('leaves a missing brief missing and a live brief as it is', () => {
      assert.equal(deriveBrief(null, after), null);
      const live = waiting().latestProposal;
      assert.equal(deriveBrief(live, before), live);
    });

    it('shows an overdue proposal as expired in its own representation', () => {
      const doc = proposalOf(credit(), newCaseId());
      assert.equal(toProposal(doc, addMs(NOW, TTL_MS - 1)).status, 'pending_approval');
      assert.equal(toProposal(doc, addMs(NOW, TTL_MS)).status, 'expired');
      assert.equal(doc.status, 'pending_approval', 'the stored status is not changed by reading');
    });
  });
});

describe('timeline allocation', () => {
  it('numbers new items from the case counter and advances it', () => {
    const doc = sampleCase(TENANT, newCaseId(), { nextSeq: 5 });
    const frozen = JSON.stringify(doc);
    const later = new Date('2026-03-01T10:00:07.000Z');
    const { caseDoc, docs } = appendTimeline(
      doc,
      [
        { kind: 'tool_called', actor: { type: 'agent', id: 'investigator' }, summary: 'one' },
        { kind: 'proposal_submitted', actor: { type: 'agent', id: 'investigator' }, summary: 'two', data: { amountMinor: 4900, simulated: true, note: null } },
      ],
      later,
    );
    assert.deepEqual(
      docs.map((item) => [item.id, item.seq]),
      [
        ['tl-00005', 5],
        ['tl-00006', 6],
      ],
    );
    assert.equal(caseDoc.nextSeq, 7);
    assert.equal(caseDoc.updatedAt, later.toISOString());
    assert.equal(JSON.stringify(doc), frozen, 'the input case is not modified');
    assert.ok(docs.every((item) => item.tenantId === TENANT && item.caseId === doc.caseId && item.type === 'timeline' && item.at === later.toISOString()));
    assert.ok(!('data' in (docs[0] ?? {})), 'no data property when there is no data');
    assert.deepEqual(docs[1]?.data, { amountMinor: 4900, simulated: true, note: null });
  });

  it('allocates nothing for no items', () => {
    const doc = sampleCase(TENANT, newCaseId(), { nextSeq: 3 });
    const { caseDoc, docs } = appendTimeline(doc, [], NOW);
    assert.equal(docs.length, 0);
    assert.equal(caseDoc.nextSeq, 3);
  });
});

describe('new documents', () => {
  it('starts a run queued, with nothing spent and its limits copied', () => {
    const limits = { ...BASE_RUN_LIMITS };
    const doc = newRunDoc({ tenantId: TENANT, caseId: newCaseId(), revision: 2, mode: 'demo', limits, now: NOW, revisionReason: 'Please recheck the March invoice.' });
    limits.steps = 1;
    assert.equal(doc.id, 'run-2');
    assert.equal(doc.runId, 'run-2');
    assert.equal(doc.state, 'queued');
    assert.equal(doc.limits.steps, BASE_RUN_LIMITS.steps, 'a later change to the source limits does not reach the run');
    assert.equal(doc.nextEventSeq, 1);
    assert.deepEqual(doc.charged, { tokens: 0, costMicroUsd: 0 });
    assert.deepEqual(doc.reserved, { tokens: 0, costMicroUsd: 0 });
    assert.equal(doc.allowanceGrants, 0);
    assert.equal(doc.revisionReason, 'Please recheck the March invoice.');
    assert.equal(newRunDoc({ tenantId: TENANT, caseId: newCaseId(), revision: 1, mode: 'demo', limits, now: NOW }).revisionReason, null);
  });

  it('records no measurement for a demo run and a measured zero for a live one', () => {
    const demo = sampleRun(TENANT, newCaseId());
    assert.equal(demo.usage.inputTokens, null);
    assert.equal(demo.usage.tokenQuality, 'not_applicable');
    assert.equal(demo.usage.costMicroUsd, null);
    const live = newRunDoc({ tenantId: TENANT, caseId: newCaseId(), revision: 1, mode: 'live', limits: BASE_RUN_LIMITS, now: NOW });
    assert.equal(live.usage.inputTokens, 0);
    assert.equal(live.usage.tokenQuality, 'measured');
    assert.equal(live.usage.costMicroUsd, 0);
    assert.equal(live.usage.costQuality, 'measured');
  });

  it('starts a case queued at revision one with its first run named', () => {
    const caseId = newCaseId();
    const doc = newCaseDoc({
      tenantId: TENANT,
      caseId,
      createdBy: { type: 'user', id: 'user-1' },
      request: { accountId: 'acct_aurora_0001', category: 'duplicate_charge', invoiceIds: ['inv_aurora_0001_a'], description: 'Charged twice.' },
      now: NOW,
      runId: 'run-1',
    });
    assert.equal(doc.id, 'case');
    assert.equal(doc.status, 'queued');
    assert.equal(doc.revision, 1);
    assert.equal(doc.nextSeq, 1);
    assert.equal(doc.latestRunId, 'run-1');
    assert.equal(doc.latestProposal, null);
    assert.equal(doc.requestedCredit, null);
    assert.equal(doc.sortKey, `${AT}~${caseId}`);
    assert.deepEqual(doc.invoiceIds, ['inv_aurora_0001_a']);
  });

  it('copies the cited invoices instead of sharing the request array', () => {
    const invoiceIds = ['inv_aurora_0001_a'];
    const doc = newCaseDoc({
      tenantId: TENANT,
      caseId: newCaseId(),
      createdBy: { type: 'user', id: 'user-1' },
      request: { accountId: 'acct_aurora_0001', category: 'duplicate_charge', invoiceIds, description: 'x' },
      now: NOW,
      runId: 'run-1',
    });
    invoiceIds.push('inv_aurora_0001_b');
    assert.deepEqual(doc.invoiceIds, ['inv_aurora_0001_a']);
  });

  it('names one concurrency slot per run of a case', () => {
    assert.equal(runKeyFor('case_0123', 'run-1'), 'case_0123:run-1');
    assert.notEqual(runKeyFor('case_0123', 'run-1'), runKeyFor('case_0123', 'run-2'));
    assert.notEqual(runKeyFor('case_0123', 'run-1'), runKeyFor('case_0124', 'run-1'));
  });

  it('treats exactly the finished run states as terminal', () => {
    const states: RunState[] = ['queued', 'running', 'completed', 'failed', 'budget_exhausted', 'blocked'];
    for (const state of states) assert.equal(isTerminalRun(state), TERMINAL_RUN_STATES.includes(state), state);
    assert.deepEqual(
      states.filter(isTerminalRun),
      ['completed', 'failed', 'budget_exhausted', 'blocked'],
    );
  });
});

describe('what the API shows', () => {
  const caseId = newCaseId();

  it('shows a case summary that matches the contract and not the stored description', () => {
    const summary = toCaseSummary(sampleCase(TENANT, caseId), NOW);
    assert.deepEqual(contract.validateComponent('CaseSummary', summary), []);
    for (const hidden of ['description', 'invoiceIds', 'requestedCredit', 'latestRunId', 'nextSeq', 'sortKey', 'schemaVersion', 'type', 'id']) {
      assert.ok(!(hidden in summary), `the summary leaks ${hidden}`);
    }
  });

  it('shows a run that matches the contract and not its internal accounting', () => {
    const run = toRun(sampleRun(TENANT, caseId));
    assert.deepEqual(contract.validateComponent('Run', run), []);
    for (const hidden of ['charged', 'reserved', 'nextEventSeq', 'revisionReason', 'updatedAt', 'tenantId', 'schemaVersion', 'type', 'id']) {
      assert.ok(!(hidden in run), `the run leaks ${hidden}`);
    }
  });

  it('shows a usage event that matches the contract and not its reservation', () => {
    const event = toUsageEvent(sampleUsage(TENANT, caseId, 'run-1', 1));
    assert.deepEqual(contract.validateComponent('UsageEvent', event), []);
    for (const hidden of ['reservedTokens', 'reservedCostMicroUsd', 'tenantId', 'caseId', 'schemaVersion', 'type', 'id']) {
      assert.ok(!(hidden in event), `the usage event leaks ${hidden}`);
    }
  });

  it('shows a timeline item that matches the contract and not its storage fields', () => {
    const item = toTimelineItem(sampleTimeline(TENANT, caseId, 4, { data: { reason: 'steps_exhausted', overshoot: 0 } }));
    assert.deepEqual(contract.validateComponent('TimelineItem', item), []);
    for (const hidden of ['tenantId', 'caseId', 'schemaVersion', 'type', 'id']) {
      assert.ok(!(hidden in item), `the timeline item leaks ${hidden}`);
    }
  });
});
