import { BASE_RUN_LIMITS, CASE_LIMITS, type RunLimits } from '../config/limits.ts';
import { requeued } from '../outbox/transitions.ts';
import { newOutboxDoc, outboxId, type OutboxDoc, type OutboxKind } from '../outbox/types.ts';
import type { Logger } from '../telemetry/log.ts';
import type { AdmissionControl, RejectionReason } from './admission.ts';
import {
  appendTimeline,
  CASE_DOC_ID,
  runKeyFor,
  type Actor,
  type Allowance,
  type CaseDoc,
  type CaseStatus,
  type RecoverAccepted,
  type RunDoc,
  type WorkState,
} from './documents.ts';
import { withRetries } from './retry.ts';
import type { CaseOp, CaseStore, Versioned } from './store.ts';
import { readWorkTarget, type WorkTargetRow } from './work-target.ts';
import { workIdOf, workStateOf, type WorkTarget } from './work.ts';

export interface RecoverDeps {
  readonly cases: CaseStore;
  readonly admission: AdmissionControl;
  readonly logger: Logger;
}

/** The two recoveries. A resume always carries the allowance it grants; a requeue never does. */
export type Recovery = { action: 'requeue' } | { action: 'resume'; allowance: Allowance };

export interface RecoverInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly target: WorkTarget;
  readonly recovery: Recovery;
  /** Untrusted free text: kept on the timeline as data. */
  readonly reason: string;
  readonly now: Date;
}

/** Each refusal is a stable problem code of the API. */
export type RecoverRefusal = 'recovery_not_applicable' | 'resume_grants_exhausted' | 'allowance_does_not_cover_stop' | 'concurrent_update';

export type RecoverOutcome =
  | { kind: 'accepted'; accepted: RecoverAccepted }
  | { kind: 'not_found' }
  | { kind: 'refused'; code: RecoverRefusal }
  | { kind: 'rejected'; reason: RejectionReason; retryAfterSeconds: number };

const ALLOWANCE_KEYS = ['steps', 'toolCalls', 'modelCalls', 'tokens', 'costMicroUsd', 'activeMs'] as const satisfies readonly (keyof Allowance & keyof RunLimits)[];

/** The limit a run stopped at, by the reason it recorded. Retry limits are never raised, so they have no entry. */
export const STOP_DIMENSION: Readonly<Record<string, keyof Allowance>> = Object.freeze({
  active_time_exhausted: 'activeMs',
  steps_exhausted: 'steps',
  tool_calls_exhausted: 'toolCalls',
  model_calls_exhausted: 'modelCalls',
  tokens_exhausted: 'tokens',
  cost_exhausted: 'costMicroUsd',
});

const GRANT_DATA_KEYS: Readonly<Record<keyof Allowance, string>> = Object.freeze({
  steps: 'grantedSteps',
  toolCalls: 'grantedToolCalls',
  modelCalls: 'grantedModelCalls',
  tokens: 'grantedTokens',
  costMicroUsd: 'grantedCostMicroUsd',
  activeMs: 'grantedActiveMs',
});

const refused = (code: RecoverRefusal): RecoverOutcome => ({ kind: 'refused', code });

/**
 * Operator recovery of stuck work. It records who acted and why, and it never decides, approves or
 * creates a credit: a requeued credit is revalidated and reconciled with the provider before it is
 * issued, and a resumed run keeps every counter it has accumulated.
 *
 * Recovery is not idempotent. Repeating an accepted recovery finds the work already moving and is
 * refused, which is also how a lost race with another operator looks.
 */
export function recoverWork(deps: RecoverDeps, input: RecoverInput): Promise<RecoverOutcome> {
  const { recovery } = input;
  return withRetries(
    () => (recovery.action === 'requeue' ? requeue(deps, input) : resume(deps, input, recovery.allowance)),
    () => refused('concurrent_update'),
  );
}

