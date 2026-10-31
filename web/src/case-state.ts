import { CASE_LIMITS } from '../../src/config/limits.ts';
import { ACTIVE_STATUSES } from './format.ts';
import type { CaseDetail, PolicyRef, Proposal, Role, Run, Session } from './types.ts';

const hasRole = (session: Session, role: Role): boolean => session.principal.roles.includes(role);

/** A change in anything the page shows from the case itself means the case moved and should be read again. */
export function caseSignature(detail: CaseDetail): string {
  return JSON.stringify([detail.status, detail.updatedAt, detail.revision, detail.latestProposal, detail.latestRun, detail.creditResult?.resultId ?? null]);
}

export const isActive = (status: string): boolean => ACTIVE_STATUSES.includes(status);

export interface PollPlan {
  readonly firstMs: number;
  readonly maxMs: number;
}

const ACTIVE_POLL: PollPlan = { firstMs: 1500, maxMs: 5000 };
// Waiting on a person is not worth a fast loop: a decision or a recovery arrives from outside this page.
const WAITING_POLL: PollPlan = { firstMs: 15_000, maxMs: 15_000 };
const WAITING_STATUSES: readonly string[] = ['awaiting_approval', 'needs_attention'];

/** How often to look again, or null when the status is settled until a person acts. */
export function pollPlan(status: string): PollPlan | null {
  if (isActive(status)) return ACTIVE_POLL;
  return WAITING_STATUSES.includes(status) ? WAITING_POLL : null;
}

/** Starts fast after a change and backs off while nothing happens. */
export function nextPollDelay(plan: PollPlan, previousMs: number, changed: boolean): number {
  if (changed) return plan.firstMs;
  return Math.min(plan.maxMs, Math.max(plan.firstMs, Math.round(previousMs * 1.5)));
}

/** The proposal a decision would bind to: the highest version. */
export function latestProposal(proposals: readonly Proposal[]): Proposal | null {
  let latest: Proposal | null = null;
  for (const proposal of proposals) {
    if (latest === null || proposal.version > latest.version) latest = proposal;
  }
  return latest;
}

/** The run list has no stated order, so the newest is found by revision. */
export function latestRun(runs: readonly Run[]): Run | null {
  let latest: Run | null = null;
  for (const run of runs) {
    if (latest === null || run.revision > latest.revision) latest = run;
  }
  return latest;
}

/**
 * The case, its proposals and its runs are three reads. If a write landed between them they disagree, and a settled
 * status would never be re-read, so the page checks that they describe the same moment before it shows them.
 */
export function snapshotConsistent(detail: CaseDetail, proposals: readonly Proposal[], runs: readonly Run[]): boolean {
  const brief = detail.latestProposal;
  const newest = latestProposal(proposals);
  if (brief === null) {
    if (newest !== null) return false;
  } else if (newest === null || newest.version !== brief.version || newest.status !== brief.status) {
    return false;
  }
  const run = detail.latestRun;
  const newestRun = latestRun(runs);
  if (run === null) return newestRun === null;
  return newestRun !== null && newestRun.runId === run.runId && newestRun.state === run.state;
}

export type DecisionAccess =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'none' }
  | { readonly kind: 'finding' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'not-approver' }
  | { readonly kind: 'creator' };

/**
 * What the viewer may do about the latest proposal. This only decides what to offer: the service enforces the role,
 * the separation of duties, the expiry and the version bindings, and its refusal is shown if it differs.
 */
export function decisionAccess(session: Session, detail: CaseDetail, proposal: Proposal | null): DecisionAccess {
  if (proposal === null) return { kind: 'none' };
  if (proposal.kind === 'finding') return { kind: 'finding' };
  if (proposal.status !== 'pending_approval') return { kind: 'closed' };
  if (!hasRole(session, 'Approver')) return { kind: 'not-approver' };
  if (detail.createdBy.type === 'user' && detail.createdBy.id === session.principal.principalId) return { kind: 'creator' };
  return { kind: 'allowed' };
}

const REVISABLE_STATUSES: readonly string[] = ['rejected', 'expired', 'finding_reported'];

export type RevisionAccess =
  | { readonly kind: 'allowed'; readonly remaining: number }
  | { readonly kind: 'not-now' }
  | { readonly kind: 'no-role' }
  | { readonly kind: 'limit' };

/** A revision starts another run, so a case has a fixed number of them. `revision` counts the runs so far. */
export function revisionAccess(session: Session, detail: CaseDetail): RevisionAccess {
  if (!REVISABLE_STATUSES.includes(detail.status)) return { kind: 'not-now' };
  if (!hasRole(session, 'Representative') && !hasRole(session, 'Approver')) return { kind: 'no-role' };
  const remaining = CASE_LIMITS.maxRuns - detail.revision;
  return remaining > 0 ? { kind: 'allowed', remaining } : { kind: 'limit' };
}

export const MAX_EVIDENCE_INVOICES = 10;

/** Which parts of one invoice a proposal cites. A null line index in a citation means the whole invoice. */
export interface CitedLines {
  whole: boolean;
  readonly lines: Set<number>;
}

export interface EvidenceTarget {
  /** Changes when the evidence to show changes, so a loaded view knows it is out of date. */
  readonly key: string;
  readonly accountId: string;
  readonly invoiceIds: readonly string[];
  readonly cited: ReadonlyMap<string, CitedLines>;
  readonly policyRef: PolicyRef | null;
  readonly awaitingDecision: boolean;
}

/** The records worth showing next to a proposal: what it cites first, then what the representative named. */
export function evidenceTarget(detail: CaseDetail, proposal: Proposal | null): EvidenceTarget {
  const cited = new Map<string, CitedLines>();
  for (const ref of proposal?.invoiceRefs ?? []) {
    const entry = cited.get(ref.invoiceId) ?? { whole: false, lines: new Set<number>() };
    if (ref.lineIndex === null) entry.whole = true;
    else entry.lines.add(ref.lineIndex);
    cited.set(ref.invoiceId, entry);
  }
  const invoiceIds = [...new Set([...cited.keys(), ...detail.invoiceIds])].slice(0, MAX_EVIDENCE_INVOICES);
  const awaitingDecision = proposal?.status === 'pending_approval';
  return {
    key: JSON.stringify([detail.accountId, invoiceIds, proposal?.version ?? null, proposal?.digest ?? null, awaitingDecision]),
    accountId: detail.accountId,
    invoiceIds,
    cited,
    policyRef: proposal?.policyRef ?? null,
    awaitingDecision,
  };
}
