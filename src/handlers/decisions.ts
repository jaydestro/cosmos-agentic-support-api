import { decideProposal, type DecideOutcome, type DecisionRefusal } from '../cases/decide.ts';
import type { ApproveRequest, Decision, RejectRequest, RevisionRequest } from '../cases/documents.ts';
import { reviseCase, type ReviseRefusal } from '../cases/revise.ts';
import { principalOf } from '../http/pipeline.ts';
import { notFound, tooMany } from '../http/problem.ts';
import { POLL_AFTER_SECONDS, REJECTION_TITLES, refusalError, type RefusalProblem } from './shared.ts';
import { pathInteger, pathString, type Ctx, type Handler } from './types.ts';

// Human-entered reasons and comments are untrusted text. They are stored and shown as data, and they
// are never written to diagnostics: the logs below carry identifiers and outcomes only.

const DECISION_PROBLEMS: Readonly<Record<DecisionRefusal, RefusalProblem>> = Object.freeze({
  forbidden_separation_of_duties: { status: 403, title: 'The creator of a case cannot decide its credit' },
  proposal_not_decidable: { status: 409, title: 'This proposal does not await a decision' },
  proposal_already_decided: { status: 409, title: 'This proposal was already decided' },
  approval_expired: { status: 409, title: 'The approval window for this proposal has closed' },
  proposal_superseded: { status: 409, title: 'A newer proposal replaced this one' },
  proposal_digest_mismatch: { status: 409, title: 'The digest is not that of the proposal on record' },
  policy_version_mismatch: { status: 409, title: 'The policy version is not the one the proposal cites' },
  policy_version_changed: { status: 409, title: 'The cited policy version is no longer in effect' },
  concurrent_update: { status: 409, title: 'The case changed while the decision was being recorded; retry' },
});

const REVISION_PROBLEMS: Readonly<Record<ReviseRefusal, RefusalProblem>> = Object.freeze({
  revision_not_allowed: { status: 409, title: 'A revision needs a rejected, expired or finding-only case' },
  revision_limit_reached: { status: 409, title: 'The case has used all of its revisions' },
  concurrent_update: { status: 409, title: 'The case changed while the revision was being recorded; retry' },
});

type Decided = Extract<DecideOutcome, { kind: 'decided' }>;

async function decide(ctx: Ctx, outcome: Decision['outcome'], body: ApproveRequest | RejectRequest, reason: string | null): Promise<Decided> {
  const { tenantId, principalId } = principalOf(ctx);
  const { cases, reference } = ctx.services;
  const caseId = pathString(ctx, 'caseId');
  const version = pathInteger(ctx, 'version');
  const result = await decideProposal(
    { cases, reference, logger: ctx.logger },
    {
      tenantId,
      caseId,
      version,
      principalId,
      outcome,
      policyVersion: body.policyVersion,
      proposalDigest: body.proposalDigest,
      reason,
      now: ctx.now,
    },
  );
  switch (result.kind) {
    case 'decided':
      ctx.logger.info('proposal decided', { caseId, proposalVersion: version, outcome, replayed: result.replayed });
      return result;
    case 'not_found':
      throw notFound();
    case 'refused':
      throw refusalError(result.code, DECISION_PROBLEMS[result.code]);
  }
}

export const approveProposal: Handler = async (ctx) => {
  // The pipeline already validated the body against the closed ApproveRequest schema.
  const body = ctx.body as ApproveRequest;
  const { decision, caseStatus } = await decide(ctx, 'approved', body, body.comment ?? null);
  return {
    status: 202,
    body: { decision, caseStatus },
    headers: { Location: `/api/cases/${decision.caseId}`, 'Retry-After': String(POLL_AFTER_SECONDS) },
  };
};

export const rejectProposal: Handler = async (ctx) => {
  const body = ctx.body as RejectRequest;
  const { decision } = await decide(ctx, 'rejected', body, body.reason);
  return { status: 200, body: decision };
};

export const requestRevision: Handler = async (ctx) => {
  const { tenantId, principalId } = principalOf(ctx);
  const { cases, admission, config } = ctx.services;
  const caseId = pathString(ctx, 'caseId');
  const body = ctx.body as RevisionRequest;
  const result = await reviseCase(
    { cases, admission, config, logger: ctx.logger },
    { tenantId, caseId, principalId, reason: body.reason, now: ctx.now },
  );
  switch (result.kind) {
    case 'accepted':
      ctx.logger.info('revision requested', { caseId, runId: result.run.runId, revision: result.run.revision });
      return {
        status: 202,
        body: result.run,
        headers: { Location: `/api/cases/${caseId}/runs/${result.run.runId}`, 'Retry-After': String(POLL_AFTER_SECONDS) },
      };
    case 'not_found':
      throw notFound();
    case 'refused':
      throw refusalError(result.code, REVISION_PROBLEMS[result.code]);
    case 'rejected':
      throw tooMany(result.reason, REJECTION_TITLES[result.reason], result.retryAfterSeconds);
  }
};
