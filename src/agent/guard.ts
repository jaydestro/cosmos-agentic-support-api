import type { EvidenceAssessment, FindingCode, InvoiceRef, Money, PolicyRef, ProposalKind } from '../cases/documents.ts';
import type { Account, Invoice, Policy } from '../data/documents.ts';
import { formatMinor } from '../domain/money.ts';
import { clip } from '../domain/text.ts';
import {
  MAX_INVOICE_REFS,
  adjudicate,
  type Adjudication,
  type CaseFacts,
  type CreditAdjudication,
  type FindingAdjudication,
} from './adjudicate.ts';

/**
 * The submission guard. Whatever proposes a credit, a demo plan or a model, its submission is
 * accepted only if it fits what `adjudicate` derives from the same retrieved evidence. The
 * guard never trusts the proposer's amount, policy reference, invoice references or assessment.
 */

/** A lookup a tool performed: not yet made, made with no result, or made with one. */
export type Lookup<T> = { status: 'pending' } | { status: 'absent' } | { status: 'present'; value: T };

/** What the investigation has retrieved. Only tool results ever populate it. */
export interface Retrieved {
  account: Lookup<Account>;
  policy: Lookup<Policy>;
  /** Invoices of the case account that a tool returned. */
  invoices: readonly Invoice[];
  /** Invoice ids that a tool looked up and did not find for this account. */
  notFound: readonly string[];
}

export interface Submission {
  kind: ProposalKind;
  amount: Money | null;
  /** The investigator's own words. They are shown beside the code-written facts, never instead of them. */
  note: string | null;
  invoiceRefs: InvoiceRef[];
  policyRef: PolicyRef | null;
  findingCode: FindingCode | null;
}

/** Everything a proposal stores, after code has decided what the investigator may not. */
export interface AcceptedSubmission {
  kind: ProposalKind;
  amount: Money | null;
  explanation: string;
  invoiceRefs: InvoiceRef[];
  policyRef: PolicyRef | null;
  findingCode: FindingCode | null;
  evidenceAssessment: EvidenceAssessment;
}

export type GuardCode =
  | 'account_unavailable'
  | 'policy_unavailable'
  | 'prerequisites_missing'
  | 'kind_mismatch'
  | 'finding_code_mismatch'
  | 'finding_has_amount'
  | 'credit_has_finding_code'
  | 'amount_required'
  | 'amount_not_positive'
  | 'currency_mismatch'
  | 'exceeds_request'
  | 'exceeds_evidence'
  | 'exceeds_policy_limit'
  | 'policy_ref_mismatch'
  | 'too_many_invoice_refs'
  | 'invoice_ref_not_retrieved'
  | 'duplicate_invoice_ref'
  | 'invalid_line_index'
  | 'invoice_refs_incomplete';

export interface Rejection {
  ok: false;
  code: GuardCode;
  /** Names the expected value so a model can correct itself. Built from identifiers and numbers only. */
  message: string;
}

export type GuardResult = { ok: true; accepted: AcceptedSubmission; adjudication: Adjudication } | Rejection;

export const MAX_EXPLANATION_CHARS = 2000;
export const MAX_NOTE_CHARS = 1000;
const NOTE_LABEL = 'Investigator note (written by the model, not verified): ';

const reject = (code: GuardCode, message: string): Rejection => ({ ok: false, code, message });

/**
 * The stored explanation always opens with the facts code derived. A model's note follows, labelled
 * as unverified, so a person approving a credit can tell them apart.
 */
export function composeExplanation(facts: readonly string[], note: string | null): string {
  const trimmed = clip(note?.trim() ?? '', MAX_NOTE_CHARS);
  const tail = trimmed === '' ? '' : `\n\n${NOTE_LABEL}${trimmed}`;
  return clip(facts.join(' '), MAX_EXPLANATION_CHARS - tail.length) + tail;
}

