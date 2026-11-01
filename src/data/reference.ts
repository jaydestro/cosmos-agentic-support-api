import type { Container } from '@azure/cosmos';
import { recordCharge } from '../telemetry/ru.ts';
import {
  INVOICE_FIELDS,
  POLICY_FIELDS,
  projection,
  type AccountDoc,
  type InvoiceDoc,
  type PolicyDoc,
  policyDocId,
} from './documents.ts';
import { isStatus } from './errors.ts';

export interface InvoicePageResult {
  items: InvoiceDoc[];
  /** Sort key of the last returned item when more remain, otherwise `null`. */
  nextAfter: string | null;
}

export interface ReferenceStore {
  getAccount(tenantId: string, accountId: string): Promise<AccountDoc | null>;
  getInvoice(tenantId: string, invoiceId: string): Promise<InvoiceDoc | null>;
  listInvoices(tenantId: string, accountId: string, limit: number, after: string | null): Promise<InvoicePageResult>;
  /** Every policy version of one tenant (bounded; policies are small and rarely written). */
  listPolicyDocs(tenantId: string): Promise<PolicyDoc[]>;
  listPolicyVersions(tenantId: string, policyId: string): Promise<PolicyDoc[]>;
  getPolicyDoc(tenantId: string, policyId: string, version: number): Promise<PolicyDoc | null>;
  /** Proves the database is reachable and the identity is authorized; throws otherwise. */
  ping(): Promise<void>;
}

/** Upper bound of stored policy versions per tenant; the seeder refuses data above it. */
export const MAX_POLICY_DOCS = 50;
const READINESS_PARTITION = '_system';
const READINESS_ID = 'readiness-probe';

async function pointRead<T extends { type: string }>(
  container: Container,
  id: string,
  partitionKey: string,
  type: T['type'],
): Promise<T | null> {
  try {
    const response = await container.item(id, partitionKey).read<T>();
    recordCharge(response.requestCharge);
    const resource = response.resource;
    // A mismatched type means the id belongs to a different kind of document.
    return resource !== undefined && resource.type === type ? resource : null;
  } catch (error) {
    if (isStatus(error, 404)) return null;
    throw error;
  }
}

async function queryAll<T>(
  container: Container,
  partitionKey: string,
  query: string,
  parameters: { name: string; value: string | number }[],
): Promise<T[]> {
  const iterator = container.items.query<T>({ query, parameters }, { partitionKey });
  const response = await iterator.fetchAll();
  recordCharge(response.requestCharge);
  return response.resources;
}

export function createReferenceStore(container: Container): ReferenceStore {
  return {
    getAccount: (tenantId, accountId) => pointRead<AccountDoc>(container, accountId, tenantId, 'account'),
    getInvoice: (tenantId, invoiceId) => pointRead<InvoiceDoc>(container, invoiceId, tenantId, 'invoice'),
    getPolicyDoc: (tenantId, policyId, version) =>
      pointRead<PolicyDoc>(container, policyDocId(policyId, version), tenantId, 'policy'),

    async listInvoices(tenantId, accountId, limit, after) {
      // One extra row tells whether another page exists without a second query.
      const rows = await queryAll<InvoiceDoc>(
        container,
        tenantId,
        `SELECT TOP @top ${projection(INVOICE_FIELDS)} FROM c
         WHERE c.tenantId = @tenantId AND c.type = 'invoice' AND c.accountId = @accountId
         ${after === null ? '' : 'AND c.sortKey < @after'}
         ORDER BY c.sortKey DESC`,
        [
          { name: '@top', value: limit + 1 },
          { name: '@tenantId', value: tenantId },
          { name: '@accountId', value: accountId },
          ...(after === null ? [] : [{ name: '@after', value: after }]),
        ],
      );
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return { items, nextAfter: rows.length > limit && last !== undefined ? last.sortKey : null };
    },

    listPolicyDocs: (tenantId) =>
      queryAll<PolicyDoc>(
        container,
        tenantId,
        `SELECT TOP @top ${projection(POLICY_FIELDS)} FROM c WHERE c.tenantId = @tenantId AND c.type = 'policy'`,
        [
          { name: '@top', value: MAX_POLICY_DOCS },
          { name: '@tenantId', value: tenantId },
        ],
      ),

    listPolicyVersions: (tenantId, policyId) =>
      queryAll<PolicyDoc>(
        container,
        tenantId,
        `SELECT TOP @top ${projection(POLICY_FIELDS)} FROM c
         WHERE c.tenantId = @tenantId AND c.type = 'policy' AND c.policyId = @policyId`,
        [
          { name: '@top', value: MAX_POLICY_DOCS },
          { name: '@tenantId', value: tenantId },
          { name: '@policyId', value: policyId },
        ],
      ),

    async ping() {
      // A 404 proves the account answered and the identity may read; 401/403/network errors throw.
      try {
        const response = await container.item(READINESS_ID, READINESS_PARTITION).read();
        recordCharge(response.requestCharge);
      } catch (error) {
        if (!isStatus(error, 404)) throw error;
      }
    },
  };
}
