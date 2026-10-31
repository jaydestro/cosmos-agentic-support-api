import { BASE_RUN_LIMITS } from '../../src/config/limits.ts';
import { parseMajorUnits } from './format.ts';
import type { Allowance, ApproveRequest, CaseCategory, CreateCaseRequest, Currency, FieldError, Proposal, RecoverRequest, RejectRequest, RevisionRequest } from './types.ts';

/** The limits below mirror `contracts/openapi.yaml`; a unit test compares them with it. */
export const ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,64}$/;
export const MAX_INVOICES = 5;
export const DESCRIPTION_MAX = 4000;
export const REASON_MAX = 500;
export const COMMENT_MAX = 500;

/** The contract's `maxLength` counts Unicode code points. `String.length` counts UTF-16 units and would refuse emoji-heavy text the service accepts. */
export const characterCount = (text: string): number => Array.from(text).length;

export const CATEGORIES: readonly { readonly value: CaseCategory; readonly label: string }[] = [
  { value: 'duplicate_charge', label: 'Duplicate charge' },
  { value: 'incorrect_amount', label: 'Incorrect amount' },
  { value: 'service_outage', label: 'Service outage' },
  { value: 'other', label: 'Other' },
];

export const categoryLabel = (category: string): string => CATEGORIES.find((known) => known.value === category)?.label ?? category.replaceAll('_', ' ');

export const CURRENCIES: readonly Currency[] = ['USD', 'EUR'];

export type FieldErrors = Readonly<Record<string, string>>;
export type Built<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: FieldErrors };

const failed = (errors: Record<string, string>): { ok: false; errors: FieldErrors } => ({ ok: false, errors });

