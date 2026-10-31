import type { ReferenceStore } from '../data/reference.ts';
import { effectivePolicy } from '../domain/policy.ts';
import { newOutboxDoc } from '../outbox/types.ts';
import type { Logger } from '../telemetry/log.ts';
import {
  appendTimeline,
  approvalHasExpired,
  CASE_DOC_ID,
  decisionIdFor,
  derivedStatus,
  proposalDocId,
  SYSTEM_ACTOR,
  type CaseDoc,
  type CaseStatus,
  type Decision,
  type ProposalDoc,
  type ProposalStatus,
} from './documents.ts';
import { withRetries } from './retry.ts';
import { CaseWriteError, type CaseOp, type CaseStore, type Versioned } from './store.ts';
import { caseAfter, decidedProposal, expiredProposal, expiryDraft } from './transitions.ts';

export interface DecideDeps {
  readonly cases: CaseStore;
  readonly reference: Pick<ReferenceStore, 'listPolicyVersions'>;
  readonly logger: Logger;
}

export interface DecideInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly version: number;
  readonly principalId: string;
  readonly outcome: Decision['outcome'];
  /** What the approver saw: the decision is bound to this policy version and proposal digest. */
  readonly policyVersion: number;
  readonly proposalDigest: string;
  /** The rejection reason, or the optional approval comment. Untrusted text, stored and shown as data. */
  readonly reason: string | null;
  readonly now: Date;
}

/** Each refusal is a stable problem code of the API. */
export type DecisionRefusal =
  | 'forbidden_separation_of_duties'
  | 'proposal_not_decidable'
  | 'proposal_already_decided'
  | 'approval_expired'
  | 'proposal_superseded'
  | 'proposal_digest_mismatch'
  | 'policy_version_mismatch'
  | 'policy_version_changed'
  | 'concurrent_update';

export type DecideOutcome =
  | { kind: 'decided'; decision: Decision; caseStatus: CaseStatus; replayed: boolean }
  | { kind: 'not_found' }
  | { kind: 'refused'; code: DecisionRefusal };

const refused = (code: DecisionRefusal): DecideOutcome => ({ kind: 'refused', code });

/**
 * Records one human decision on the exact proposal the approver saw.
 *
 * The decision, the proposal and case transitions, the timeline items and (for an approval) the
 * `credit.execute` outbox item commit in one ETag-guarded batch, so there is no state in which a
 * credit is approved but not queued, or queued but not approved. The credit itself is issued later by
 * deterministic code that revalidates everything again. Repeating an identical decision by the same
 * approver replays the stored one; any other second decision is refused.
 */
export function decideProposal(deps: DecideDeps, input: DecideInput): Promise<DecideOutcome> {
  return withRetries(
    () => evaluate(deps, input),
    () => refused('concurrent_update'),
  );
}

async function evaluate(deps: DecideDeps, input: DecideInput): Promise<DecideOutcome> {
  const { cases, reference } = deps;
  const { tenantId, caseId, version, now } = input;

  const caseRow = await cases.get('case', tenantId, caseId, CASE_DOC_ID);
  if (caseRow === null) return { kind: 'not_found' };
  // Maker-checker: whoever opened the dispute may not also approve or reject its credit.
  if (caseRow.doc.createdBy.id === input.principalId) return refused('forbidden_separation_of_duties');

  const proposalRow = await cases.get('proposal', tenantId, caseId, proposalDocId(version));
  if (proposalRow === null) return { kind: 'not_found' };
  const proposal = proposalRow.doc;

  if (proposal.decision !== null) {
    return isRepeat(proposal.decision, input)
      ? { kind: 'decided', decision: proposal.decision, caseStatus: derivedStatus(caseRow.doc, now), replayed: true }
      : refused('proposal_already_decided');
  }
  const unusable = refusalForStatus(proposal.status);
  if (unusable !== null) return refused(unusable);
  if (version !== caseRow.doc.revision) return refused('proposal_superseded');

  if (approvalHasExpired(proposal, now)) {
    await recordExpiry(deps, caseRow, proposalRow, now);
    return refused('approval_expired');
  }
  if (input.proposalDigest !== proposal.digest) return refused('proposal_digest_mismatch');
  const cited = proposal.policyRef;
  if (cited === null || input.policyVersion !== cited.version) return refused('policy_version_mismatch');
  // Only an approval needs the cited version to still be the effective one. A rejection issues nothing,
  // and refusing it would strand a stale proposal until its approval window lapses.
  if (input.outcome === 'approved') {
    const versions = await reference.listPolicyVersions(tenantId, cited.policyId);
    if (effectivePolicy(versions, now, cited.policyId)?.version !== cited.version) return refused('policy_version_changed');
  }

  const decision = newDecision(input);
  const approving = decision.outcome === 'approved';
  await cases.commit(tenantId, caseId, approving ? approvalOps(caseRow, proposalRow, decision, now) : rejectionOps(caseRow, proposalRow, decision, now));
  return { kind: 'decided', decision, caseStatus: approving ? 'approved' : 'rejected', replayed: false };
}

