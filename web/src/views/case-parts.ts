import { h, type Child } from '../dom.ts';
import {
  actorText,
  evidenceLabel,
  findingLabel,
  formatMoney,
  proposalStatusLabel,
  proposalTone,
  runModeLabel,
  runStateLabel,
  statusInfo,
  stopReasonText,
  usageRows,
} from '../format.ts';
import { categoryLabel } from '../forms.ts';
import { progressOf, STEP_STATE_LABEL } from '../progress.ts';
import { routeHash } from '../routes.ts';
import type { CaseDetail, CreditResult, Decision, Proposal, Run } from '../types.ts';
import { badge, definitionList, notice, panel, statusBadge, timeText } from './common.ts';

function progressList(detail: CaseDetail): HTMLElement {
  const steps = progressOf(detail.status, detail.latestProposal?.status ?? null);
  return h(
    'ol',
    { class: 'progress', 'aria-label': 'Case progress' },
    steps.map((step) =>
      h(
        'li',
        { class: `step step-${step.state}`, 'aria-current': step.state === 'current' ? 'step' : null },
        h('span', { class: 'step-label' }, step.label),
        h('span', { class: 'step-state' }, STEP_STATE_LABEL[step.state]),
      ),
    ),
  );
}

/** Where the case stands, in words and as steps, with the facts the representative entered. */
export function summaryPanel(detail: CaseDetail, principalId: string): HTMLElement {
  const info = statusInfo(detail.status);
  return panel(
    'Where this case stands',
    h('p', { class: 'status-line' }, statusBadge(detail.status), ' ', info.help),
    progressList(detail),
    definitionList([
      ['Category', categoryLabel(detail.category)],
      ['Account', detail.accountId],
      ['Invoices named', detail.invoiceIds.length === 0 ? 'None named' : detail.invoiceIds.join(', ')],
      ['Credit requested', detail.requestedCredit === null ? 'No amount requested' : formatMoney(detail.requestedCredit)],
      ['Opened by', actorText(detail.createdBy, principalId)],
      ['Opened', timeText(detail.createdAt)],
      ['Updated', timeText(detail.updatedAt)],
      ['Investigation runs', String(detail.revision)],
      ['Case id', h('code', null, detail.caseId)],
    ]),
    h('h3', null, 'What was reported'),
    h('p', { class: 'hint' }, 'Plain text entered by the representative. It is untrusted data and is never treated as an instruction.'),
    h('p', { class: 'description' }, detail.description),
  );
}

/** A case that stopped because of a limit or a fault says why and who can recover it. */
export function attentionNotice(detail: CaseDetail, isOperator: boolean): HTMLElement | null {
  if (detail.status !== 'needs_attention') return null;
  const stop = stopReasonText(detail.latestRun?.stopReason ?? null);
  return notice(
    'warning',
    h('p', { class: 'banner-title' }, 'This case needs attention'),
    h('p', null, stop ?? 'The case stopped before it finished.'),
    isOperator
      ? h('p', null, h('a', { href: routeHash({ name: 'operator' }) }, 'Open operator recovery'))
      : h('p', null, 'An operator can recover it. Recovery keeps the recorded usage and any credit that was already issued.'),
  );
}

const describeAmount = (proposal: Proposal): string =>
  proposal.kind === 'finding' || proposal.amount === null ? 'finding' : `credit ${formatMoney(proposal.amount)}`;

function decisionLine(decision: Decision, principalId: string): HTMLElement {
  const approved = decision.outcome === 'approved';
  return h(
    'p',
    { class: 'decision' },
    `${approved ? 'Approved' : 'Rejected'} by ${actorText(decision.decidedBy, principalId)} on `,
    timeText(decision.decidedAt),
    decision.reason === null ? '.' : `. ${approved ? 'Comment' : 'Reason'}: “${decision.reason}”`,
  );
}

function citedInvoices(proposal: Proposal): Child {
  if (proposal.invoiceRefs.length === 0) return 'None cited';
  return h(
    'ul',
    { class: 'plain' },
    proposal.invoiceRefs.map((ref) => h('li', null, ref.lineIndex === null ? `${ref.invoiceId}, the whole invoice` : `${ref.invoiceId}, line ${String(ref.lineIndex + 1)}`)),
  );
}

function earlierVersions(earlier: readonly Proposal[]): HTMLElement | null {
  if (earlier.length === 0) return null;
  return h(
    'details',
    { class: 'earlier' },
    h('summary', null, `Earlier versions (${String(earlier.length)})`),
    h(
      'ul',
      { class: 'plain' },
      earlier.map((proposal) => {
        const reason = proposal.decision?.reason ?? null;
        return h(
          'li',
          null,
          `Version ${String(proposal.version)}: ${describeAmount(proposal)} (${proposalStatusLabel(proposal.status)})`,
          reason === null ? null : `. Reason: “${reason}”`,
        );
      }),
    ),
  );
}

