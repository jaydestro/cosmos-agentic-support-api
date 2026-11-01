import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FindingCode, InvoiceRef, Money, PolicyRef, ProposalKind } from '../cases/documents.ts';
import { toAccount, toInvoice, type Account, type Invoice, type InvoiceDoc, type Policy } from '../data/documents.ts';
import type { ReferenceStore } from '../data/reference.ts';
import { ID_PATTERN } from '../domain/ids.ts';
import { effectivePolicy } from '../domain/policy.ts';
import { clip } from '../domain/text.ts';
import type { Clock } from '../domain/time.ts';
import { MAX_INVOICE_REFS, type CaseFacts } from './adjudicate.ts';
import {
  MAX_NOTE_CHARS,
  guardSubmission,
  type AcceptedSubmission,
  type GuardCode,
  type Lookup,
  type Retrieved,
  type Submission,
} from './guard.ts';

/**
 * The only operations an investigator can perform. Everything is scoped by the session, never by
 * an argument: the tenant and the account come from the case, so no tool can read another tenant's
 * or another account's data whatever it is asked. A tool result may carry free text (line
 * descriptions, clause text); that text is data. Nothing here or in the guard ever reads it.
 */

export const TOOL_NAMES = ['get_account', 'list_invoices', 'get_invoice', 'get_policy', 'submit_proposal'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** `list_invoices` returns the newest invoices of the account and no further pages. */
export const MAX_LIST_INVOICES = 5;
/** Mirrors `Money.amountMinor` in the contract; a test compares the two. */
export const MAX_MONEY_MINOR = 10_000_000;

export type JsonSchema = Readonly<Record<string, unknown>>;

const FINDING_CODES: readonly FindingCode[] = ['missing_evidence', 'contradictory_evidence', 'no_credit_due', 'exceeds_policy_limit'];

// Control, format (bidirectional and zero-width), private-use, surrogate and line/paragraph-separator code
// points could make a note look like something it is not to the person approving; tab and newline are the
// only whitespace kept.
const NOTE_PATTERN = String.raw`^(?:[^\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]|[\t\n])*$`;

const ID_SCHEMA: JsonSchema = { type: 'string', pattern: ID_PATTERN.source };
const MONEY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['amountMinor', 'currency'],
  properties: {
    amountMinor: { type: 'integer', minimum: 0, maximum: MAX_MONEY_MINOR },
    currency: { type: 'string', enum: ['USD', 'EUR'] },
  },
};
const INVOICE_REF_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['invoiceId', 'lineIndex'],
  properties: {
    invoiceId: ID_SCHEMA,
    lineIndex: { type: ['integer', 'null'], minimum: 0, maximum: 9 },
  },
};
const POLICY_REF_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['policyId', 'version', 'clauseId'],
  properties: {
    policyId: ID_SCHEMA,
    version: { type: 'integer', minimum: 1, maximum: 999 },
    clauseId: ID_SCHEMA,
  },
};
const FINDING_CODE_SCHEMA: JsonSchema = { type: 'string', enum: [...FINDING_CODES] };

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
}

function frozen<T>(value: T): T {
  deepFreeze(value);
  return value;
}

/** The reusable parts, exported so a test can hold them against the same components in the contract. */
export const TOOL_SCHEMAS = frozen({
  id: ID_SCHEMA,
  money: MONEY_SCHEMA,
  invoiceRef: INVOICE_REF_SCHEMA,
  policyRef: POLICY_REF_SCHEMA,
  findingCode: FINDING_CODE_SCHEMA,
});

const closed = (properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: [...required],
});

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  /** A self-contained JSON Schema (draft 2020-12) with no references. */
  readonly parameters: JsonSchema;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = frozen([
  {
    name: 'get_account',
    description: 'Returns the billing account of this case: its currency and subscriptions. Takes no arguments.',
    parameters: closed({}),
  },
  {
    name: 'list_invoices',
    description: `Lists the newest invoices of the case account, newest first. Returns at most ${String(MAX_LIST_INVOICES)} and has no further pages; use get_invoice for a specific one.`,
    parameters: closed({ limit: { type: ['integer', 'null'], minimum: 1, maximum: MAX_LIST_INVOICES } }),
  },
  {
    name: 'get_invoice',
    description: 'Returns one invoice of the case account by id. An invoice that does not exist, or belongs to another account, is reported as not found.',
    parameters: closed({ invoiceId: ID_SCHEMA }, ['invoiceId']),
  },
  {
    name: 'get_policy',
    description:
      'Returns the credit policy version that is effective now, with the clauses and the most credit each clause allows. Omit policyId unless a specific policy is needed.',
    parameters: closed({ policyId: { type: ['string', 'null'], pattern: ID_PATTERN.source } }),
  },
  {
    name: 'submit_proposal',
    description:
      'Submits the outcome of the investigation, once: a credit or a finding. Code checks it against the evidence you retrieved and the policy, and refuses it with a reason when it does not fit. ' +
      'A credit takes effect only after a person approves it. Call get_account, get_policy and get_invoice for every invoice you cite first, and cite every invoice the outcome rests on. ' +
      'For a finding give findingCode and no amount. For a credit give amount and no findingCode.',
    parameters: closed(
      {
        kind: { type: 'string', enum: ['credit', 'finding'] },
        invoiceRefs: { type: 'array', maxItems: MAX_INVOICE_REFS, items: INVOICE_REF_SCHEMA },
        amount: { ...MONEY_SCHEMA, type: ['object', 'null'] },
        policyRef: { ...POLICY_REF_SCHEMA, type: ['object', 'null'] },
        findingCode: { type: ['string', 'null'], enum: [...FINDING_CODES, null] },
        note: { type: ['string', 'null'], maxLength: MAX_NOTE_CHARS, pattern: NOTE_PATTERN },
      },
      ['kind', 'invoiceRefs'],
    ),
  },
]);

