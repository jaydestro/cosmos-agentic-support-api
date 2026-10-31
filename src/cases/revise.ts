import type { Config } from '../config/env.ts';
import { CASE_LIMITS } from '../config/limits.ts';
import { runIdFor } from '../domain/ids.ts';
import { newOutboxDoc } from '../outbox/types.ts';
import type { Logger } from '../telemetry/log.ts';
import type { AdmissionControl, RejectionReason } from './admission.ts';
import {
  appendTimeline,
  CASE_DOC_ID,
  derivedStatus,
  newRunDoc,
  proposalDocId,
  runKeyFor,
  SYSTEM_ACTOR,
  toRun,
  type Actor,
  type CaseDoc,
  type CaseStatus,
  type ProposalDoc,
  type Run,
  type RunDoc,
  type TimelineDraft,
} from './documents.ts';
import { withRetries } from './retry.ts';
import type { CaseOp, CaseStore, Versioned } from './store.ts';
import { caseAfter, expiredProposal, expiryDraft } from './transitions.ts';

export interface ReviseDeps {
  readonly cases: CaseStore;
  readonly admission: AdmissionControl;
  readonly config: Pick<Config, 'agent' | 'runLimits'>;
  readonly logger: Logger;
}

export interface ReviseInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly principalId: string;
  /** Untrusted free text: kept on the run and the timeline for reviewers. No investigator reads it. */
  readonly reason: string;
  readonly now: Date;
}

/** Each refusal is a stable problem code of the API. */
export type ReviseRefusal = 'revision_not_allowed' | 'revision_limit_reached' | 'concurrent_update';

export type ReviseOutcome =
  | { kind: 'accepted'; run: Run }
  | { kind: 'not_found' }
  | { kind: 'refused'; code: ReviseRefusal }
  | { kind: 'rejected'; reason: RejectionReason; retryAfterSeconds: number };

/** Only a case whose last proposal was turned down, lapsed, or was a finding can be investigated again. */
const REVISABLE: readonly CaseStatus[] = ['rejected', 'expired', 'finding_reported'];

const refused = (code: ReviseRefusal): ReviseOutcome => ({ kind: 'refused', code });

/**
 * Starts run `N+1` of a case, whose proposal becomes version `N+1` and needs a fresh approval.
 *
 * The case transition, the run, its outbox item and the timeline commit in one ETag-guarded batch.
 * The run id is create-only, so two competing requests cannot both start a run. A revision request is
 * not idempotent: repeating one after it was accepted finds the case already queued and is refused.
 */
export function reviseCase(deps: ReviseDeps, input: ReviseInput): Promise<ReviseOutcome> {
  return withRetries(
    () => evaluate(deps, input),
    () => refused('concurrent_update'),
  );
}

async function evaluate(deps: ReviseDeps, input: ReviseInput): Promise<ReviseOutcome> {
  const { cases, admission } = deps;
  const { tenantId, caseId, now } = input;

  const caseRow = await cases.get('case', tenantId, caseId, CASE_DOC_ID);
  if (caseRow === null) return { kind: 'not_found' };
  const caseDoc = caseRow.doc;
  if (!REVISABLE.includes(derivedStatus(caseDoc, now))) return refused('revision_not_allowed');
  if (caseDoc.revision >= CASE_LIMITS.maxRuns) return refused('revision_limit_reached');

  // A lapsed approval is still stored as awaiting; the revision is the first writer to see it.
  const lapsed = caseDoc.status === 'awaiting_approval' ? await readLapsed(cases, caseDoc) : null;

  const runId = runIdFor(caseDoc.revision + 1);
  const runKey = runKeyFor(caseId, runId);
  const admitted = await admission.admit(tenantId, runKey, 'run');
  if (!admitted.ok) return { kind: 'rejected', reason: admitted.reason, retryAfterSeconds: admitted.retryAfterSeconds };

  const { ops, run } = buildBatch(deps, input, caseRow, lapsed, runId);
  try {
    await cases.commit(tenantId, caseId, ops);
  } catch (error) {
    return await settleFailedWrite(deps, input, { runId, runKey }, error);
  }
  return { kind: 'accepted', run: toRun(run) };
}

