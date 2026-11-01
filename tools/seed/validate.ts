import type { Contract } from '../../src/contract/load.ts';
import {
  buildAccountDoc,
  buildInvoiceDoc,
  buildPolicyDoc,
  isValidPolicyId,
  type ReferenceDoc,
} from '../../src/data/documents.ts';
import { MAX_POLICY_DOCS } from '../../src/data/reference.ts';
import type { TenantSeed } from './data/index.ts';

/** Hard ceiling so a mistaken fixture cannot turn a seed run into a bulk load. */
export const MAX_SEED_DOCUMENTS = 500;

const TENANT_ID = /^[a-z][a-z0-9_-]{2,63}$/;

export interface SeedProblem {
  where: string;
  message: string;
}

/** Stable order: tenants as listed, then accounts, invoices and policies as declared. */
export function buildSeedDocs(tenants: readonly TenantSeed[]): ReferenceDoc[] {
  return tenants.flatMap((tenant) => [
    ...tenant.accounts.map((account) => buildAccountDoc(tenant.tenantId, account)),
    ...tenant.invoices.map((invoice) => buildInvoiceDoc(tenant.tenantId, invoice)),
    ...tenant.policies.map((policy) => buildPolicyDoc(tenant.tenantId, policy)),
  ]);
}

/** Returns every problem found; an empty list means the data is safe to write. */
export function validateSeedData(
  tenants: readonly TenantSeed[],
  contract: Pick<Contract, 'validateComponent'>,
): SeedProblem[] {
  const problems: SeedProblem[] = [];
  const add = (where: string, message: string): void => {
    problems.push({ where, message });
  };
  const checkSchema = (where: string, schema: string, value: unknown): void => {
    for (const error of contract.validateComponent(schema, value)) add(where, `${schema}${error.pointer}: ${error.code}`);
  };

  const tenantIds = new Set<string>();
  const businessIds = new Map<string, string>();
  let documentCount = 0;

  for (const tenant of tenants) {
    const tenantWhere = `tenant ${tenant.tenantId}`;
    if (!TENANT_ID.test(tenant.tenantId)) add(tenantWhere, 'tenantId is not a valid identifier');
    if (tenantIds.has(tenant.tenantId)) add(tenantWhere, 'tenantId is listed twice');
    tenantIds.add(tenant.tenantId);

    const storedIds = new Set<string>();
    const claim = (where: string, id: string): void => {
      if (storedIds.has(id)) add(where, `document id ${id} is used twice in the tenant partition`);
      storedIds.add(id);
      documentCount += 1;
    };
    const claimBusinessId = (where: string, id: string): void => {
      const owner = businessIds.get(id);
      if (owner !== undefined) add(where, `${id} is also used by tenant ${owner}`);
      else businessIds.set(id, tenant.tenantId);
    };

    const accountsById = new Map(tenant.accounts.map((account) => [account.accountId, account]));

    for (const account of tenant.accounts) {
      const where = `${tenantWhere} account ${account.accountId}`;
      checkSchema(where, 'Account', account);
      claim(where, account.accountId);
      claimBusinessId(where, account.accountId);
      for (const subscription of account.subscriptions) {
        if (subscription.monthlyAmount.currency !== account.currency) add(where, `subscription ${subscription.subscriptionId} currency differs from the account`);
      }
    }

    for (const invoice of tenant.invoices) {
      const where = `${tenantWhere} invoice ${invoice.invoiceId}`;
      checkSchema(where, 'Invoice', invoice);
      claim(where, invoice.invoiceId);
      claimBusinessId(where, invoice.invoiceId);

      const account = accountsById.get(invoice.accountId);
      if (account === undefined) {
        add(where, `account ${invoice.accountId} is not seeded for this tenant`);
      } else {
        if (!account.subscriptions.some((subscription) => subscription.subscriptionId === invoice.subscriptionId)) {
          add(where, `subscription ${invoice.subscriptionId} does not belong to the account`);
        }
        if (invoice.total.currency !== account.currency) add(where, 'invoice currency differs from the account');
      }

      const lineTotal = invoice.lines.reduce((sum, line) => sum + line.amount.amountMinor, 0);
      if (lineTotal !== invoice.total.amountMinor) add(where, 'line amounts do not add up to the total');
      const currencies = [...invoice.lines.map((line) => line.amount.currency), ...invoice.payments.map((payment) => payment.amount.currency)];
      if (currencies.some((currency) => currency !== invoice.total.currency)) add(where, 'a line or payment uses a different currency');
      if (invoice.periodStart > invoice.periodEnd) add(where, 'periodStart is after periodEnd');
    }

    const policyKeys = new Set<string>();
    for (const policy of tenant.policies) {
      const where = `${tenantWhere} policy ${policy.policyId} v${String(policy.version)}`;
      checkSchema(where, 'Policy', { ...policy, status: 'effective' });
      if (!isValidPolicyId(policy.policyId)) add(where, 'policyId must not end with the version suffix');
      claim(where, `${policy.policyId}__v${String(policy.version)}`);
      const key = `${policy.policyId}@${String(policy.version)}`;
      if (policyKeys.has(key)) add(where, 'policy version is listed twice');
      policyKeys.add(key);

      const clauseIds = new Set<string>();
      const categories = new Set<string>();
      for (const clause of policy.clauses) {
        if (clauseIds.has(clause.clauseId)) add(where, `clause ${clause.clauseId} is listed twice`);
        clauseIds.add(clause.clauseId);
        if (categories.has(clause.appliesTo)) add(where, `more than one clause applies to ${clause.appliesTo}`);
        categories.add(clause.appliesTo);
      }
    }
    if (tenant.policies.length > MAX_POLICY_DOCS) add(tenantWhere, `more than ${String(MAX_POLICY_DOCS)} policy versions`);
  }

  if (documentCount > MAX_SEED_DOCUMENTS) add('seed data', `${String(documentCount)} documents exceed the limit of ${String(MAX_SEED_DOCUMENTS)}`);
  return problems;
}
