import type { RejectionReason } from '../cases/admission.ts';
import { CASE_DOC_ID } from '../cases/documents.ts';
import { HttpError, notFound } from '../http/problem.ts';
import type { Ctx } from './types.ts';

/** How soon a client should first poll an accepted piece of work, in seconds. */
export const POLL_AFTER_SECONDS = 2;

export const REJECTION_TITLES: Record<RejectionReason, string> = {
  tenant_daily_case_limit: 'The tenant has reached its daily case limit',
  tenant_concurrency_limit: 'The tenant has reached its limit of concurrent investigations',
  tenant_admission_busy: 'Admission is busy; retry shortly',
};

/** Every read is scoped to the caller's tenant: a case of another tenant is absent, like an unknown one. */
export async function requireCase(ctx: Ctx, tenantId: string, caseId: string) {
  const found = await ctx.services.cases.get('case', tenantId, caseId, CASE_DOC_ID);
  if (found === null) throw notFound();
  return found.doc;
}

/** A domain refusal rendered as the problem the contract documents for it. */
export interface RefusalProblem {
  readonly status: 403 | 409;
  readonly title: string;
}

export function refusalError(code: string, problem: RefusalProblem): HttpError {
  return new HttpError(problem.status, code, problem.title);
}