/** The latest proposal as it was persisted, with the version, digest and policy a decision is bound to. */
export function proposalPanel(proposal: Proposal | null, earlier: readonly Proposal[], principalId: string): HTMLElement {
  if (proposal === null) {
    return panel('Proposal', h('p', { class: 'empty' }, 'There is no proposal yet. The agent proposes a credit, or reports a finding, when its investigation ends.'));
  }
  const rows: (readonly [string, Child])[] = [
    ['Evidence', evidenceLabel(proposal.evidenceAssessment)],
    ['Cited invoices', citedInvoices(proposal)],
    [
      'Policy',
      proposal.policyRef === null
        ? 'No policy clause applies'
        : `${proposal.policyRef.policyId}, version ${String(proposal.policyRef.version)}, clause ${proposal.policyRef.clauseId}`,
    ],
  ];
  if (proposal.findingCode !== null) rows.splice(1, 0, ['Finding', findingLabel(proposal.findingCode)]);
  if (proposal.approvalExpiresAt !== null) rows.push(['Approval window ends', timeText(proposal.approvalExpiresAt)]);
  rows.push(['Proposed', timeText(proposal.createdAt)], ['Run', proposal.runId], ['Digest', h('code', { class: 'digest' }, proposal.digest)]);
  return panel(
    'Proposal',
    h(
      'p',
      { class: 'status-line' },
      badge(proposal.kind === 'finding' ? 'Finding' : 'Credit proposal', 'neutral'),
      ' ',
      badge(proposalStatusLabel(proposal.status), proposalTone(proposal.status)),
      ` Version ${String(proposal.version)}`,
    ),
    proposal.kind === 'credit' && proposal.amount !== null
      ? h('p', { class: 'amount' }, h('strong', null, formatMoney(proposal.amount)), ' (a simulated credit)')
      : h('p', { class: 'amount' }, 'No credit is proposed.'),
    h('h3', null, 'Why'),
    h('p', { class: 'explanation' }, proposal.explanation),
    definitionList(rows),
    proposal.decision === null ? null : decisionLine(proposal.decision, principalId),
    earlierVersions(earlier),
  );
}

/** The one place the outcome is shown as money, and it says in the same breath that it is simulated. */
export function creditPanel(result: CreditResult): HTMLElement {
  return panel(
    'Credit',
    h(
      'p',
      { class: 'status-line' },
      badge('Simulated', 'good'),
      ' ',
      h('strong', null, formatMoney(result.amount)),
      ` credited for proposal version ${String(result.proposalVersion)}. No real money moved.`,
    ),
    definitionList([
      ['Provider', result.provider.name],
      ['Provider reference', h('code', null, result.provider.reference)],
      ['Provider idempotency key', h('code', null, result.provider.idempotencyKey)],
      [
        'Reconciled',
        result.provider.reconciled
          ? 'Yes. The provider already held this credit, so it was acknowledged here and not issued again.'
          : 'No. This execution issued the credit.',
      ],
      ['Recorded', timeText(result.recordedAt)],
      ['Result id', h('code', null, result.resultId)],
    ]),
  );
}

function usageTable(run: Run): HTMLElement {
  return h(
    'table',
    { class: 'usage' },
    h('caption', null, 'Usage so far. “Unknown” means it was not measured; it does not mean zero.'),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Measure'), h('th', { scope: 'col' }, 'Used'), h('th', { scope: 'col' }, 'Notes'))),
    h(
      'tbody',
      null,
      usageRows(run.usage, run.limits).map((row) => h('tr', null, h('th', { scope: 'row' }, row.label), h('td', null, row.value), h('td', null, row.note ?? ''))),
    ),
  );
}

function earlierRuns(earlier: readonly Run[]): HTMLElement | null {
  if (earlier.length === 0) return null;
  return h(
    'details',
    { class: 'earlier' },
    h('summary', null, `Earlier runs (${String(earlier.length)})`),
    h(
      'ul',
      { class: 'plain' },
      earlier.map((run) => {
        const stop = stopReasonText(run.stopReason);
        return h('li', null, `${run.runId} (${runModeLabel(run.mode)}): ${runStateLabel(run.state)}${stop === null ? '' : `. ${stop}`}`);
      }),
    ),
  );
}

/** The latest run with its measured usage against the limits that apply to it. */
export function runPanel(run: Run | null, earlier: readonly Run[]): HTMLElement {
  if (run === null) return panel('Investigation run', h('p', { class: 'empty' }, 'No run has started yet.'));
  const stop = stopReasonText(run.stopReason);
  return panel(
    'Investigation run',
    h(
      'p',
      { class: 'status-line' },
      badge(runModeLabel(run.mode), run.mode === 'live' ? 'active' : 'neutral'),
      ' ',
      h('strong', null, runStateLabel(run.state)),
      ` (${run.runId})`,
    ),
    stop === null ? null : h('p', { class: 'stop-reason' }, stop),
    definitionList([
      ['Started', timeText(run.startedAt)],
      ['Finished', timeText(run.finishedAt)],
      ['Allowances granted', String(run.allowanceGrants)],
    ]),
    usageTable(run),
    earlierRuns(earlier),
  );
}