function refusalForStatus(status: ProposalStatus): DecisionRefusal | null {
  switch (status) {
    case 'pending_approval':
      return null;
    case 'reported':
      return 'proposal_not_decidable';
    case 'expired':
      return 'approval_expired';
    case 'superseded':
      return 'proposal_superseded';
    case 'approved':
    case 'rejected':
    case 'executed':
      return 'proposal_already_decided';
  }
}

const isRepeat = (decision: Decision, input: DecideInput): boolean =>
  decision.outcome === input.outcome &&
  decision.decidedBy.id === input.principalId &&
  decision.proposalDigest === input.proposalDigest &&
  decision.policyVersion === input.policyVersion &&
  decision.reason === input.reason;

const newDecision = (input: DecideInput): Decision => ({
  decisionId: decisionIdFor(input.caseId, input.version),
  caseId: input.caseId,
  proposalVersion: input.version,
  policyVersion: input.policyVersion,
  proposalDigest: input.proposalDigest,
  outcome: input.outcome,
  reason: input.reason,
  decidedBy: { type: 'user', id: input.principalId },
  decidedAt: input.now.toISOString(),
});

function approvalOps(caseRow: Versioned<CaseDoc>, proposalRow: Versioned<ProposalDoc>, decision: Decision, now: Date): CaseOp[] {
  const proposal = proposalRow.doc;
  const approved = decidedProposal(proposal, decision);
  const { caseDoc, docs } = appendTimeline(
    caseAfter(caseRow.doc, approved, 'approved'),
    [
      {
        kind: 'decision_approved',
        actor: decision.decidedBy,
        summary: `Proposal v${String(proposal.version)} approved.`,
        data: {
          proposalVersion: proposal.version,
          policyVersion: decision.policyVersion,
          amountMinor: proposal.amount?.amountMinor ?? null,
          currency: proposal.amount?.currency ?? null,
          comment: decision.reason,
        },
      },
      {
        kind: 'execution_queued',
        actor: SYSTEM_ACTOR,
        summary: `Credit execution queued for proposal v${String(proposal.version)}.`,
        data: { proposalVersion: proposal.version },
      },
    ],
    now,
  );
  const outbox = newOutboxDoc({
    tenantId: proposal.tenantId,
    caseId: proposal.caseId,
    kind: 'credit.execute',
    key: `v${String(proposal.version)}`,
    payload: { proposalVersion: proposal.version, digest: proposal.digest },
    now,
  });
  return [
    { op: 'replace', doc: caseDoc, etag: caseRow.etag },
    { op: 'replace', doc: approved, etag: proposalRow.etag },
    ...docs.map((doc): CaseOp => ({ op: 'create', doc })),
    { op: 'create', doc: outbox },
  ];
}

function rejectionOps(caseRow: Versioned<CaseDoc>, proposalRow: Versioned<ProposalDoc>, decision: Decision, now: Date): CaseOp[] {
  const proposal = proposalRow.doc;
  const rejected = decidedProposal(proposal, decision);
  const { caseDoc, docs } = appendTimeline(
    caseAfter(caseRow.doc, rejected, 'rejected'),
    [
      {
        kind: 'decision_rejected',
        actor: decision.decidedBy,
        summary: `Proposal v${String(proposal.version)} rejected.`,
        data: { proposalVersion: proposal.version, policyVersion: decision.policyVersion, reason: decision.reason },
      },
    ],
    now,
  );
  return [
    { op: 'replace', doc: caseDoc, etag: caseRow.etag },
    { op: 'replace', doc: rejected, etag: proposalRow.etag },
    ...docs.map((doc): CaseOp => ({ op: 'create', doc })),
  ];
}

/**
 * Expiry is derived on every read. The first writer that observes it also records it, but only as
 * a courtesy: losing the race to another writer, or failing outright, never changes the refusal.
 */
async function recordExpiry(
  deps: DecideDeps,
  caseRow: Versioned<CaseDoc>,
  proposalRow: Versioned<ProposalDoc>,
  now: Date,
): Promise<void> {
  const expired = expiredProposal(proposalRow.doc);
  const status = caseRow.doc.status === 'awaiting_approval' ? 'expired' : caseRow.doc.status;
  const { caseDoc, docs } = appendTimeline(caseAfter(caseRow.doc, expired, status), [expiryDraft(proposalRow.doc)], now);
  try {
    await deps.cases.commit(caseDoc.tenantId, caseDoc.caseId, [
      { op: 'replace', doc: caseDoc, etag: caseRow.etag },
      { op: 'replace', doc: expired, etag: proposalRow.etag },
      ...docs.map((doc): CaseOp => ({ op: 'create', doc })),
    ]);
  } catch (error) {
    if (error instanceof CaseWriteError) return;
    deps.logger.warn('approval expiry could not be recorded', { caseId: caseDoc.caseId, error });
  }
}
