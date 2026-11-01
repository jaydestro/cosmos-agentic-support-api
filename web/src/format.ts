import { describeStop, NO_DESCRIPTION } from '../../src/domain/stop-reasons.ts';
import type { Actor, Money, RunLimits, Session, UsageSummary } from './types.ts';

/** The contract bounds `Money.amountMinor`; the console refuses larger input before it is sent. */
export const MAX_MINOR_UNITS = 10_000_000;

/** USD and EUR both have two minor-unit digits, which is what the server assumes too. */
export function formatMoney(money: Money): string {
  const whole = Math.floor(money.amountMinor / 100);
  const fraction = String(money.amountMinor % 100).padStart(2, '0');
  return `${money.currency} ${String(whole)}.${fraction}`;
}

/** Whole units with at most two decimals, for example `49` or `49.5`. Returns minor units, or null when invalid. */
export function parseMajorUnits(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return minor >= 1 && minor <= MAX_MINOR_UNITS ? minor : null;
}

export function formatTimestamp(value: string | null): string {
  if (value === null) return 'not yet';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** Who did something. The caller's own id is shown as "You" so an approver can see why they cannot decide a case. */
export function actorText(actor: Actor, principalId: string): string {
  if (actor.type === 'agent') return 'The agent';
  if (actor.type === 'system') return 'The system';
  return actor.id === principalId ? 'You' : `User ${actor.id.slice(0, 8)}`;
}

export type Tone = 'active' | 'waiting' | 'good' | 'neutral' | 'bad' | 'alert';

/** Looks a server-provided code up in one of the tables below. Inherited names such as "constructor" are never found. */
const lookup = <V>(table: Readonly<Record<string, V>>, key: string): V | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

interface StatusInfo {
  readonly label: string;
  readonly tone: Tone;
  readonly help: string;
}

const STATUS: Readonly<Record<string, StatusInfo>> = Object.freeze({
  queued: { label: 'Queued', tone: 'active', help: 'The case is accepted and its investigation is waiting to start.' },
  investigating: { label: 'Investigating', tone: 'active', help: 'The agent is reading invoices and the credit policy.' },
  awaiting_approval: {
    label: 'Awaiting approval',
    tone: 'waiting',
    help: 'A credit is proposed. Nothing is running while an approver decides.',
  },
  finding_reported: {
    label: 'Finding reported',
    tone: 'neutral',
    help: 'The evidence was missing or contradictory, so no credit was proposed. A revision starts a new investigation.',
  },
  approved: { label: 'Approved', tone: 'active', help: 'An approver approved the credit. The simulated credit is being issued.' },
  credited: { label: 'Credited (simulated)', tone: 'good', help: 'One simulated credit was recorded. No real money moved.' },
  rejected: {
    label: 'Rejected',
    tone: 'bad',
    help: 'An approver rejected the proposal. A revision starts a new investigation that needs fresh approval.',
  },
  expired: {
    label: 'Approval expired',
    tone: 'bad',
    help: 'The approval window closed without a decision. A revision starts a new investigation that needs fresh approval.',
  },
  needs_attention: {
    label: 'Needs attention',
    tone: 'alert',
    help: 'Work failed, stopped on a limit or became poison. An operator must recover it.',
  },
});

const UNKNOWN_STATUS: StatusInfo = { label: 'Unknown status', tone: 'neutral', help: 'This console does not know this status.' };

/** Statuses the console keeps polling, because the case will move on without anyone acting. */
export const ACTIVE_STATUSES: readonly string[] = ['queued', 'investigating', 'approved'];

export function statusInfo(status: string): StatusInfo {
  const known = lookup(STATUS, status);
  return known ?? { ...UNKNOWN_STATUS, label: `Unknown status (${status})` };
}

export const CASE_STATUSES: readonly string[] = Object.keys(STATUS);

const RUN_STATES: Readonly<Record<string, string>> = Object.freeze({
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  budget_exhausted: 'Stopped: allowance used',
  blocked: 'Blocked',
});

export const runStateLabel = (state: string): string => lookup(RUN_STATES, state) ?? state;

export function stopReasonText(code: string | null): string | null {
  if (code === null) return null;
  const text = describeStop(code);
  return text === NO_DESCRIPTION ? `Stopped with code ${code}.` : text;
}

const TIMELINE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  case_created: 'Case created',
  run_queued: 'Investigation queued',
  run_started: 'Investigation started',
  tool_called: 'Evidence read',
  model_called: 'Model call',
  proposal_submitted: 'Proposal submitted',
  finding_recorded: 'Finding recorded',
  proposal_rejected_by_code: 'Proposal refused by code checks',
  decision_approved: 'Approved',
  decision_rejected: 'Rejected',
  revision_requested: 'Revision requested',
  execution_queued: 'Credit queued',
  credit_executed: 'Simulated credit issued',
  credit_reconciled: 'Credit reconciled with the provider',
  run_failed: 'Investigation failed',
  run_blocked: 'Investigation blocked',
  run_restarted: 'Investigation restarted',
  run_budget_exhausted: 'Investigation stopped: allowance used',
  run_resumed: 'Investigation resumed',
  work_poisoned: 'Work moved to poison',
  work_requeued: 'Work requeued',
  approval_expired: 'Approval expired',
});