export type ToolRejectionCode = 'unknown_tool' | 'invalid_arguments' | 'already_submitted' | GuardCode;

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

export interface ToolCall {
  /** The tool that ran. A name outside the allowlist is recorded as `unknown`, never as supplied. */
  tool: ToolName | 'unknown';
  /**
   * `rejected_by_code` is a call code refused: an unknown tool, bad arguments, a proposal the guard
   * turned down, or a call after a proposal was accepted. A lookup that finds nothing still `succeeded`.
   */
  outcome: 'succeeded' | 'rejected_by_code';
  /** What the usage trace records: the rejection code, or `null` when the call was not rejected. */
  errorCode: ToolRejectionCode | null;
  result: ToolResult;
  /** Set only on the call whose proposal the guard accepted. */
  submission: AcceptedSubmission | null;
}

export interface ToolSession {
  tenantId: string;
  accountId: string;
  facts: CaseFacts;
}

export interface ToolDeps {
  reference: ReferenceStore;
  clock: Clock;
}

export interface ToolBox {
  readonly definitions: readonly ToolDefinition[];
  /**
   * Runs one tool. Calls are served one at a time in arrival order. A dependency failure is thrown,
   * for the caller to classify and retry; every other outcome is returned.
   */
  call(name: string, args?: unknown): Promise<ToolCall>;
  /** What the investigation has retrieved so far, as a copy. */
  retrieved(): Retrieved;
}

interface SubmitArguments {
  kind: ProposalKind;
  invoiceRefs: InvoiceRef[];
  amount?: Money | null;
  policyRef?: PolicyRef | null;
  findingCode?: FindingCode | null;
  note?: string | null;
}

/** The arguments of a `submit_proposal` call that carry exactly the given submission. */
export function proposalArguments(submission: Submission): Record<string, unknown> {
  return {
    kind: submission.kind,
    invoiceRefs: submission.invoiceRefs,
    amount: submission.amount,
    policyRef: submission.policyRef,
    findingCode: submission.findingCode,
    note: submission.note,
  };
}

const TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

let validators: ReadonlyMap<ToolName, ValidateFunction> | null = null;

function validatorFor(name: ToolName): ValidateFunction {
  if (validators === null) {
    const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    validators = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, ajv.compile(tool.parameters)]));
  }
  const validate = validators.get(name);
  if (validate === undefined) throw new Error(`No validator for ${name}`);
  return validate;
}

const MAX_REPORTED_ERRORS = 5;
const MAX_ERROR_CHARS = 200;

// The only text taken from a model's arguments that reaches a message is the name of a property it was
// not allowed to send, reduced to printable ASCII.
const printable = (value: unknown): string => clip(typeof value === 'string' ? value.replace(/[^ -~]/g, '?') : '?', 40);

function describeError(error: ErrorObject): string {
  const at = error.instancePath === '' ? 'arguments' : error.instancePath;
  switch (error.keyword) {
    case 'additionalProperties':
      return `${at}: the property "${printable((error.params as { additionalProperty?: unknown }).additionalProperty)}" is not allowed`;
    case 'pattern':
      return error.instancePath.endsWith('/note')
        ? `${at}: may contain only printable text, tabs and newlines`
        : `${at}: must be a lowercase identifier of 3 to 64 characters, starting with a letter, then letters, digits, "_" or "-"`;
    case 'enum': {
      const allowed = (error.params as { allowedValues?: unknown }).allowedValues;
      return `${at}: must be one of ${Array.isArray(allowed) ? allowed.map(String).join(', ') : 'the allowed values'}`;
    }
    default:
      return `${at}: ${error.message ?? 'is invalid'}`;
  }
}

function describeErrors(errors: readonly ErrorObject[] | null | undefined): string {
  const lines = (errors ?? []).slice(0, MAX_REPORTED_ERRORS).map((error) => clip(describeError(error), MAX_ERROR_CHARS));
  return `The arguments are not valid. ${lines.length === 0 ? 'Check the tool definition.' : lines.join('; ')}.`;
}

const rejected = (tool: ToolCall['tool'], code: ToolRejectionCode, message: string): ToolCall => ({
  tool,
  outcome: 'rejected_by_code',
  errorCode: code,
  result: { ok: false, error: { code, message } },
  submission: null,
});

