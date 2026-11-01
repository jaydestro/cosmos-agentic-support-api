import type { Config } from '../config/env.ts';
import type { ReferenceStore } from '../data/reference.ts';
import { digestOf } from '../domain/canonical.ts';
import { deriveCaseId, runIdFor } from '../domain/ids.ts';
import type { FieldError } from '../http/problem.ts';
import { newOutboxDoc } from '../outbox/types.ts';
import type { Logger } from '../telemetry/log.ts';
import type { AdmissionControl, RejectionReason } from './admission.ts';
import {
  appendTimeline,
  IDEMPOTENCY_DOC_ID,
  newCaseDoc,
  newIdempotencyDoc,
  newRunDoc,
  runKeyFor,
  SYSTEM_ACTOR,
  toCaseSummary,
  type Actor,
  type CaseSummary,
  type CreateCaseRequest,
  type IdempotencyDoc,
} from './documents.ts';
import { CaseWriteError, type CaseOp, type CaseStore } from './store.ts';

export interface SubmitCaseDeps {
  readonly cases: CaseStore;
  readonly admission: AdmissionControl;
  readonly reference: ReferenceStore;
  readonly config: Pick<Config, 'agent' | 'runLimits'>;
  readonly logger: Logger;
}

export interface SubmitCaseInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly request: CreateCaseRequest;
  readonly now: Date;
}

export type SubmitOutcome =
  | { kind: 'accepted'; case: CaseSummary; runId: string; replayed: boolean }
  | { kind: 'key_reused' }
  | { kind: 'invalid'; errors: FieldError[] }
  | { kind: 'rejected'; reason: RejectionReason; retryAfterSeconds: number };

const FIRST_REVISION = 1;

/**
 * Creates a case, or replays the answer to an earlier identical request.
 *
 * The idempotency scope is (tenant, caller, key): the case id derives from all three, so the case,
 * its idempotency record, its first timeline items, its first run and the outbox work that starts
 * the investigation share one logical partition and commit in one transactional batch. A replay is
 * a point read of the idempotency record; the record lives as long as the case.
 *
 * "Identical" means the same canonical JSON: object key order does not matter, array order does.
 */
export async function submitCase(deps: SubmitCaseDeps, input: SubmitCaseInput): Promise<SubmitOutcome> {
  const { cases, admission, reference } = deps;
  const { tenantId, principalId, request } = input;
  const caseId = deriveCaseId(tenantId, principalId, input.idempotencyKey);
  const requestDigest = digestOf(request);

  const earlier = await cases.get('idempotency', tenantId, caseId, IDEMPOTENCY_DOC_ID);
  if (earlier !== null) return replayOf(earlier.doc, requestDigest);

  const errors = await checkAgainstAccount(reference, tenantId, request);
  if (errors.length > 0) return { kind: 'invalid', errors };

  const runId = runIdFor(FIRST_REVISION);
  const runKey = runKeyFor(caseId, runId);
  const admitted = await admission.admit(tenantId, runKey, 'new_case');
  if (!admitted.ok) return { kind: 'rejected', reason: admitted.reason, retryAfterSeconds: admitted.retryAfterSeconds };

  const { ops, summary } = buildBatch(deps, input, caseId, requestDigest);
  try {
    await cases.commit(tenantId, caseId, ops);
  } catch (error) {
    return await settleFailedWrite(deps, input, { caseId, runKey, requestDigest }, error);
  }
  return { kind: 'accepted', case: summary, runId, replayed: false };
}

function replayOf(earlier: IdempotencyDoc, requestDigest: string): SubmitOutcome {
  return earlier.requestDigest === requestDigest
    ? { kind: 'accepted', case: earlier.snapshot.case, runId: earlier.snapshot.runId, replayed: true }
    : { kind: 'key_reused' };
}

/**
 * An unknown account and an account of another tenant are indistinguishable. Missing invoices are
 * accepted on purpose: the investigation reports them as missing evidence instead of inventing a credit.
 */
