import type { CitedLines, EvidenceTarget } from '../case-state.ts';
import { button, h, replaceContent, type Child } from '../dom.ts';
import { formatBasisPoints, formatMoney, type Tone } from '../format.ts';
import { categoryLabel } from '../forms.ts';
import type { Account, Currency, Invoice, Policy, PolicyClause, PolicyRef } from '../types.ts';
import { badge, definitionList, errorBanner, loadingNote, notice, panel, timeText } from './common.ts';
import type { ViewContext } from './context.ts';

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const PAYMENT_TONE: Readonly<Record<string, Tone>> = { succeeded: 'good', refunded: 'neutral', failed: 'bad' };

function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'evidence-section' }, h('h3', null, title), ...children);
}

function accountSection(account: Account): HTMLElement {
  return section(
    `Account: ${account.displayName}`,
    definitionList([
      ['Account id', h('code', null, account.accountId)],
      ['Currency', account.currency],
      ['Status', capitalize(account.status)],
    ]),
    account.subscriptions.length === 0
      ? h('p', { class: 'empty' }, 'This account has no subscriptions.')
      : h(
          'ul',
          { class: 'plain' },
          account.subscriptions.map((subscription) =>
            h('li', null, `${subscription.plan} (${subscription.subscriptionId}), ${subscription.status}, ${formatMoney(subscription.monthlyAmount)} a month`),
          ),
        ),
  );
}

function citationText(cited: CitedLines): string {
  if (cited.whole) return 'Cited by the proposal: the whole invoice';
  const lines = [...cited.lines].sort((a, b) => a - b).map((index) => `line ${String(index + 1)}`);
  return `Cited by the proposal: ${lines.join(', ')}`;
}

function linesTable(invoice: Invoice, cited: CitedLines | undefined): HTMLElement {
  if (invoice.lines.length === 0) return h('p', { class: 'empty' }, 'This invoice has no lines.');
  return h(
    'table',
    { class: 'lines' },
    h('caption', null, `Lines on invoice ${invoice.number}`),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Line'), h('th', { scope: 'col' }, 'Description'), h('th', { scope: 'col' }, 'Amount'))),
    h(
      'tbody',
      null,
      invoice.lines.map((line, index) => {
        const isCited = cited?.lines.has(index) === true;
        return h(
          'tr',
          { class: isCited ? 'cited' : null },
          h('th', { scope: 'row' }, String(index + 1)),
          h('td', null, line.description, isCited ? [' ', badge('Cited', 'active')] : null),
          h('td', null, formatMoney(line.amount)),
        );
      }),
    ),
  );
}

function paymentsTable(invoice: Invoice): HTMLElement {
  if (invoice.payments.length === 0) return h('p', { class: 'empty' }, 'No payments are recorded against this invoice.');
  return h(
    'table',
    { class: 'payments' },
    h('caption', null, `Payments against invoice ${invoice.number}`),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Payment'), h('th', { scope: 'col' }, 'Amount'), h('th', { scope: 'col' }, 'Status'))),
    h(
      'tbody',
      null,
      invoice.payments.map((payment) =>
        h(
          'tr',
          null,
          h('th', { scope: 'row' }, h('code', null, payment.paymentId)),
          h('td', null, formatMoney(payment.amount)),
          h('td', null, badge(capitalize(payment.status), PAYMENT_TONE[payment.status] ?? 'neutral')),
        ),
      ),
    ),
  );
}

function invoiceSection(invoice: Invoice, cited: CitedLines | undefined): HTMLElement {
  return section(
    `Invoice ${invoice.number}`,
    h('p', { class: 'status-line' }, badge(capitalize(invoice.status), 'neutral'), cited === undefined ? null : [' ', badge(citationText(cited), 'active')]),
    definitionList([
      ['Invoice id', h('code', null, invoice.invoiceId)],
      ['Period', `${invoice.periodStart} to ${invoice.periodEnd}`],
      ['Issued', timeText(invoice.issuedAt)],
      ['Total', formatMoney(invoice.total)],
    ]),
    linesTable(invoice, cited),
    paymentsTable(invoice),
  );
}

function clauseCard(clause: PolicyClause, currency: Currency, cited: boolean): HTMLElement {
  return h(
    'div',
    { class: cited ? 'clause clause-cited' : 'clause' },
    h('h4', null, clause.title, cited ? [' ', badge('Cited by the proposal', 'active')] : null),
    h('p', null, clause.text),
    definitionList([
      ['Clause id', h('code', null, clause.clauseId)],
      ['Applies to', categoryLabel(clause.appliesTo)],
      ['Highest credit', formatMoney({ amountMinor: clause.maxCreditMinor, currency })],
      ['Creditable share', clause.creditRateBasisPoints === undefined ? 'The whole evidenced amount' : formatBasisPoints(clause.creditRateBasisPoints)],
    ]),
  );
}