const notFound = (tool: ToolName, message: string): ToolCall => ({
  tool,
  outcome: 'succeeded',
  errorCode: null,
  result: { ok: false, error: { code: 'not_found', message } },
  submission: null,
});

const succeeded = (tool: ToolName, data: unknown, submission: AcceptedSubmission | null = null): ToolCall => ({
  tool,
  outcome: 'succeeded',
  errorCode: null,
  result: { ok: true, data: structuredClone(data) },
  submission,
});

export function createToolBox(deps: ToolDeps, session: ToolSession): ToolBox {
  const { reference, clock } = deps;
  const { tenantId, accountId, facts } = session;

  let account: Lookup<Account> = { status: 'pending' };
  let policy: Lookup<Policy> = { status: 'pending' };
  const invoices = new Map<string, Invoice>();
  const missing = new Set<string>();
  let submitted = false;

  const view = (): Retrieved => ({ account, policy, invoices: [...invoices.values()], notFound: [...missing] });
  const owned = (doc: InvoiceDoc): boolean => doc.accountId === accountId;
  const remember = (invoice: Invoice): void => {
    invoices.set(invoice.invoiceId, invoice);
    missing.delete(invoice.invoiceId);
  };

  async function getAccount(): Promise<ToolCall> {
    const doc = await reference.getAccount(tenantId, accountId);
    if (doc === null) {
      account = { status: 'absent' };
      return notFound('get_account', 'The case account was not found.');
    }
    const value = toAccount(doc);
    account = { status: 'present', value };
    return succeeded('get_account', value);
  }

  async function listInvoices(limit: number): Promise<ToolCall> {
    const page = await reference.listInvoices(tenantId, accountId, limit, null);
    const found = page.items.filter(owned).map(toInvoice);
    found.forEach(remember);
    return succeeded('list_invoices', { invoices: found, hasMore: page.nextAfter !== null });
  }

  async function getInvoice(invoiceId: string): Promise<ToolCall> {
    const doc = await reference.getInvoice(tenantId, invoiceId);
    // An invoice of another account is reported exactly as one that does not exist.
    if (doc === null || !owned(doc)) {
      invoices.delete(invoiceId);
      missing.add(invoiceId);
      return notFound('get_invoice', `Invoice ${invoiceId} was not found for this account.`);
    }
    const invoice = toInvoice(doc);
    remember(invoice);
    return succeeded('get_invoice', invoice);
  }

  async function getPolicy(policyId: string | undefined): Promise<ToolCall> {
    const found = effectivePolicy(await reference.listPolicyDocs(tenantId), clock.now(), policyId);
    if (found === null) {
      // Asking for a policy that does not exist must not cancel one already retrieved, or hide that none is effective.
      if (policyId === undefined) policy = { status: 'absent' };
      return notFound('get_policy', policyId === undefined ? 'No credit policy is effective.' : `Policy ${policyId} has no effective version.`);
    }
    policy = { status: 'present', value: found };
    return succeeded('get_policy', found);
  }

  function submitProposal(args: SubmitArguments): ToolCall {
    const result = guardSubmission(facts, view(), {
      kind: args.kind,
      amount: args.amount ?? null,
      note: args.note ?? null,
      invoiceRefs: args.invoiceRefs,
      policyRef: args.policyRef ?? null,
      findingCode: args.findingCode ?? null,
    });
    if (!result.ok) return rejected('submit_proposal', result.code, result.message);
    submitted = true;
    return succeeded('submit_proposal', { accepted: true, kind: result.accepted.kind }, result.accepted);
  }

  async function execute(name: string, args: unknown): Promise<ToolCall> {
    const tool = TOOLS_BY_NAME.get(name);
    if (submitted) {
      return rejected(tool?.name ?? 'unknown', 'already_submitted', 'A proposal was already accepted for this run; no further tool calls are possible.');
    }
    if (tool === undefined) {
      return rejected('unknown', 'unknown_tool', `Unknown tool. Use one of: ${TOOL_NAMES.join(', ')}.`);
    }
    const input = args ?? {};
    const validate = validatorFor(tool.name);
    if (!validate(input)) return rejected(tool.name, 'invalid_arguments', describeErrors(validate.errors));

    switch (tool.name) {
      case 'get_account':
        return getAccount();
      case 'list_invoices':
        return listInvoices((input as { limit?: number | null }).limit ?? MAX_LIST_INVOICES);
      case 'get_invoice':
        return getInvoice((input as { invoiceId: string }).invoiceId);
      case 'get_policy':
        return getPolicy((input as { policyId?: string | null }).policyId ?? undefined);
      case 'submit_proposal':
        return submitProposal(input as SubmitArguments);
    }
  }

  // One call at a time, so "a proposal was already accepted" is decided in arrival order.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    definitions: TOOL_DEFINITIONS,
    call(name, args) {
      const run = queue.then(() => execute(name, args));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    retrieved: () => structuredClone(view()),
  };
}
