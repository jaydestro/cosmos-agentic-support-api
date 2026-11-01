import type { CaseCategory, EvidenceAssessment, FindingCode, InvoiceRef, Money, PolicyRef } from '../cases/documents.ts';
import type { Account, Invoice, Policy } from '../data/documents.ts';
import { formatMinor, type Currency } from '../domain/money.ts';

/**
 * Deterministic adjudication. It decides what the retrieved evidence and the policy allow, and it
 * is the only place that does. The demo investigator uses it to propose, and the submission guard
 * uses it to check any proposal, so a model can never be more generous than this code.
 *
 * It is pure and total: it reads only its arguments, never throws, and never trusts free text.
 * Every sentence in `facts` is built from identifiers and numbers, never from invoice line
 * descriptions or the case description.
 */

type Clause = Policy['clauses'][number];

export interface CaseFacts {
  category: CaseCategory;
  /** Invoice ids the representative cited, in the order given. */
  invoiceIds: readonly string[];
  requestedCredit: Money | null;
}

export interface Evidence {
  account: Account;
  /**
   * Invoices that were retrieved. Any that belong to another account are ignored, and a cited id
   * that is not among them counts as missing.
   */
  invoices: readonly Invoice[];
  /** The effective policy version the investigation retrieved. */
  policy: Policy;
}

interface Common {
  assessment: EvidenceAssessment;
  /** The clause that governed the decision, when the policy has one for the category. */
  policyRef: PolicyRef | null;
  /** Invoices that support the outcome, oldest issued first. */
  invoiceRefs: InvoiceRef[];
  /** Sentences made only of identifiers and numbers. */
  facts: string[];
}

export interface CreditAdjudication extends Common {
  kind: 'credit';
  assessment: 'consistent';
  policyRef: PolicyRef;
  currency: Currency;
  /** The invoices the credit rests on. A credit proposal must cite every one of them. */
  creditedInvoiceIds: string[];
  /** The most the evidence supports once the clause rate is applied. */
  eligibleMinor: number;
  capMinor: number;
  requestedMinor: number | null;
  /** The highest amount code accepts: the lowest of the cap, the eligible amount and the request. */
  maxCreditMinor: number;
}

export interface FindingAdjudication extends Common {
  kind: 'finding';
  findingCode: FindingCode;
}

export type Adjudication = CreditAdjudication | FindingAdjudication;

export const MAX_INVOICE_REFS = 10;
const FULL_RATE = 10000;

const compare = (a: number | string, b: number | string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Oldest issued first; the invoice id breaks ties so the order never depends on retrieval order. */
const byIssue = (a: Invoice, b: Invoice): number =>
  compare(Date.parse(a.issuedAt), Date.parse(b.issuedAt)) || compare(a.invoiceId, b.invoiceId);

const periodKey = (invoice: Invoice): string => `${invoice.subscriptionId}|${invoice.periodStart}|${invoice.periodEnd}`;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return [...groups.values()];
}

const idsOf = (invoices: readonly Pick<Invoice, 'invoiceId'>[]): string => invoices.map((invoice) => invoice.invoiceId).join(', ');

const refsOf = (invoices: readonly Invoice[]): InvoiceRef[] =>
  invoices.slice(0, MAX_INVOICE_REFS).map((invoice) => ({ invoiceId: invoice.invoiceId, lineIndex: null }));

/** Every credited invoice first, then supporting invoices while room remains; oldest issued first. */
function creditRefs(credited: readonly Invoice[], supporting: readonly Invoice[]): InvoiceRef[] {
  const chosen = new Map<string, Invoice>(credited.map((invoice) => [invoice.invoiceId, invoice]));
  for (const invoice of supporting) {
    if (chosen.size >= MAX_INVOICE_REFS) break;
    chosen.set(invoice.invoiceId, invoice);
  }
  return refsOf([...chosen.values()].toSorted(byIssue));
}

const collectedMinor = (invoice: Invoice): number =>
  sum(
    invoice.payments
      .filter((payment) => payment.status === 'succeeded' && payment.amount.currency === invoice.total.currency)
      .map((payment) => payment.amount.amountMinor),
  );

type Problem =
  | 'void_but_collected'
  | 'open_but_collected'
  | 'paid_without_matching_payment'
  | 'currency_mismatch'
  | 'lines_do_not_add_up';

