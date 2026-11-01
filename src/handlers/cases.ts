import { submitCase } from '../cases/create.ts';
import {
  CASE_SORT_KEY,
  CREDIT_RESULT_DOC_ID,
  proposalDocId,
  SEQ_CURSOR,
  toCaseDetail,
  toCaseSummary,
  toCreditResult,
  toProposal,
  toRun,
  toTimelineItem,
  toUsageEvent,
  type CaseStatus,
  type CreateCaseRequest,
  type CreditResult,
} from '../cases/documents.ts';
import { decodeCursor, encodeCursor } from '../http/cursor.ts';
import { principalOf } from '../http/pipeline.ts';
import { badRequest, conflict, notFound, tooMany } from '../http/problem.ts';
import { POLL_AFTER_SECONDS, REJECTION_TITLES, requireCase } from './shared.ts';
import { headerString, pathInteger, pathString, queryLimit, queryString, type Ctx, type Handler } from './types.ts';

// Every read is scoped to the caller's tenant, and a case id is only ever looked up inside that
// tenant's partition. A case of another tenant is therefore absent, exactly like an unknown one.

/** The recorded credit of a case, or `null` while none has been issued. */
async function readCredit(ctx: Ctx, tenantId: string, caseId: string): Promise<CreditResult | null> {
  const found = await ctx.services.cases.get('credit_result', tenantId, caseId, CREDIT_RESULT_DOC_ID);
  return found === null ? null : toCreditResult(found.doc);
}

/** Sequence cursors carry the last sequence number returned; the first page starts at zero. */
function afterSeq(ctx: Ctx): number {
  const cursor = decodeCursor(queryString(ctx, 'continuationToken'), SEQ_CURSOR);
  return cursor === null ? 0 : Number(cursor);
}

const seqToken = (next: number | null): string | null => (next === null ? null : encodeCursor(String(next)));

export const createCase: Handler = async (ctx) => {
  const { tenantId, principalId } = principalOf(ctx);
  const { cases, admission, reference, config } = ctx.services;
  const outcome = await submitCase(
    { cases, admission, reference, config, logger: ctx.logger },
    {
      tenantId,
      principalId,
      idempotencyKey: headerString(ctx, 'Idempotency-Key'),
      // The pipeline already validated the body against the closed CreateCaseRequest schema.
      request: ctx.body as CreateCaseRequest,
      now: ctx.now,
    },
  );
  switch (outcome.kind) {
    case 'accepted':
      ctx.logger.info('case submitted', { caseId: outcome.case.caseId, runId: outcome.runId, replayed: outcome.replayed });
      return {
        status: 202,
        body: { case: outcome.case, runId: outcome.runId, replayed: outcome.replayed },
        headers: {
          Location: `/api/cases/${outcome.case.caseId}`,
          'Retry-After': String(POLL_AFTER_SECONDS),
          'Idempotency-Replayed': outcome.replayed ? 'true' : 'false',
        },
      };
    case 'key_reused':
      throw conflict('idempotency_key_reused', 'The Idempotency-Key was already used with a different request');
    case 'invalid':
      throw badRequest('validation_failed', 'Request validation failed', { errors: outcome.errors });
    case 'rejected':
      throw tooMany(outcome.reason, REJECTION_TITLES[outcome.reason], outcome.retryAfterSeconds);
  }
};

export const listCases: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const after = decodeCursor(queryString(ctx, 'continuationToken'), CASE_SORT_KEY);
  // The pipeline validated the value against the CaseStatus enumeration.
  const status = queryString(ctx, 'status') as CaseStatus | undefined;
  const page = await ctx.services.cases.listCases(tenantId, status ?? null, queryLimit(ctx), after, ctx.now);
  return {
    status: 200,
    body: {
      items: page.items.map((row) => toCaseSummary(row, ctx.now)),
      continuationToken: page.next === null ? null : encodeCursor(page.next),
    },
  };
};

export const getCase: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const caseId = pathString(ctx, 'caseId');
  const doc = await requireCase(ctx, tenantId, caseId);
  const latestRun = await ctx.services.cases.get('run', tenantId, caseId, doc.latestRunId);
  const credit = await readCredit(ctx, tenantId, caseId);
  return { status: 200, body: toCaseDetail(doc, latestRun?.doc ?? null, credit, ctx.now) };
};

export const getCreditResult: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const caseId = pathString(ctx, 'caseId');
  await requireCase(ctx, tenantId, caseId);
  const credit = await readCredit(ctx, tenantId, caseId);
  if (credit === null) throw notFound('No credit has been recorded for this case.');
  return { status: 200, body: credit };
};

export const getCaseTimeline: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const caseId = pathString(ctx, 'caseId');
  const after = afterSeq(ctx);
  await requireCase(ctx, tenantId, caseId);
  const page = await ctx.services.cases.listTimeline(tenantId, caseId, after, queryLimit(ctx));
  return { status: 200, body: { items: page.items.map(toTimelineItem), continuationToken: seqToken(page.next) } };
};

export const listInvestigationRuns: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const caseId = pathString(ctx, 'caseId');
  await requireCase(ctx, tenantId, caseId);
  const runs = await ctx.services.cases.listRuns(tenantId, caseId);
  return { status: 200, body: { items: runs.map(toRun) } };
};

export const getInvestigationRun: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const run = await ctx.services.cases.get('run', tenantId, pathString(ctx, 'caseId'), pathString(ctx, 'runId'));
  if (run === null) throw notFound();
  return { status: 200, body: toRun(run.doc) };
};

export const listRunUsageEvents: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const caseId = pathString(ctx, 'caseId');
  const runId = pathString(ctx, 'runId');
  const after = afterSeq(ctx);
  const { cases } = ctx.services;
  if ((await cases.get('run', tenantId, caseId, runId)) === null) throw notFound();
  const page = await cases.listUsage(tenantId, caseId, runId, after, queryLimit(ctx));
  return { status: 200, body: { items: page.items.map(toUsageEvent), continuationToken: seqToken(page.next) } };
};

export const listProposals: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const caseId = pathString(ctx, 'caseId');
  await requireCase(ctx, tenantId, caseId);
  const proposals = await ctx.services.cases.listProposals(tenantId, caseId);
  return { status: 200, body: { items: proposals.map((doc) => toProposal(doc, ctx.now)) } };
};

export const getProposal: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const found = await ctx.services.cases.get(
    'proposal',
    tenantId,
    pathString(ctx, 'caseId'),
    proposalDocId(pathInteger(ctx, 'version')),
  );
  if (found === null) throw notFound();
  return { status: 200, body: toProposal(found.doc, ctx.now) };
};
