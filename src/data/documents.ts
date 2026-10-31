import type { components } from '../../contracts/generated/openapi.d.ts';

type Schemas = components['schemas'];

export type Account = Schemas['Account'];
export type Invoice = Schemas['Invoice'];
export type Policy = Schemas['Policy'];

/** Bump when a stored shape changes incompatibly; readers must tolerate older versions. */
export const SCHEMA_VERSION = 1 as const;

interface StoredFields {
  /** Cosmos DB item id; unique within the `tenantId` partition. */
  id: string;
  tenantId: string;
  schemaVersion: typeof SCHEMA_VERSION;
}

export type AccountDoc = StoredFields & { type: 'account' } & Account;
export type InvoiceDoc = StoredFields & { type: 'invoice'; sortKey: string } & Invoice;
/** Policy documents are immutable; `status` is derived at read time from `effectiveFrom`. */
export type PolicyDoc = StoredFields & { type: 'policy' } & Omit<Policy, 'status'>;

export type ReferenceDoc = AccountDoc | InvoiceDoc | PolicyDoc;
export const REFERENCE_DOC_TYPES = ['account', 'invoice', 'policy'] as const;

const POLICY_DOC_SUFFIX = /__v\d+$/;

/** Policy ids must not end in the version suffix, otherwise two policies could share a document id. */
export function isValidPolicyId(policyId: string): boolean {
  return !POLICY_DOC_SUFFIX.test(policyId);
}

export const policyDocId = (policyId: string, version: number): string => `${policyId}__v${version}`;

/** Sorts newest first when ordered descending; fixed-width UTC ISO timestamps compare lexically. */
export const invoiceSortKey = (issuedAt: string, invoiceId: string): string =>
  `${new Date(issuedAt).toISOString()}~${invoiceId}`;

export const INVOICE_SORT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~[a-z][a-z0-9_-]{2,63}$/;

export const buildAccountDoc = (tenantId: string, account: Account): AccountDoc => ({
  ...account,
  id: account.accountId,
  tenantId,
  type: 'account',
  schemaVersion: SCHEMA_VERSION,
});

export const buildInvoiceDoc = (tenantId: string, invoice: Invoice): InvoiceDoc => ({
  ...invoice,
  id: invoice.invoiceId,
  tenantId,
  type: 'invoice',
  schemaVersion: SCHEMA_VERSION,
  sortKey: invoiceSortKey(invoice.issuedAt, invoice.invoiceId),
});

export const buildPolicyDoc = (tenantId: string, policy: Omit<Policy, 'status'>): PolicyDoc => ({
  ...policy,
  id: policyDocId(policy.policyId, policy.version),
  tenantId,
  type: 'policy',
  schemaVersion: SCHEMA_VERSION,
});

export const toAccount = (doc: AccountDoc): Account => ({
  accountId: doc.accountId,
  displayName: doc.displayName,
  currency: doc.currency,
  status: doc.status,
  subscriptions: doc.subscriptions,
});

export const toInvoice = (doc: InvoiceDoc): Invoice => ({
  invoiceId: doc.invoiceId,
  accountId: doc.accountId,
  subscriptionId: doc.subscriptionId,
  number: doc.number,
  periodStart: doc.periodStart,
  periodEnd: doc.periodEnd,
  issuedAt: doc.issuedAt,
  status: doc.status,
  lines: doc.lines,
  total: doc.total,
  payments: doc.payments,
});

export const INVOICE_FIELDS = [
  'id',
  'tenantId',
  'type',
  'schemaVersion',
  'sortKey',
  'invoiceId',
  'accountId',
  'subscriptionId',
  'number',
  'periodStart',
  'periodEnd',
  'issuedAt',
  'status',
  'lines',
  'total',
  'payments',
] as const;
export const POLICY_FIELDS = ['id', 'tenantId', 'type', 'schemaVersion', 'policyId', 'version', 'effectiveFrom', 'currency', 'clauses'] as const;

/** Builds a `SELECT` projection from a closed list of field names defined in code. */
export const projection = (fields: readonly string[]): string => fields.map((field) => `c.${field}`).join(', ');