/** A fresh key. The random source is injected so the module stays free of browser and Node globals. */
export function newIdempotencyKey(randomBytes: (length: number) => Uint8Array): string {
  return `ui-${Array.from(randomBytes(12), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export interface CreateCaseInput {
  readonly accountId: string;
  readonly invoiceIds: readonly string[];
  readonly category: string;
  /** Major units such as `49` or `49.50`. Blank means the representative did not request an amount. */
  readonly requestedAmount: string;
  readonly currency: string;
  readonly description: string;
  readonly idempotencyKey: string;
}

export interface CreateCaseBuilt {
  readonly request: CreateCaseRequest;
  readonly idempotencyKey: string;
}

const isCategory = (value: string): value is CaseCategory => CATEGORIES.some((category) => category.value === value);
const isCurrency = (value: string): value is Currency => CURRENCIES.some((currency) => currency === value);

export function buildCreateCase(input: CreateCaseInput): Built<CreateCaseBuilt> {
  const errors: Record<string, string> = {};
  const accountId = input.accountId.trim();
  if (!ID_PATTERN.test(accountId)) errors['accountId'] = 'Enter an account id such as acct_aurora_0001.';

  const invoiceIds = input.invoiceIds.map((id) => id.trim());
  if (invoiceIds.length > MAX_INVOICES) errors['invoiceIds'] = `Select at most ${String(MAX_INVOICES)} invoices.`;
  else if (invoiceIds.some((id) => !ID_PATTERN.test(id)) || new Set(invoiceIds).size !== invoiceIds.length) {
    errors['invoiceIds'] = 'The selected invoices are not valid.';
  }

  if (!isCategory(input.category)) errors['category'] = 'Choose a category.';

  let requestedCredit: CreateCaseRequest['requestedCredit'];
  if (input.requestedAmount.trim() !== '') {
    const amountMinor = parseMajorUnits(input.requestedAmount);
    if (amountMinor === null) errors['requestedAmount'] = 'Enter an amount from 0.01 to 100000.00, with at most two decimals.';
    else if (!isCurrency(input.currency)) errors['currency'] = 'Choose USD or EUR.';
    else requestedCredit = { amountMinor, currency: input.currency };
  }

  const description = input.description.trim();
  if (description === '') errors['description'] = 'Describe the dispute.';
  else if (characterCount(description) > DESCRIPTION_MAX) errors['description'] = `Use at most ${String(DESCRIPTION_MAX)} characters.`;

  if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    errors['idempotencyKey'] = 'Use 16 to 64 characters from A-Z, a-z, 0-9, dot, underscore, tilde and hyphen.';
  }

  if (Object.keys(errors).length > 0 || !isCategory(input.category)) return failed(errors);
  return {
    ok: true,
    value: {
      idempotencyKey: input.idempotencyKey,
      request: {
        accountId,
        ...(invoiceIds.length > 0 ? { invoiceIds } : {}),
        category: input.category,
        ...(requestedCredit === undefined ? {} : { requestedCredit }),
        description,
      },
    },
  };
}

/** Which create-case field a server field error is about, or null when it names none of them. */
export function createCaseFieldOf(pointer: string): string | null {
  const [head = '', next] = pointer.replace(/^#?\//, '').split('/');
  switch (head) {
    case 'accountId':
    case 'invoiceIds':
    case 'category':
    case 'description':
      return head;
    case 'requestedCredit':
      return next === 'currency' ? 'currency' : 'requestedAmount';
    default:
      return null;
  }
}

/** Splits a problem's field errors into messages for form fields and the rest, which only an error banner can show. */
export function splitFieldErrors(
  errors: readonly FieldError[],
  fieldOf: (pointer: string) => string | null = createCaseFieldOf,
): { readonly fields: FieldErrors; readonly rest: readonly FieldError[] } {
  const fields: Record<string, string> = {};
  const rest: FieldError[] = [];
  for (const error of errors) {
    const key = fieldOf(error.pointer);
    if (key === null) rest.push(error);
    else fields[key] ??= error.message;
  }
  return { fields, rest };
}

function checkedReason(text: string, label: string): Built<string> {
  const reason = text.trim();
  if (reason === '') return failed({ reason: `${label} is required.` });
  if (characterCount(reason) > REASON_MAX) return failed({ reason: `Use at most ${String(REASON_MAX)} characters.` });
  return { ok: true, value: reason };
}

/** A decision is bound to the exact proposal and policy version the approver saw. */
type Decidable = Pick<Proposal, 'digest' | 'policyRef'>;

export function buildApprove(proposal: Decidable, comment: string): Built<ApproveRequest> {
  if (proposal.policyRef === null) return failed({ proposal: 'This proposal cites no policy, so it cannot be approved.' });
  const note = comment.trim();
  if (characterCount(note) > COMMENT_MAX) return failed({ comment: `Use at most ${String(COMMENT_MAX)} characters.` });
  return {
    ok: true,
    value: {
      policyVersion: proposal.policyRef.version,
      proposalDigest: proposal.digest,
      ...(note === '' ? {} : { comment: note }),
    },
  };
}

export function buildReject(proposal: Decidable, reasonText: string): Built<RejectRequest> {
  if (proposal.policyRef === null) return failed({ proposal: 'This proposal cites no policy, so it cannot be rejected.' });
  const reason = checkedReason(reasonText, 'A reason');
  if (!reason.ok) return reason;
  return { ok: true, value: { policyVersion: proposal.policyRef.version, proposalDigest: proposal.digest, reason: reason.value } };
}

export function buildRevision(reasonText: string): Built<RevisionRequest> {
  const reason = checkedReason(reasonText, 'A reason');
  return reason.ok ? { ok: true, value: { reason: reason.value } } : reason;
}

export interface AllowanceField {
  readonly key: keyof Allowance;
  readonly label: string;
  readonly min: number;
  readonly max: number;
}

/** Each grant is capped by the base run limit it adds to; the server enforces the same bounds. */
export const ALLOWANCE_FIELDS: readonly AllowanceField[] = [
  { key: 'steps', label: 'Steps', min: 1, max: BASE_RUN_LIMITS.steps },
  { key: 'toolCalls', label: 'Tool calls', min: 1, max: BASE_RUN_LIMITS.toolCalls },
  { key: 'modelCalls', label: 'Model calls', min: 1, max: BASE_RUN_LIMITS.modelCalls },
  { key: 'tokens', label: 'Tokens', min: 1, max: BASE_RUN_LIMITS.tokens },
  { key: 'costMicroUsd', label: 'Cost (micro-USD)', min: 1, max: BASE_RUN_LIMITS.costMicroUsd },
  { key: 'activeMs', label: 'Active time (milliseconds)', min: 1000, max: BASE_RUN_LIMITS.activeMs },
];

export interface RecoverInput {
  readonly action: 'requeue' | 'resume';
  readonly reason: string;
  /** Text per allowance key. A requeue carries no allowance and ignores these. */
  readonly allowance: Readonly<Record<string, string>>;
}

export function buildRecover(input: RecoverInput): Built<RecoverRequest> {
  const errors: Record<string, string> = {};
  const reason = checkedReason(input.reason, 'A reason');
  if (!reason.ok) Object.assign(errors, reason.errors);
  if (input.action === 'requeue') {
    return reason.ok ? { ok: true, value: { action: 'requeue', reason: reason.value } } : failed(errors);
  }

  const allowance: Allowance = {};
  let allowanceInvalid = false;
  for (const field of ALLOWANCE_FIELDS) {
    const text = (input.allowance[field.key] ?? '').trim();
    if (text === '') continue;
    const value = /^\d{1,9}$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      errors[field.key] = `Enter a whole number from ${String(field.min)} to ${String(field.max)}, or leave it empty.`;
      allowanceInvalid = true;
    } else {
      allowance[field.key] = value;
    }
  }
  if (Object.keys(allowance).length === 0 && !allowanceInvalid) {
    errors['allowance'] = 'A resume must grant at least one allowance. Nothing is reset and usage history is kept.';
  }
  if (Object.keys(errors).length > 0 || !reason.ok) return failed(errors);
  return { ok: true, value: { action: 'resume', reason: reason.value, allowance } };
}

/** Which recovery field a server field error is about, or null when it names none of them. */
export function recoverFieldOf(pointer: string): string | null {
  const [head = '', next = ''] = pointer.replace(/^#?\//, '').split('/');
  if (head === 'reason') return 'reason';
  if (head !== 'allowance') return null;
  return ALLOWANCE_FIELDS.some((candidate) => candidate.key === next) ? next : 'allowance';
}
