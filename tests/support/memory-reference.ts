import {
  buildAccountDoc,
  buildInvoiceDoc,
  buildPolicyDoc,
  policyDocId,
  type AccountDoc,
  type InvoiceDoc,
  type PolicyDoc,
} from '../../src/data/documents.ts';
import type { ReferenceStore } from '../../src/data/reference.ts';
import type { TenantSeed } from '../../tools/seed/data/helpers.ts';

export interface ReferenceCall {
  method: Exclude<keyof ReferenceStore, 'ping'>;
  tenantId: string;
}

export interface MemoryReference {
  store: ReferenceStore;
  /** Every tenant-scoped read, in order, so a test can prove which partition was used. */
  calls: ReferenceCall[];
  /** Makes the next probes fail with this error; `null` restores them. */
  failPing(error: Error | null): void;
}

interface Partition {
  accounts: Map<string, AccountDoc>;
  invoices: Map<string, InvoiceDoc>;
  policies: PolicyDoc[];
}

const descendingBySortKey = (a: InvoiceDoc, b: InvoiceDoc): number => {
  if (a.sortKey === b.sortKey) return 0;
  return a.sortKey < b.sortKey ? 1 : -1;
};

/** Mirrors the queries of the Cosmos DB reference store: one partition per tenant, newest invoice first. */
export function createMemoryReference(tenants: readonly TenantSeed[]): MemoryReference {
  const partitions = new Map<string, Partition>();
  for (const tenant of tenants) {
    partitions.set(tenant.tenantId, {
      accounts: new Map(tenant.accounts.map((account) => [account.accountId, buildAccountDoc(tenant.tenantId, account)])),
      invoices: new Map(tenant.invoices.map((invoice) => [invoice.invoiceId, buildInvoiceDoc(tenant.tenantId, invoice)])),
      policies: tenant.policies.map((policy) => buildPolicyDoc(tenant.tenantId, policy)),
    });
  }

  const calls: ReferenceCall[] = [];
  let pingFailure: Error | null = null;
  const read = (method: ReferenceCall['method'], tenantId: string): Partition | undefined => {
    calls.push({ method, tenantId });
    return partitions.get(tenantId);
  };

  const store: ReferenceStore = {
    getAccount: (tenantId, accountId) => Promise.resolve(structuredClone(read('getAccount', tenantId)?.accounts.get(accountId) ?? null)),
    getInvoice: (tenantId, invoiceId) => Promise.resolve(structuredClone(read('getInvoice', tenantId)?.invoices.get(invoiceId) ?? null)),
    getPolicyDoc: (tenantId, policyId, version) =>
      Promise.resolve(
        structuredClone(read('getPolicyDoc', tenantId)?.policies.find((doc) => doc.id === policyDocId(policyId, version)) ?? null),
      ),

    listInvoices(tenantId, accountId, limit, after) {
      const rows = [...(read('listInvoices', tenantId)?.invoices.values() ?? [])]
        .filter((doc) => doc.accountId === accountId && (after === null || doc.sortKey < after))
        .sort(descendingBySortKey)
        .slice(0, limit + 1);
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return Promise.resolve(structuredClone({ items, nextAfter: rows.length > limit && last !== undefined ? last.sortKey : null }));
    },

    listPolicyDocs: (tenantId) => Promise.resolve(structuredClone(read('listPolicyDocs', tenantId)?.policies ?? [])),
    listPolicyVersions: (tenantId, policyId) =>
      Promise.resolve(structuredClone((read('listPolicyVersions', tenantId)?.policies ?? []).filter((doc) => doc.policyId === policyId))),

    ping: () => (pingFailure === null ? Promise.resolve() : Promise.reject(pingFailure)),
  };

  return {
    store,
    calls,
    failPing(error) {
      pingFailure = error;
    },
  };
}