/** The submission that mirrors an adjudication exactly. The demo investigator proposes nothing else. */
export function submissionFor(adjudication: Adjudication, note: string | null = null): Submission {
  const invoiceRefs = adjudication.invoiceRefs.map((ref) => ({ ...ref }));
  const policyRef = adjudication.policyRef === null ? null : { ...adjudication.policyRef };
  if (adjudication.kind === 'credit') {
    return {
      kind: 'credit',
      amount: { amountMinor: adjudication.maxCreditMinor, currency: adjudication.currency },
      note,
      invoiceRefs,
      policyRef,
      findingCode: null,
    };
  }
  return { kind: 'finding', amount: null, note, invoiceRefs, policyRef, findingCode: adjudication.findingCode };
}

function samePolicyRef(a: PolicyRef | null, b: PolicyRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.policyId === b.policyId && a.version === b.version && a.clauseId === b.clauseId;
}

function describePolicyRef(ref: PolicyRef | null): string {
  return ref === null ? 'This outcome cites no policy clause; omit policyRef.' : `Cite policy ${ref.policyId} v${String(ref.version)}, clause ${ref.clauseId}.`;
}

interface Ready {
  account: Account;
  policy: Policy;
  /** Only invoices of the case account count, whatever a caller put in `retrieved`. */
  invoices: readonly Invoice[];
}

function ready(facts: CaseFacts, retrieved: Retrieved): Ready | Rejection {
  const { account, policy } = retrieved;
  if (account.status === 'absent') return reject('account_unavailable', 'The case account could not be found, so no proposal can be made.');
  if (policy.status === 'absent') return reject('policy_unavailable', 'No credit policy is effective for this tenant, so no proposal can be made.');

  const invoices =
    account.status === 'present' ? retrieved.invoices.filter((invoice) => invoice.accountId === account.value.accountId) : retrieved.invoices;
  const resolved = new Set([...invoices.map((invoice) => invoice.invoiceId), ...retrieved.notFound]);
  const unresolved = facts.invoiceIds.filter((id) => !resolved.has(id));
  const calls: string[] = [];
  if (account.status === 'pending') calls.push('call get_account');
  if (policy.status === 'pending') calls.push('call get_policy');
  if (unresolved.length > 0) calls.push(`call get_invoice for ${unresolved.join(', ')}`);
  if (account.status !== 'present' || policy.status !== 'present' || calls.length > 0) {
    return reject('prerequisites_missing', `Before submitting, ${calls.join(', ')}.`);
  }
  return { account: account.value, policy: policy.value, invoices };
}

function mismatchedKind(adjudication: Adjudication): string {
  return adjudication.kind === 'credit'
    ? `The evidence supports a credit of up to ${formatMinor(adjudication.maxCreditMinor, adjudication.currency)}. Submit kind credit.`
    : `The evidence supports the finding ${adjudication.findingCode}, not a credit. Submit kind finding with findingCode ${adjudication.findingCode}.`;
}

function checkFinding(adjudication: FindingAdjudication, submission: Submission): Rejection | null {
  if (submission.findingCode !== adjudication.findingCode) {
    return reject('finding_code_mismatch', `The evidence supports the finding ${adjudication.findingCode}. Submit findingCode ${adjudication.findingCode}.`);
  }
  if (submission.amount !== null) return reject('finding_has_amount', 'A finding carries no amount; omit amount.');
  return null;
}

function checkCredit(adjudication: CreditAdjudication, submission: Submission): Rejection | null {
  const { amount } = submission;
  const { currency } = adjudication;
  if (submission.findingCode !== null) return reject('credit_has_finding_code', 'A credit carries no findingCode; omit findingCode.');
  if (amount === null) {
    return reject('amount_required', `A credit needs an amount. The most code accepts is ${formatMinor(adjudication.maxCreditMinor, currency)}.`);
  }
  if (!Number.isInteger(amount.amountMinor) || amount.amountMinor <= 0) {
    return reject('amount_not_positive', 'A credit must be a positive whole number of minor currency units. When no credit is due, submit a finding instead.');
  }
  if (amount.currency !== currency) return reject('currency_mismatch', `The account currency is ${currency}.`);
  if (adjudication.requestedMinor !== null && amount.amountMinor > adjudication.requestedMinor) {
    return reject('exceeds_request', `The representative asked for ${formatMinor(adjudication.requestedMinor, currency)}; a credit cannot exceed the request.`);
  }
  if (amount.amountMinor > adjudication.eligibleMinor) {
    return reject('exceeds_evidence', `The retrieved evidence supports at most ${formatMinor(adjudication.eligibleMinor, currency)}.`);
  }
  if (amount.amountMinor > adjudication.capMinor) {
    return reject('exceeds_policy_limit', `The policy limit for this clause is ${formatMinor(adjudication.capMinor, currency)}.`);
  }
  return null;
}

