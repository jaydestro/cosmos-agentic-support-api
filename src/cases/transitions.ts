import { briefOf, SYSTEM_ACTOR, type CaseDoc, type CaseStatus, type Decision, type ProposalDoc, type TimelineDraft } from './documents.ts';

/** The proposal once a human decided it. The decision is stored with it and never edited afterwards. */
export const decidedProposal = (proposal: ProposalDoc, decision: Decision): ProposalDoc => ({
  ...proposal,
  status: decision.outcome,
  decision,
});

export const expiredProposal = (proposal: ProposalDoc): ProposalDoc => ({ ...proposal, status: 'expired' });

export const executedProposal = (proposal: ProposalDoc): ProposalDoc => ({ ...proposal, status: 'executed' });

/** The case after its latest proposal changed state: the status and the denormalised brief move together. */
export const caseAfter = (caseDoc: CaseDoc, proposal: ProposalDoc, status: CaseStatus): CaseDoc => ({
  ...caseDoc,
  status,
  latestProposal: briefOf(proposal),
});

/** Written by whichever writer first observes that an approval lapsed; nothing sweeps for it. */
export const expiryDraft = (proposal: ProposalDoc): TimelineDraft => ({
  kind: 'approval_expired',
  actor: SYSTEM_ACTOR,
  summary: `Approval of proposal v${String(proposal.version)} expired without a decision.`,
  data: { proposalVersion: proposal.version, approvalExpiresAt: proposal.approvalExpiresAt },
});