async function checkAgainstAccount(reference: ReferenceStore, tenantId: string, request: CreateCaseRequest): Promise<FieldError[]> {
  const account = await reference.getAccount(tenantId, request.accountId);
  if (account === null) {
    return [{ pointer: '/accountId', code: 'unknown_account', message: 'No such account for this tenant.' }];
  }
  if (request.requestedCredit !== undefined && request.requestedCredit.currency !== account.currency) {
    return [
      {
        pointer: '/requestedCredit/currency',
        code: 'currency_mismatch',
        message: `The account is billed in ${account.currency}.`,
      },
    ];
  }
  return [];
}

function buildBatch(
  deps: SubmitCaseDeps,
  input: SubmitCaseInput,
  caseId: string,
  requestDigest: string,
): { ops: CaseOp[]; summary: CaseSummary } {
  const { tenantId, principalId, request, now } = input;
  const mode = deps.config.agent.mode;
  const runId = runIdFor(FIRST_REVISION);
  const createdBy: Actor = { type: 'user', id: principalId };

  const queued = newCaseDoc({ tenantId, caseId, createdBy, request, now, runId });
  // Free text is stored on the case only; the timeline carries enumerated and numeric details.
  const { caseDoc, docs: timeline } = appendTimeline(
    queued,
    [
      {
        kind: 'case_created',
        actor: createdBy,
        summary: `Dispute submitted: ${request.category}.`,
        data: {
          category: request.category,
          accountId: request.accountId,
          invoiceCount: request.invoiceIds?.length ?? 0,
          requestedAmountMinor: request.requestedCredit?.amountMinor ?? null,
          requestedCurrency: request.requestedCredit?.currency ?? null,
        },
      },
      { kind: 'run_queued', actor: SYSTEM_ACTOR, summary: `Investigation queued (${mode} mode).`, data: { runId, mode } },
    ],
    now,
  );
  const run = newRunDoc({ tenantId, caseId, revision: FIRST_REVISION, mode, limits: deps.config.runLimits, now });
  const outbox = newOutboxDoc({
    tenantId,
    caseId,
    kind: 'investigation.start',
    key: runId,
    payload: { runId, revision: FIRST_REVISION },
    now,
  });
  const summary = toCaseSummary(caseDoc, now);
  const idempotency = newIdempotencyDoc({ tenantId, caseId, requestDigest, snapshot: { case: summary, runId }, now });

  const ops = [caseDoc, idempotency, ...timeline, run, outbox].map((doc): CaseOp => ({ op: 'create', doc }));
  return { ops, summary };
}

/**
 * A failed batch may still have committed, so every branch is safe to repeat. The concurrency slot is
 * named after the run, so a competing identical request shares it and must never free it.
 */
async function settleFailedWrite(
  deps: SubmitCaseDeps,
  input: SubmitCaseInput,
  ids: { caseId: string; runKey: string; requestDigest: string },
  error: unknown,
): Promise<SubmitOutcome> {
  const { cases, admission, logger } = deps;
  const { tenantId } = input;
  const { caseId, runKey, requestDigest } = ids;

  if (error instanceof CaseWriteError && error.reason === 'exists') {
    const winner = await cases.get('idempotency', tenantId, caseId, IDEMPOTENCY_DOC_ID);
    if (winner === null) throw error;
    return replayOf(winner.doc, requestDigest);
  }

  let committed: IdempotencyDoc | null;
  try {
    committed = (await cases.get('idempotency', tenantId, caseId, IDEMPOTENCY_DOC_ID))?.doc ?? null;
  } catch {
    // Unknown outcome: leave the slot to its lease rather than risk freeing a running case's slot.
    logger.warn('case creation outcome is unknown', { caseId });
    throw error;
  }
  if (committed !== null) return replayOf(committed, requestDigest);

  try {
    await admission.release(tenantId, runKey, { refundCase: true });
  } catch (releaseError) {
    logger.warn('case creation could not release its admission slot', { caseId, error: releaseError });
  }
  throw error;
}