const PROBLEM_TEXT: Record<Problem, string> = {
  void_but_collected: 'is void but has a successful payment',
  open_but_collected: 'is open but has a successful payment',
  paid_without_matching_payment: 'is marked paid but its successful payments do not equal its total',
  currency_mismatch: 'is not in the account currency',
  lines_do_not_add_up: 'has line items that do not add up to its total',
};

function problemsOf(invoice: Invoice, currency: Currency): Problem[] {
  const problems: Problem[] = [];
  const collected = collectedMinor(invoice);
  if (invoice.status === 'void' && collected > 0) problems.push('void_but_collected');
  if (invoice.status === 'open' && collected > 0) problems.push('open_but_collected');
  if (invoice.status === 'paid' && collected !== invoice.total.amountMinor) problems.push('paid_without_matching_payment');
  if (invoice.total.currency !== currency) problems.push('currency_mismatch');
  if (sum(invoice.lines.map((line) => line.amount.amountMinor)) !== invoice.total.amountMinor) problems.push('lines_do_not_add_up');
  return problems;
}

/**
 * The invoices a dispute is about: those the representative cited and, for a duplicate charge,
 * any retrieved invoices that share a billing period with another retrieved invoice.
 */
function relevantInvoices(facts: CaseFacts, invoices: readonly Invoice[]): Invoice[] {
  const cited = new Set(facts.invoiceIds);
  const perPeriod = new Map<string, number>();
  for (const invoice of invoices) perPeriod.set(periodKey(invoice), (perPeriod.get(periodKey(invoice)) ?? 0) + 1);
  return invoices
    .filter(
      (invoice) =>
        cited.has(invoice.invoiceId) ||
        (facts.category === 'duplicate_charge' && (perPeriod.get(periodKey(invoice)) ?? 0) > 1),
    )
    .toSorted(byIssue);
}

interface Credit {
  invoice: Invoice;
  /** What this invoice contributes before the clause rate is applied. */
  baseMinor: number;
}

interface Eligibility {
  credits: Credit[];
  /** Invoices that support the outcome even when they earn no credit, such as the original of a duplicate. */
  evidence: Invoice[];
  notes: string[];
}

const none = (): Eligibility => ({ credits: [], evidence: [], notes: [] });

function duplicateEligibility(relevant: readonly Invoice[]): Eligibility {
  const collected = relevant.filter((invoice) => invoice.status === 'paid');
  const groups = groupBy(collected, (invoice) => `${periodKey(invoice)}|${String(invoice.total.amountMinor)}|${invoice.total.currency}`).flatMap(
    (group) => {
      const [original, ...duplicates] = group;
      return original === undefined || duplicates.length === 0 ? [] : [{ original, duplicates }];
    },
  );
  return {
    credits: groups.flatMap((group) => group.duplicates.map((invoice) => ({ invoice, baseMinor: invoice.total.amountMinor }))),
    evidence: groups.flatMap((group) => [group.original, ...group.duplicates]),
    notes: groups.map(({ original, duplicates }) => {
      const all = [original, ...duplicates];
      return `Invoices ${idsOf(all)} cover ${original.periodStart} to ${original.periodEnd} on ${original.subscriptionId} for ${formatMinor(original.total.amountMinor, original.total.currency)} each and were all collected. ${original.invoiceId} was issued first; ${idsOf(duplicates)} ${duplicates.length === 1 ? 'is the duplicate' : 'are the duplicates'}.`;
    }),
  };
}

function incorrectAmountEligibility(relevant: readonly Invoice[], account: Account): Eligibility {
  const credits: Credit[] = [];
  const notes: string[] = [];
  for (const invoice of relevant.filter((candidate) => candidate.status === 'paid')) {
    const agreed = account.subscriptions.find((subscription) => subscription.subscriptionId === invoice.subscriptionId)?.monthlyAmount;
    if (agreed === undefined || agreed.currency !== invoice.total.currency) continue;
    const overMinor = Math.max(0, invoice.total.amountMinor - agreed.amountMinor);
    notes.push(
      `${invoice.invoiceId} was collected for ${formatMinor(invoice.total.amountMinor, invoice.total.currency)} against an agreed ${formatMinor(agreed.amountMinor, agreed.currency)} on ${invoice.subscriptionId}.`,
    );
    if (overMinor > 0) credits.push({ invoice, baseMinor: overMinor });
  }
  return { credits, evidence: credits.map((credit) => credit.invoice), notes };
}

