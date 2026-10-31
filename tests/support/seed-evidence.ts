import assert from 'node:assert/strict';
import type { Retrieved } from '../../src/agent/guard.ts';
import type { Money } from '../../src/cases/documents.ts';
import { buildPolicyDoc, type Account, type Invoice, type Policy } from '../../src/data/documents.ts';
import { effectivePolicy } from '../../src/domain/policy.ts';
import { SEED_TENANTS, type TenantSeed } from '../../tools/seed/data/index.ts';

/** Only aurora policy v1 is visible at this time; v2 takes effect on 2026-06-01. */
export const WHEN_V1 = new Date('2026-03-01T10:00:00.000Z');
export const WHEN_V2 = new Date('2026-10-01T00:00:00.000Z');

export const usd = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });
export const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

export function tenantSeed(tenantId: string): TenantSeed {
  const seed = SEED_TENANTS.find((candidate) => candidate.tenantId === tenantId);
  assert.ok(seed, `unknown seed tenant ${tenantId}`);
  return seed;
}

export function accountOf(tenantId: string, accountId: string): Account {
  const account = tenantSeed(tenantId).accounts.find((candidate) => candidate.accountId === accountId);
  assert.ok(account, `unknown seed account ${accountId}`);
  return account;
}

export function invoicesOf(tenantId: string, accountId: string): Invoice[] {
  return tenantSeed(tenantId).invoices.filter((invoice) => invoice.accountId === accountId);
}

export function seededInvoice(tenantId: string, invoiceId: string): Invoice {
  const invoice = tenantSeed(tenantId).invoices.find((candidate) => candidate.invoiceId === invoiceId);
  assert.ok(invoice, `unknown seed invoice ${invoiceId}`);
  return invoice;
}

export function policyAt(tenantId: string, when: Date = WHEN_V2, policyId?: string): Policy {
  const policy = effectivePolicy(
    tenantSeed(tenantId).policies.map((candidate) => buildPolicyDoc(tenantId, candidate)),
    when,
    policyId,
  );
  assert.ok(policy, 'no effective policy');
  return policy;
}

/**
 * What an investigation holds after it looked up each cited invoice: the ones the account owns are
 * retrieved and the rest are recorded as not found, exactly as `get_invoice` does.
 */
export function retrievedFor(tenantId: string, accountId: string, citedIds: readonly string[], when: Date = WHEN_V2): Retrieved {
  const owned = invoicesOf(tenantId, accountId);
  return {
    account: { status: 'present', value: accountOf(tenantId, accountId) },
    policy: { status: 'present', value: policyAt(tenantId, when) },
    invoices: owned.filter((invoice) => citedIds.includes(invoice.invoiceId)),
    notFound: citedIds.filter((id) => !owned.some((invoice) => invoice.invoiceId === id)),
  };
}

/** Free text a hostile record could carry. None of it may ever reach a sentence code derives. */
export const SEEDED_FREE_TEXT: readonly string[] = [
  ...SEED_TENANTS.flatMap((seed) => seed.invoices.flatMap((invoice) => invoice.lines.map((line) => line.description))),
  ...SEED_TENANTS.flatMap((seed) => seed.policies.flatMap((policy) => policy.clauses.map((clause) => clause.text))),
];
