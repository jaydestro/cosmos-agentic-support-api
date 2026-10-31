import { CASE_LIMITS, RECOVERABLE_GRACE_MS } from '../config/limits.ts';
import { CASE_ID_PATTERN } from '../domain/ids.ts';
import { formatMinor } from '../domain/money.ts';
import { describeStop, NO_DESCRIPTION } from '../domain/stop-reasons.ts';
import type { OutboxDoc, OutboxKind } from '../outbox/types.ts';
import { approvalHasExpired, type ProposalDoc, type RunDoc, type WorkItem, type WorkState } from './documents.ts';

/**
 * Operator work is not a document of its own. A work item is the stored document that backs it (a
 * proposal, a run or an outbox item) seen through the state it is in. The state is derived from
 * the stored fields on every read, so it can never disagree with the document it describes.
 */

export type ProposalWorkRow = Pick<
  ProposalDoc,
  'id' | 'type' | 'tenantId' | 'caseId' | 'workKey' | 'version' | 'kind' | 'status' | 'amount' | 'createdAt' | 'approvalExpiresAt'
>;
export type RunWorkRow = Pick<
  RunDoc,
  'id' | 'type' | 'tenantId' | 'caseId' | 'workKey' | 'runId' | 'state' | 'stopReason' | 'createdAt' | 'startedAt' | 'updatedAt' | 'allowanceGrants' | 'usage'
>;
export type OutboxWorkRow = Pick<
  OutboxDoc,
  'id' | 'type' | 'tenantId' | 'caseId' | 'workKey' | 'kind' | 'state' | 'attempts' | 'notBefore' | 'claimedUntil' | 'createdAt' | 'updatedAt' | 'lastError'
>;
export type WorkRow = ProposalWorkRow | RunWorkRow | OutboxWorkRow;
export type WorkType = WorkRow['type'];

/** The only fields a work listing reads, so large free text (an explanation, a payload) is never fetched. */
export const WORK_FIELDS = {
  proposal: ['id', 'type', 'tenantId', 'caseId', 'workKey', 'version', 'kind', 'status', 'amount', 'createdAt', 'approvalExpiresAt'],
  run: ['id', 'type', 'tenantId', 'caseId', 'workKey', 'runId', 'state', 'stopReason', 'createdAt', 'startedAt', 'updatedAt', 'allowanceGrants', 'usage'],
  outbox: ['id', 'type', 'tenantId', 'caseId', 'workKey', 'kind', 'state', 'attempts', 'notBefore', 'claimedUntil', 'createdAt', 'updatedAt', 'lastError'],
} as const satisfies { proposal: readonly (keyof ProposalWorkRow)[]; run: readonly (keyof RunWorkRow)[]; outbox: readonly (keyof OutboxWorkRow)[] };

/** The document type each work state is made of. */
export const WORK_STATE_TYPE: Readonly<Record<WorkState, WorkType>> = Object.freeze({
  waiting: 'proposal',
  failed: 'run',
  budget_exhausted: 'run',
  poison: 'outbox',
  recoverable: 'outbox',
  completed: 'outbox',
});

/**
 * The state a stored document is in, or `null` when it is not operator work. A decided, executed or
 * expired proposal, a run that is queued, running or completed, and an outbox item that is pending,
 * or claimed under a live lease, are in flight or finished and need no operator.
 */
export function workStateOf(row: WorkRow, now: Date): WorkState | null {
  switch (row.type) {
    case 'proposal':
      return row.status === 'pending_approval' && !approvalHasExpired(row, now) ? 'waiting' : null;
    case 'run':
      if (row.state === 'failed' || row.state === 'blocked') return 'failed';
      return row.state === 'budget_exhausted' ? 'budget_exhausted' : null;
    case 'outbox':
      switch (row.state) {
        case 'poison':
          return 'poison';
        case 'completed':
          return 'completed';
        case 'claimed':
          return row.claimedUntil !== null && Date.parse(row.claimedUntil) <= now.getTime() ? 'recoverable' : null;
        case 'pending':
          return Date.parse(row.notBefore) < now.getTime() - RECOVERABLE_GRACE_MS ? 'recoverable' : null;
      }
  }
}

export const workIdOf = (caseId: string, docId: string): string => `${caseId}~${docId}`;

const WORK_DOC_IDS: readonly { type: WorkType; pattern: RegExp }[] = [
  { type: 'proposal', pattern: /^proposal-[1-9]$/ },
  { type: 'run', pattern: /^run-[1-9]$/ },
  { type: 'outbox', pattern: /^out-[a-z0-9_-]{1,70}$/ },
];

export interface WorkTarget {
  caseId: string;
  docId: string;
  type: WorkType;
}

/** Splits `<caseId>~<document id>` and names the kind of document, or returns `null` for anything else. */
export function parseWorkId(workId: string): WorkTarget | null {
  const split = workId.indexOf('~');
  if (split < 0) return null;
  const caseId = workId.slice(0, split);
  const docId = workId.slice(split + 1);
  if (!CASE_ID_PATTERN.test(caseId)) return null;
  const match = WORK_DOC_IDS.find((candidate) => candidate.pattern.test(docId));
  return match === undefined ? null : { caseId, docId, type: match.type };
}