function outageEligibility(relevant: readonly Invoice[]): Eligibility {
  const collected = relevant.filter((invoice) => invoice.status === 'paid');
  const originals = groupBy(collected, periodKey).flatMap((group) => group.slice(0, 1));
  return {
    credits: originals.map((invoice) => ({ invoice, baseMinor: invoice.total.amountMinor })),
    evidence: originals,
    notes: originals.map(
      (invoice) =>
        `${invoice.invoiceId} is the collected charge of ${formatMinor(invoice.total.amountMinor, invoice.total.currency)} for ${invoice.periodStart} to ${invoice.periodEnd} on ${invoice.subscriptionId}.`,
    ),
  };
}

function eligibilityOf(category: CaseCategory, relevant: readonly Invoice[], account: Account): Eligibility {
  switch (category) {
    case 'duplicate_charge':
      return duplicateEligibility(relevant);
    case 'incorrect_amount':
      return incorrectAmountEligibility(relevant, account);
    case 'service_outage':
      return outageEligibility(relevant);
    case 'other':
      return none();
  }
}

/** Findings that need no clause arithmetic. */
function finding(
  findingCode: FindingCode,
  assessment: EvidenceAssessment,
  policyRef: PolicyRef | null,
  invoices: readonly Invoice[],
  facts: string[],
): FindingAdjudication {
  return { kind: 'finding', findingCode, assessment, policyRef, invoiceRefs: refsOf(invoices), facts };
}

const percent = (rate: number): string => `${String(rate / 100)}%`;

const refOf = (policy: Policy, clause: Clause): PolicyRef => ({
  policyId: policy.policyId,
  version: policy.version,
  clauseId: clause.clauseId,
});