async function locate(cases: CaseStore, input: RecoverInput): Promise<{ caseRow: Versioned<CaseDoc>; found: WorkTargetRow } | null> {
  const { tenantId, target } = input;
  const caseRow = await cases.get('case', tenantId, target.caseId, CASE_DOC_ID);
  if (caseRow === null) return null;
  const found = await readWorkTarget(cases, tenantId, target);
  return found === null ? null : { caseRow, found };
}

const accepted = (target: WorkTarget, action: Recovery['action'], state: WorkState, grantNumber: number | null): RecoverOutcome => ({
  kind: 'accepted',
  // `state` is what the item was in when the recovery was accepted; afterwards the work is moving again.
  accepted: { workId: workIdOf(target.caseId, target.docId), action, state, grantNumber },
});

/** What a case that was parked for attention goes back to once the work that stalled it runs again. */
function statusAfterRequeue(kind: OutboxKind): CaseStatus | null {
  switch (kind) {
    case 'credit.execute':
      return 'approved';
    case 'investigation.start':
      return 'queued';
    case 'diagnostic.echo':
      return null;
  }
}

async function requeue(deps: RecoverDeps, input: RecoverInput): Promise<RecoverOutcome> {
  const { now, target } = input;
  const located = await locate(deps.cases, input);
  if (located === null) return { kind: 'not_found' };
  const { caseRow, found } = located;
  if (found.type !== 'outbox') return refused('recovery_not_applicable');
  const item = found.row.doc;
  const state = workStateOf(item, now);
  if (state !== 'poison' && state !== 'recoverable') return refused('recovery_not_applicable');

  const restored = statusAfterRequeue(item.kind);
  const parked = caseRow.doc.status === 'needs_attention' && restored !== null;
  const operator: Actor = { type: 'user', id: input.principalId };
  const { caseDoc, docs } = appendTimeline(
    parked ? { ...caseRow.doc, status: restored } : caseRow.doc,
    [
      {
        kind: 'work_requeued',
        actor: operator,
        summary: `Operator requeued ${item.kind} work.`,
        data: {
          workId: workIdOf(item.caseId, item.id),
          from: state,
          attempts: item.attempts,
          errorCode: item.lastError?.code ?? null,
          reason: input.reason,
        },
      },
    ],
    now,
  );
  const ops: CaseOp[] = [
    { op: 'replace', doc: caseDoc, etag: caseRow.etag },
    { op: 'replace', doc: requeued(item, now), etag: found.row.etag },
    ...docs.map((doc): CaseOp => ({ op: 'create', doc })),
  ];
  await deps.cases.commit(input.tenantId, item.caseId, ops);
  return accepted(target, 'requeue', state, null);
}

async function resume(deps: RecoverDeps, input: RecoverInput, allowance: Allowance): Promise<RecoverOutcome> {
  const { cases, admission } = deps;
  const { tenantId, target, now } = input;
  const located = await locate(cases, input);
  if (located === null) return { kind: 'not_found' };
  const { caseRow, found } = located;
  if (found.type !== 'run') return refused('recovery_not_applicable');
  const run = found.row.doc;
  if (workStateOf(run, now) !== 'budget_exhausted' || caseRow.doc.latestRunId !== run.runId) return refused('recovery_not_applicable');
  if (run.allowanceGrants >= CASE_LIMITS.resumeGrantsPerRun) return refused('resume_grants_exhausted');
  if (!coversStop(run.stopReason, allowance)) return refused('allowance_does_not_cover_stop');

  const grant = run.allowanceGrants + 1;
  const runKey = runKeyFor(run.caseId, run.runId);
  const admitted = await admission.admit(tenantId, runKey, 'run');
  if (!admitted.ok) return { kind: 'rejected', reason: admitted.reason, retryAfterSeconds: admitted.retryAfterSeconds };

  const outboxKey = `${run.runId}-g${String(grant)}`;
  try {
    await cases.commit(tenantId, run.caseId, resumeOps(input, caseRow, found.row, allowance, grant, outboxKey));
  } catch (error) {
    return await settleFailedWrite(deps, input, { caseId: run.caseId, runKey, outboxKey, grant }, error);
  }
  return accepted(target, 'resume', 'budget_exhausted', grant);
}