const OUTBOX_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  dependency_unavailable: 'A dependency was unavailable.',
  handler_failed: 'The handler failed unexpectedly; the diagnostics for the attempt carry the details.',
  invalid_payload: 'The work item does not name valid work.',
  aggregate_missing: 'A document of the case no longer exists.',
  run_superseded: 'A later run replaced the one this work item names.',
  run_conflict: 'The case changed while the run was writing.',
  tenant_admission_busy: 'The tenant allowance was busy while the run reserved live-model cost.',
  credit_conflict: 'The case changed while the credit was being recorded.',
  provider_unavailable: 'The credit provider was unavailable.',
  provider_key_conflict: 'The provider already holds this credit key for a different credit.',
  proposal_not_approved: 'The proposal is not approved, so no credit may be issued.',
  proposal_changed: 'The proposal no longer matches the digest that was approved.',
  decision_mismatch: 'The recorded decision does not match the approved proposal and policy version.',
  proposal_not_executable: 'The proposal carries no credit that could be issued.',
  revalidation_failed: 'The evidence and policy no longer support the approved credit.',
});

export { describeStop };
export const describeOutboxError = (code: string): string =>
  Object.hasOwn(OUTBOX_ERROR_MESSAGES, code) ? (OUTBOX_ERROR_MESSAGES[code] ?? NO_DESCRIPTION) : NO_DESCRIPTION;

const OUTBOX_LABELS: Readonly<Record<OutboxKind, string>> = Object.freeze({
  'investigation.start': 'Investigation start',
  'credit.execute': 'Credit execution',
  'diagnostic.echo': 'Diagnostic echo',
});

/** The actions an operator may take on an item in this state; recovery never decides or creates a credit. */
export function actionsOf(row: WorkRow, state: WorkState): WorkItem['actions'] {
  switch (state) {
    case 'poison':
    case 'recoverable':
      return ['requeue'];
    case 'budget_exhausted':
      return row.type === 'run' && row.allowanceGrants < CASE_LIMITS.resumeGrantsPerRun ? ['resume'] : [];
    case 'waiting':
    case 'failed':
    case 'completed':
      return [];
  }
}

function proposalSummary(row: ProposalWorkRow): string {
  const amount = row.amount === null ? '' : ` of ${formatMinor(row.amount.amountMinor, row.amount.currency)}`;
  return `Credit proposal v${String(row.version)}${amount} awaits a human decision until ${row.approvalExpiresAt ?? 'it is decided'}.`;
}

function runSummary(row: RunWorkRow, state: WorkState): string {
  const reason = row.stopReason ?? 'unknown';
  if (state === 'budget_exhausted') {
    return `Run ${row.runId} stopped at its allowance (${reason}); ${String(row.allowanceGrants)} of ${String(CASE_LIMITS.resumeGrantsPerRun)} resume grants used.`;
  }
  return `Run ${row.runId} ${row.state === 'blocked' ? 'was blocked' : 'failed'}: ${reason}.`;
}

function outboxSummary(row: OutboxWorkRow, state: WorkState): string {
  const label = OUTBOX_LABELS[row.kind];
  switch (state) {
    case 'poison':
      return `${label} ${row.id} was moved to poison after ${String(row.attempts)} attempts.`;
    case 'recoverable':
      return `${label} ${row.id} is not progressing: its claim lease expired or it never started.`;
    case 'waiting':
    case 'failed':
    case 'budget_exhausted':
    case 'completed':
      return `${label} ${row.id} is ${state}.`;
  }
}

/** Projects a stored document, already known to be in `state`, to the contract's `WorkItem`. */
export function toWorkItem(row: WorkRow, state: WorkState): WorkItem {
  const workId = workIdOf(row.caseId, row.id);
  switch (row.type) {
    case 'proposal':
      return {
        workId,
        caseId: row.caseId,
        kind: 'proposal_approval',
        state,
        summary: proposalSummary(row),
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
        attempts: 0,
        lastError: null,
        claimedUntil: null,
        usage: null,
        actions: actionsOf(row, state),
      };
    case 'run': {
      const code = row.stopReason ?? 'unknown';
      return {
        workId,
        caseId: row.caseId,
        kind: 'investigation_run',
        state,
        summary: runSummary(row, state),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        // The first start plus one for every recorded allowance grant that continued the run.
        attempts: row.startedAt === null ? 0 : row.allowanceGrants + 1,
        lastError: { code, message: describeStop(code) },
        claimedUntil: null,
        usage: row.usage,
        actions: actionsOf(row, state),
      };
    }
    case 'outbox':
      return {
        workId,
        caseId: row.caseId,
        kind: 'outbox',
        state,
        summary: outboxSummary(row, state),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        attempts: row.attempts,
        lastError: row.lastError === null ? null : { code: row.lastError.code, message: describeOutboxError(row.lastError.code) },
        claimedUntil: row.claimedUntil,
        usage: null,
        actions: actionsOf(row, state),
      };
  }
}