/** The kind is an open set, so an unknown kind is shown as it is instead of being hidden. */
export const timelineLabel = (kind: string): string => lookup(TIMELINE_LABELS, kind) ?? kind.replaceAll('_', ' ');

const QUALITY: Readonly<Record<string, string>> = Object.freeze({
  measured: 'measured',
  estimated: 'estimated',
  unknown: 'unknown',
  not_applicable: 'not applicable',
});

export const qualityLabel = (quality: string): string => lookup(QUALITY, quality) ?? quality;

/** Unknown is not zero, so a missing count is never printed as 0. */
export const formatCount = (value: number | null): string => (value === null ? 'unknown' : String(value));

export const formatCostMicroUsd = (micro: number | null): string => (micro === null ? 'unknown' : `USD ${(micro / 1_000_000).toFixed(6)}`);

export const formatDuration = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const USAGE_OUTCOMES: Readonly<Record<string, string>> = Object.freeze({
  reserved: 'Reserved, not finished',
  succeeded: 'Succeeded',
  failed: 'Failed',
  ambiguous: 'Ambiguous, the outcome is not known',
  rejected_by_code: 'Refused by the service’s own checks',
});

export const usageOutcomeLabel = (outcome: string): string => lookup(USAGE_OUTCOMES, outcome) ?? outcome.replaceAll('_', ' ');

export const usageKindLabel = (kind: string): string => (kind === 'tool' ? 'Tool call' : kind === 'model' ? 'Model call' : kind);

/** Basis points are hundredths of a percent: 1000 is ten percent. */
export const formatBasisPoints = (basisPoints: number): string => `${String(basisPoints / 100)}%`;

const PROPOSAL_STATUS: Readonly<Record<string, string>> = Object.freeze({
  pending_approval: 'Awaiting a decision',
  reported: 'Reported',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Approval expired',
  executed: 'Credit issued (simulated)',
  superseded: 'Replaced by a later revision',
});

export const proposalStatusLabel = (status: string): string => lookup(PROPOSAL_STATUS, status) ?? status.replaceAll('_', ' ');

const PROPOSAL_TONE: Readonly<Record<string, Tone>> = Object.freeze({
  pending_approval: 'waiting',
  reported: 'neutral',
  approved: 'active',
  rejected: 'bad',
  expired: 'bad',
  executed: 'good',
  superseded: 'neutral',
});

export const proposalTone = (status: string): Tone => lookup(PROPOSAL_TONE, status) ?? 'neutral';

const EVIDENCE: Readonly<Record<string, string>> = Object.freeze({
  consistent: 'Consistent',
  missing: 'Missing evidence',
  contradictory: 'Contradictory evidence',
});

export const evidenceLabel = (assessment: string): string => lookup(EVIDENCE, assessment) ?? assessment;

const FINDINGS: Readonly<Record<string, string>> = Object.freeze({
  missing_evidence: 'Missing evidence',
  contradictory_evidence: 'Contradictory evidence',
  no_credit_due: 'No credit is due',
  exceeds_policy_limit: 'Exceeds the policy limit',
});

export const findingLabel = (code: string): string => lookup(FINDINGS, code) ?? code.replaceAll('_', ' ');

const RUN_MODES: Readonly<Record<string, string>> = Object.freeze({
  demo: 'Deterministic demo agent',
  live: 'Live model',
});

export const runModeLabel = (mode: string): string => lookup(RUN_MODES, mode) ?? mode;