async function readLapsed(cases: CaseStore, caseDoc: CaseDoc): Promise<Versioned<ProposalDoc> | null> {
  const row = await cases.get('proposal', caseDoc.tenantId, caseDoc.caseId, proposalDocId(caseDoc.revision));
  if (row === null) throw new Error('The case awaits approval of a proposal that does not exist.');
  return row.doc.status === 'pending_approval' ? row : null;
}

function buildBatch(
  deps: ReviseDeps,
  input: ReviseInput,
  caseRow: Versioned<CaseDoc>,
  lapsed: Versioned<ProposalDoc> | null,
  runId: string,
): { ops: CaseOp[]; run: RunDoc } {
  const { tenantId, caseId, now } = input;
  const mode = deps.config.agent.mode;
  const from = caseRow.doc.revision;
  const revision = from + 1;
  const requester: Actor = { type: 'user', id: input.principalId };
  const expired = lapsed === null ? null : expiredProposal(lapsed.doc);

  const queued: CaseDoc = {
    ...(expired === null ? caseRow.doc : caseAfter(caseRow.doc, expired, 'queued')),
    status: 'queued',
    revision,
    latestRunId: runId,
  };
  const drafts: TimelineDraft[] = [
    ...(lapsed === null ? [] : [expiryDraft(lapsed.doc)]),
    {
      kind: 'revision_requested',
      actor: requester,
      summary: `Revision ${String(revision)} requested.`,
      data: { fromVersion: from, toRevision: revision, reason: input.reason },
    },
    { kind: 'run_queued', actor: SYSTEM_ACTOR, summary: `Investigation queued (${mode} mode).`, data: { runId, mode } },
  ];
  const { caseDoc, docs } = appendTimeline(queued, drafts, now);
  const run = newRunDoc({ tenantId, caseId, revision, mode, limits: deps.config.runLimits, now, revisionReason: input.reason });
  const outbox = newOutboxDoc({ tenantId, caseId, kind: 'investigation.start', key: runId, payload: { runId, revision }, now });

  const ops: CaseOp[] = [
    { op: 'replace', doc: caseDoc, etag: caseRow.etag },
    ...(lapsed === null || expired === null ? [] : [{ op: 'replace', doc: expired, etag: lapsed.etag } satisfies CaseOp]),
    ...docs.map((doc): CaseOp => ({ op: 'create', doc })),
    { op: 'create', doc: run },
    { op: 'create', doc: outbox },
  ];
  return { ops, run };
}

/**
 * A failed batch may still have committed, so every branch is safe to repeat. The concurrency slot is
 * named after the run: whoever wrote that run owns it, and a request that lost the race must not free it.
 */
async function settleFailedWrite(deps: ReviseDeps, input: ReviseInput, ids: { runId: string; runKey: string }, error: unknown): Promise<ReviseOutcome> {
  const { cases, admission, logger } = deps;
  const { tenantId, caseId } = input;

  let existing: Versioned<RunDoc> | null;
  try {
    existing = await cases.get('run', tenantId, caseId, ids.runId);
  } catch {
    // Unknown outcome: leave the slot to its lease rather than risk freeing a running case's slot.
    logger.warn('revision outcome is unknown', { caseId });
    throw error;
  }
  if (existing !== null) {
    const ours = existing.doc.createdAt === input.now.toISOString() && existing.doc.revisionReason === input.reason;
    if (ours) return { kind: 'accepted', run: toRun(existing.doc) };
    throw error;
  }

  try {
    await admission.release(tenantId, ids.runKey);
  } catch (releaseError) {
    logger.warn('revision could not release its admission slot', { caseId, error: releaseError });
  }
  throw error;
}