const coversStop = (stopReason: string | null, allowance: Allowance): boolean => {
  const needed = stopReason === null ? undefined : STOP_DIMENSION[stopReason];
  return needed === undefined || allowance[needed] !== undefined;
};

/** Each grant adds to the run's own limits; nothing is reset and no grant may exceed the base limit it adds to. */
function raised(limits: RunLimits, allowance: Allowance): RunLimits {
  const next = { ...limits };
  let granted = 0;
  for (const key of ALLOWANCE_KEYS) {
    const value = allowance[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > BASE_RUN_LIMITS[key]) {
      throw new Error(`The ${key} allowance is outside what one grant may add.`);
    }
    next[key] = limits[key] + value;
    granted += 1;
  }
  if (granted === 0) throw new Error('A resume must grant at least one allowance.');
  return next;
}

function resumeOps(
  input: RecoverInput,
  caseRow: Versioned<CaseDoc>,
  runRow: Versioned<RunDoc>,
  allowance: Allowance,
  grant: number,
  outboxKey: string,
): CaseOp[] {
  const { tenantId, now } = input;
  const run = runRow.doc;
  const resumed: RunDoc = {
    ...run,
    state: 'queued',
    stopReason: null,
    finishedAt: null,
    limits: raised(run.limits, allowance),
    allowanceGrants: grant,
    updatedAt: now.toISOString(),
  };
  const data: Record<string, string | number | boolean | null> = { runId: run.runId, grant, reason: input.reason };
  for (const key of ALLOWANCE_KEYS) {
    const value = allowance[key];
    if (value !== undefined) data[GRANT_DATA_KEYS[key]] = value;
  }
  const operator: Actor = { type: 'user', id: input.principalId };
  const { caseDoc, docs } = appendTimeline(
    { ...caseRow.doc, status: 'queued' },
    [
      {
        kind: 'run_resumed',
        actor: operator,
        summary: `Run ${run.runId} resumed with allowance grant ${String(grant)} of ${String(CASE_LIMITS.resumeGrantsPerRun)}.`,
        data,
      },
    ],
    now,
  );
  const outbox = newOutboxDoc({
    tenantId,
    caseId: run.caseId,
    kind: 'investigation.start',
    key: outboxKey,
    payload: { runId: run.runId, revision: run.revision },
    now,
  });
  return [
    { op: 'replace', doc: caseDoc, etag: caseRow.etag },
    { op: 'replace', doc: resumed, etag: runRow.etag },
    ...docs.map((doc): CaseOp => ({ op: 'create', doc })),
    { op: 'create', doc: outbox },
  ];
}

/**
 * A failed batch may still have committed, so every branch is safe to repeat. The concurrency slot is
 * named after the run: the work item this grant created says whether the batch committed, and whoever
 * committed it owns the slot, so a request that lost the race must not free it.
 */
async function settleFailedWrite(
  deps: RecoverDeps,
  input: RecoverInput,
  ids: { caseId: string; runKey: string; outboxKey: string; grant: number },
  error: unknown,
): Promise<RecoverOutcome> {
  const { cases, admission, logger } = deps;
  const { tenantId, now, target } = input;

  let item: Versioned<OutboxDoc> | null;
  try {
    item = await cases.get('outbox', tenantId, ids.caseId, outboxId('investigation.start', ids.outboxKey));
  } catch {
    // Unknown outcome: leave the slot to its lease rather than risk freeing a running case's slot.
    logger.warn('resume outcome is unknown', { caseId: ids.caseId });
    throw error;
  }
  if (item !== null) {
    if (item.doc.createdAt === now.toISOString()) return accepted(target, 'resume', 'budget_exhausted', ids.grant);
    throw error;
  }

  try {
    await admission.release(tenantId, ids.runKey);
  } catch (releaseError) {
    logger.warn('resume could not release its admission slot', { caseId: ids.caseId, error: releaseError });
  }
  throw error;
}