/** The order the operator sees the work states in, with what each one holds. */
export const WORK_STATES: readonly { readonly value: string; readonly label: string; readonly help: string }[] = [
  { value: 'waiting', label: 'Waiting', help: 'Credit proposals waiting for a human decision.' },
  { value: 'failed', label: 'Failed', help: 'Investigation runs that stopped because of an error.' },
  { value: 'poison', label: 'Poison', help: 'Background work, such as an investigation start or a credit execution, that used all its attempts and was set aside.' },
  { value: 'recoverable', label: 'Recoverable', help: 'Background work whose claim expired or that never started.' },
  { value: 'budget_exhausted', label: 'Allowance used', help: 'Investigation runs stopped by a limit. A resume needs an explicit allowance.' },
  { value: 'completed', label: 'Completed', help: 'Background work that finished.' },
];

export const workStateLabel = (state: string): string => WORK_STATES.find((known) => known.value === state)?.label ?? state.replaceAll('_', ' ');

const WORK_STATE_TONES: Readonly<Record<string, Tone>> = Object.freeze({
  waiting: 'waiting',
  failed: 'bad',
  poison: 'alert',
  recoverable: 'alert',
  budget_exhausted: 'alert',
  completed: 'good',
});

export const workStateTone = (state: string): Tone => lookup(WORK_STATE_TONES, state) ?? 'neutral';

const WORK_KINDS: Readonly<Record<string, string>> = Object.freeze({
  proposal_approval: 'Proposal approval',
  investigation_run: 'Investigation run',
  outbox: 'Background work',
});

export const workKindLabel = (kind: string): string => lookup(WORK_KINDS, kind) ?? kind.replaceAll('_', ' ');

export interface UsageRow {
  readonly label: string;
  readonly value: string;
  readonly note: string | null;
}

const withLimit = (used: number, limit: number | undefined): string => (limit === undefined ? String(used) : `${String(used)} of ${String(limit)}`);

export function usageRows(usage: UsageSummary, limits: RunLimits | null): UsageRow[] {
  const tokens = `${formatCount(usage.inputTokens)} in, ${formatCount(usage.outputTokens)} out`;
  return [
    { label: 'Steps', value: withLimit(usage.steps, limits?.steps), note: null },
    { label: 'Tool calls', value: withLimit(usage.toolCalls, limits?.toolCalls), note: null },
    { label: 'Model calls', value: withLimit(usage.modelCalls, limits?.modelCalls), note: null },
    { label: 'Retries', value: withLimit(usage.retries, limits?.retriesPerRun), note: null },
    { label: 'Failed calls', value: String(usage.failedCalls), note: null },
    { label: 'Ambiguous calls', value: String(usage.ambiguousCalls), note: null },
    {
      label: 'Tokens',
      value: tokens,
      note: `${qualityLabel(usage.tokenQuality)}${limits === null ? '' : `; limit ${String(limits.tokens)} in total`}`,
    },
    {
      label: 'Model cost',
      value: formatCostMicroUsd(usage.costMicroUsd),
      note: `${qualityLabel(usage.costQuality)}${limits === null ? '' : `; limit ${formatCostMicroUsd(limits.costMicroUsd)}`}`,
    },
    {
      label: 'Active time',
      value: formatDuration(usage.activeMs),
      note: limits === null ? null : `limit ${formatDuration(limits.activeMs)}`,
    },
  ];
}

export interface ModeNotice {
  readonly tone: 'demo' | 'live' | 'blocked';
  readonly label: string;
  readonly detail: string;
}

/** Live and demo are never mixed: a blocked live mode is reported as blocked, not shown as demo. */
export function describeMode(environment: Session['environment']): ModeNotice {
  if (environment.agentMode === 'demo') {
    return {
      tone: 'demo',
      label: 'Deterministic demo agent',
      detail: 'Investigations use a deterministic, rule-based investigator. No model is called.',
    };
  }
  if (environment.liveAvailable) {
    return {
      tone: 'live',
      label: 'Live model',
      detail: 'Investigations call the configured model within the run and tenant limits. Code validates every proposal; the model cannot approve or execute a credit.',
    };
  }
  const code = environment.liveBlockedReason;
  let reason = 'The live model is not available.';
  if (code !== null) {
    const described = describeStop(code);
    reason = described === NO_DESCRIPTION ? `The live model is not available (${code}).` : described;
  }
  return {
    tone: 'blocked',
    label: 'Live model blocked',
    detail: `${reason} The demo agent is not substituted: a new case stops as "needs attention" with a blocked run.`,
  };
}