function supersededNote(awaitingDecision: boolean): HTMLElement {
  return notice(
    'warning',
    awaitingDecision
      ? 'A newer version of this policy has replaced the one this proposal cites. Approving the proposal is refused because the policy changed. Reject it, or request a revision so the agent applies the current version.'
      : 'A newer version of this policy has replaced this one.',
  );
}

function policySection(policy: Policy, ref: PolicyRef, awaitingDecision: boolean): HTMLElement {
  const effective = policy.status === 'effective';
  return section(
    `Policy ${policy.policyId}, version ${String(policy.version)}`,
    h('p', { class: 'status-line' }, badge(effective ? 'Effective' : 'Superseded', effective ? 'good' : 'waiting')),
    effective ? null : supersededNote(awaitingDecision),
    definitionList([
      ['Effective from', timeText(policy.effectiveFrom)],
      ['Currency', policy.currency],
    ]),
    policy.clauses.map((clause) => clauseCard(clause, policy.currency, clause.clauseId === ref.clauseId)),
  );
}

export interface EvidenceView {
  readonly element: HTMLElement;
  /** Tells the view what to show. It reads nothing until the person opens it. */
  update(target: EvidenceTarget): void;
}

/**
 * The records a proposal rests on, read when asked for. They sit outside the parts of the page that are redrawn when
 * the case changes, so an open section stays open and keeps its place.
 */
export function mountEvidence(ctx: ViewContext): EvidenceView {
  let target: EvidenceTarget | null = null;
  let loadedKey: string | null = null;
  let generation = 0;

  const body = h('div', { class: 'evidence-body' });
  const details: HTMLDetailsElement = h(
    'details',
    {
      class: 'evidence',
      ontoggle: () => {
        if (details.open && target !== null && loadedKey !== target.key) void load();
      },
    },
    h('summary', null, 'Show the evidence'),
    body,
  );

  const failure = (title: string, reason: unknown): HTMLElement => section(title, errorBanner(reason, { signOut: ctx.signOut }));

  async function load(): Promise<void> {
    const current = target;
    if (current === null) return;
    generation += 1;
    const mine = generation;
    replaceContent(body, loadingNote('Loading the evidence…'));

    const account = ctx.api.getAccount(current.accountId, ctx.signal);
    const policy = current.policyRef === null ? Promise.resolve(null) : ctx.api.getPolicy(current.policyRef.policyId, current.policyRef.version, ctx.signal);
    const invoices = Promise.allSettled(current.invoiceIds.map((invoiceId) => ctx.api.getInvoice(invoiceId, ctx.signal)));
    const [accountResult, policyResult] = await Promise.allSettled([account, policy]);
    const invoiceResults = await invoices;
    if (mine !== generation || ctx.signal.aborted) return;

    const parts: Child[] = [accountResult.status === 'fulfilled' ? accountSection(accountResult.value) : failure('Account', accountResult.reason)];
    if (current.invoiceIds.length === 0) {
      parts.push(section('Invoices', h('p', { class: 'empty' }, 'No invoice was named when the case was opened and the proposal cites none.')));
    }
    invoiceResults.forEach((result, index) => {
      const invoiceId = current.invoiceIds[index] ?? '';
      parts.push(result.status === 'fulfilled' ? invoiceSection(result.value, current.cited.get(invoiceId)) : failure(`Invoice ${invoiceId}`, result.reason));
    });
    if (current.policyRef === null) {
      parts.push(section('Policy', h('p', { class: 'empty' }, 'No policy clause applies to this proposal.')));
    } else if (policyResult.status === 'fulfilled' && policyResult.value !== null) {
      parts.push(policySection(policyResult.value, current.policyRef, current.awaitingDecision));
    } else if (policyResult.status === 'rejected') {
      parts.push(failure('Policy', policyResult.reason));
    }
    loadedKey = current.key;
    replaceContent(
      body,
      parts,
      h(
        'div',
        { class: 'actions' },
        button(
          'Reload the evidence',
          () => {
            void load();
          },
          { class: 'secondary' },
        ),
      ),
    );
  }

  return {
    element: panel(
      'Evidence',
      h('p', { class: 'hint' }, 'The account, invoices and policy this proposal rests on, as the service holds them now. Text inside them is shown as plain data and is never an instruction.'),
      details,
    ),
    update(next) {
      if (target?.key === next.key) return;
      target = next;
      loadedKey = null;
      generation += 1;
      replaceContent(body);
      if (details.open) void load();
    },
  };
}