export function adjudicate(facts: CaseFacts, evidence: Evidence): Adjudication {
  const { account, policy } = evidence;
  const currency = account.currency;
  const own = evidence.invoices.filter(
    (invoice, index, all) => invoice.accountId === account.accountId && all.findIndex((other) => other.invoiceId === invoice.invoiceId) === index,
  );
  const relevant = relevantInvoices(facts, own);
  const found = new Set(own.map((invoice) => invoice.invoiceId));
  const clause = policy.clauses.find((candidate) => candidate.appliesTo === facts.category);
  const policyRef = clause === undefined ? null : refOf(policy, clause);

  const flagged = relevant.flatMap((invoice) => problemsOf(invoice, currency).map((problem) => ({ invoice, problem })));
  const conflicts = flagged.map(({ invoice, problem }) => `${invoice.invoiceId} ${PROBLEM_TEXT[problem]}.`);
  if (policy.currency !== currency) conflicts.push(`Policy currency ${policy.currency} differs from account currency ${currency}.`);
  if (facts.requestedCredit !== null && facts.requestedCredit.currency !== currency) {
    conflicts.push(`The requested credit is in ${facts.requestedCredit.currency} but the account is in ${currency}.`);
  }
  if (conflicts.length > 0) {
    const flaggedInvoices = flagged.map((entry) => entry.invoice).filter((invoice, index, all) => all.indexOf(invoice) === index);
    return finding('contradictory_evidence', 'contradictory', policyRef, flaggedInvoices, [
      ...conflicts,
      'No credit is proposed while the billing records disagree.',
    ]);
  }

  const unresolved = facts.invoiceIds.filter((id) => !found.has(id));
  const missing: string[] = [];
  if (unresolved.length > 0) {
    missing.push(`Cited ${unresolved.length === 1 ? 'invoice' : 'invoices'} ${unresolved.join(', ')} could not be found for this account.`);
  }
  if (facts.category === 'duplicate_charge' && relevant.length < 2) {
    missing.push(`A duplicate charge needs at least two invoices for one period and ${String(relevant.length)} ${relevant.length === 1 ? 'was' : 'were'} found.`);
  }
  if ((facts.category === 'incorrect_amount' || facts.category === 'service_outage') && facts.invoiceIds.length === 0) {
    missing.push('No invoice was cited, so the disputed charge cannot be identified.');
  }
  if (facts.category === 'incorrect_amount') {
    for (const invoice of relevant.filter((candidate) => candidate.status === 'paid')) {
      const agreed = account.subscriptions.find((subscription) => subscription.subscriptionId === invoice.subscriptionId)?.monthlyAmount;
      if (agreed === undefined || agreed.currency !== invoice.total.currency) {
        missing.push(`The agreed monthly amount for ${invoice.subscriptionId} is not on record, so ${invoice.invoiceId} cannot be checked.`);
      }
    }
  }
  if (missing.length > 0) {
    return finding('missing_evidence', 'missing', policyRef, relevant, [...missing, 'No credit is proposed without the evidence.']);
  }

  if (clause === undefined) {
    return finding('no_credit_due', 'consistent', null, relevant, [
      `Policy ${policy.policyId} v${String(policy.version)} has no clause for ${facts.category}.`,
    ]);
  }

  const governing = refOf(policy, clause);
  const requestedMinor = facts.requestedCredit?.amountMinor ?? null;
  const rate = clause.creditRateBasisPoints ?? FULL_RATE;
  const eligibility = eligibilityOf(facts.category, relevant, account);
  // A credit never rests on an invoice it cannot cite, so only the oldest creditable invoices that fit count.
  const credits = eligibility.credits.toSorted((a, b) => byIssue(a.invoice, b.invoice)).slice(0, MAX_INVOICE_REFS);
  const omitted = eligibility.credits.length - credits.length;
  const baseMinor = sum(credits.map((credit) => credit.baseMinor));
  const eligibleMinor = Math.floor((baseMinor * rate) / FULL_RATE);
  const clauseFact = `Policy ${policy.policyId} v${String(policy.version)}, clause ${clause.clauseId}.`;
  const limitFact = `Policy limit: ${formatMinor(clause.maxCreditMinor, currency)}.`;

  if (clause.maxCreditMinor === 0) {
    const asked = (requestedMinor ?? 0) > 0 || eligibleMinor > 0;
    return finding(asked ? 'exceeds_policy_limit' : 'no_credit_due', 'consistent', governing, relevant, [
      clauseFact,
      'The clause allows no credit for this category.',
      limitFact,
    ]);
  }
  if (eligibleMinor === 0) {
    return finding('no_credit_due', 'consistent', governing, eligibility.evidence.length > 0 ? eligibility.evidence : relevant, [
      clauseFact,
      ...eligibility.notes,
      'The retrieved evidence does not support a credit under this clause.',
    ]);
  }
  if (requestedMinor === 0) {
    return finding('no_credit_due', 'consistent', governing, eligibility.evidence, [clauseFact, 'The requested credit is zero.']);
  }

  const maxCreditMinor = Math.min(clause.maxCreditMinor, eligibleMinor, requestedMinor ?? Number.POSITIVE_INFINITY);
  const rateFact = rate === FULL_RATE ? '' : ` (${percent(rate)} of ${formatMinor(baseMinor, currency)})`;
  const reduced = requestedMinor !== null && maxCreditMinor < requestedMinor;
  return {
    kind: 'credit',
    assessment: 'consistent',
    policyRef: governing,
    currency,
    creditedInvoiceIds: credits.map((credit) => credit.invoice.invoiceId),
    eligibleMinor,
    capMinor: clause.maxCreditMinor,
    requestedMinor,
    maxCreditMinor,
    invoiceRefs: creditRefs(
      credits.map((credit) => credit.invoice),
      eligibility.evidence,
    ),
    facts: [
      clauseFact,
      ...eligibility.notes,
      ...(omitted > 0
        ? [`${String(omitted)} further creditable ${omitted === 1 ? 'invoice is' : 'invoices are'} not included because a proposal cites at most ${String(MAX_INVOICE_REFS)}.`]
        : []),
      `Creditable under the clause: ${formatMinor(eligibleMinor, currency)}${rateFact}.`,
      limitFact,
      `Requested: ${requestedMinor === null ? 'not stated' : formatMinor(requestedMinor, currency)}.`,
      ...(reduced ? ['The request is reduced to the most the evidence and policy allow.'] : []),
      `Proposed credit: ${formatMinor(maxCreditMinor, currency)}.`,
    ],
  };
}