function requiredInvoiceIds(adjudication: Adjudication): string[] {
  if (adjudication.kind === 'credit') return adjudication.creditedInvoiceIds;
  // Contradictory evidence is only credible with the records that disagree; other findings need no citation.
  return adjudication.findingCode === 'contradictory_evidence' ? adjudication.invoiceRefs.map((ref) => ref.invoiceId) : [];
}

function checkInvoiceRefs(adjudication: Adjudication, submission: Submission, invoices: readonly Invoice[]): Rejection | null {
  if (submission.invoiceRefs.length > MAX_INVOICE_REFS) {
    return reject('too_many_invoice_refs', `A proposal cites at most ${String(MAX_INVOICE_REFS)} invoices.`);
  }
  const byId = new Map(invoices.map((invoice) => [invoice.invoiceId, invoice]));
  const cited = new Set<string>();
  for (const ref of submission.invoiceRefs) {
    const invoice = byId.get(ref.invoiceId);
    if (invoice === undefined) {
      return reject('invoice_ref_not_retrieved', `Invoice ${ref.invoiceId} was not retrieved for this account; cite only invoices a tool returned.`);
    }
    if (cited.has(ref.invoiceId)) return reject('duplicate_invoice_ref', `Invoice ${ref.invoiceId} is cited more than once.`);
    cited.add(ref.invoiceId);
    if (ref.lineIndex !== null && ref.lineIndex >= invoice.lines.length) {
      return reject('invalid_line_index', `Invoice ${ref.invoiceId} has ${String(invoice.lines.length)} line(s); lineIndex must be null or below that.`);
    }
  }
  const lacking = requiredInvoiceIds(adjudication).filter((id) => !cited.has(id));
  if (lacking.length > 0) {
    return reject('invoice_refs_incomplete', `Cite every invoice the outcome rests on; missing: ${lacking.join(', ')}.`);
  }
  return null;
}

/**
 * Checks run in a fixed order and the first failure is returned, so a refusal is reproducible
 * and each message tells the proposer the one thing to change next.
 */
export function guardSubmission(facts: CaseFacts, retrieved: Retrieved, submission: Submission): GuardResult {
  const evidence = ready(facts, retrieved);
  if ('ok' in evidence) return evidence;
  const adjudication = adjudicate(facts, { account: evidence.account, invoices: evidence.invoices, policy: evidence.policy });

  if (submission.kind !== adjudication.kind) return reject('kind_mismatch', mismatchedKind(adjudication));
  const outcome = adjudication.kind === 'credit' ? checkCredit(adjudication, submission) : checkFinding(adjudication, submission);
  if (outcome !== null) return outcome;
  if (!samePolicyRef(submission.policyRef, adjudication.policyRef)) {
    return reject('policy_ref_mismatch', describePolicyRef(adjudication.policyRef));
  }
  const refs = checkInvoiceRefs(adjudication, submission, evidence.invoices);
  if (refs !== null) return refs;

  return {
    ok: true,
    adjudication,
    accepted: {
      kind: adjudication.kind,
      amount: submission.amount === null ? null : { amountMinor: submission.amount.amountMinor, currency: submission.amount.currency },
      explanation: composeExplanation(adjudication.facts, submission.note),
      invoiceRefs: submission.invoiceRefs.map((ref) => ({ invoiceId: ref.invoiceId, lineIndex: ref.lineIndex })),
      policyRef: adjudication.policyRef,
      findingCode: adjudication.kind === 'finding' ? adjudication.findingCode : null,
      evidenceAssessment: adjudication.assessment,
    },
  };
}
