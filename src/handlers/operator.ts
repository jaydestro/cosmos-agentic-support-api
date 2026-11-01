import { WORK_KEY, type RecoverRequest, type WorkState } from '../cases/documents.ts';
import { recoverWork, type Recovery, type RecoverRefusal } from '../cases/recover.ts';
import { inspectWork } from '../cases/work-target.ts';
import { parseWorkId, toWorkItem } from '../cases/work.ts';
import { decodeCursor, encodeCursor } from '../http/cursor.ts';
import { principalOf } from '../http/pipeline.ts';
import { badRequest, notFound, tooMany } from '../http/problem.ts';
import { REJECTION_TITLES, refusalError, type RefusalProblem } from './shared.ts';
import { pathString, queryLimit, queryString, type Handler } from './types.ts';

// Operator work is scoped to the operator's own tenant: the tenant is part of every partition key
// these handlers read, so another tenant's work is absent, exactly like an unknown work id.

const RECOVERY_PROBLEMS: Readonly<Record<RecoverRefusal, RefusalProblem>> = Object.freeze({
  recovery_not_applicable: { status: 409, title: 'This work item is not in a state that can be recovered that way' },
  resume_grants_exhausted: { status: 409, title: 'The run has used all of its allowance grants' },
  allowance_does_not_cover_stop: { status: 409, title: 'The allowance does not raise the limit the run stopped at' },
  concurrent_update: { status: 409, title: 'The work changed while the recovery was being recorded; retry' },
});

export const listOperatorWork: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  // The pipeline validated the value against the WorkState enumeration, and the parameter is required.
  const state = queryString(ctx, 'state') as WorkState;
  const after = decodeCursor(queryString(ctx, 'continuationToken'), WORK_KEY);
  const page = await ctx.services.cases.listWork(tenantId, state, queryLimit(ctx), after, ctx.now);
  return {
    status: 200,
    body: {
      items: page.items.map((row) => toWorkItem(row, state)),
      continuationToken: page.next === null ? null : encodeCursor(page.next),
    },
  };
};

export const getOperatorWorkItem: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const target = parseWorkId(pathString(ctx, 'workId'));
  if (target === null) throw notFound();
  // A document that is in flight or finished is no work item, so it reads as absent.
  const item = await inspectWork(ctx.services.cases, tenantId, target, ctx.now);
  if (item === null) throw notFound();
  return { status: 200, body: item };
};

/** The two actions take different arguments, which the schema alone cannot express. */
function recoveryOf(body: RecoverRequest): Recovery {
  if (body.action === 'resume') {
    if (body.allowance === undefined) {
      throw badRequest('validation_failed', 'Request validation failed', {
        errors: [{ pointer: '/allowance', code: 'allowance_required', message: 'A resume must state the allowance it grants.' }],
      });
    }
    return { action: 'resume', allowance: body.allowance };
  }
  if (body.allowance !== undefined) {
    throw badRequest('validation_failed', 'Request validation failed', {
      errors: [{ pointer: '/allowance', code: 'allowance_not_applicable', message: 'A requeue grants no allowance.' }],
    });
  }
  return { action: 'requeue' };
}

export const recoverWorkItem: Handler = async (ctx) => {
  const { tenantId, principalId } = principalOf(ctx);
  const { cases, admission } = ctx.services;
  const body = ctx.body as RecoverRequest;
  const recovery = recoveryOf(body);
  const target = parseWorkId(pathString(ctx, 'workId'));
  if (target === null) throw notFound();

  const result = await recoverWork(
    { cases, admission, logger: ctx.logger },
    { tenantId, principalId, target, recovery, reason: body.reason, now: ctx.now },
  );
  switch (result.kind) {
    case 'accepted':
      ctx.logger.info('work recovery accepted', {
        caseId: target.caseId,
        docId: target.docId,
        action: result.accepted.action,
        from: result.accepted.state,
        grantNumber: result.accepted.grantNumber,
      });
      return { status: 202, body: result.accepted };
    case 'not_found':
      throw notFound();
    case 'refused':
      throw refusalError(result.code, RECOVERY_PROBLEMS[result.code]);
    case 'rejected':
      throw tooMany(result.reason, REJECTION_TITLES[result.reason], result.retryAfterSeconds);
  }
};
