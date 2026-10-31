import type { Role } from './types.ts';

export type TenantId = 'aurora' | 'borealis';

/** A fictional person for the local/CI test identity provider. The ids are fixed so repeated sign-ins are the same person. */
export interface Persona {
  readonly id: string;
  readonly label: string;
  readonly tenantId: TenantId;
  readonly roles: readonly Role[];
  readonly oid: string;
  readonly purpose: string;
}

export const PERSONAS: readonly Persona[] = Object.freeze([
  {
    id: 'aurora-representative',
    label: 'Aurora support representative',
    tenantId: 'aurora',
    roles: ['Representative'],
    oid: 'a1000000-0000-4000-8000-0000000000a1',
    purpose: 'Submits and follows disputes for the Aurora tenant.',
  },
  {
    id: 'aurora-approver',
    label: 'Aurora approver',
    tenantId: 'aurora',
    roles: ['Approver'],
    oid: 'a2000000-0000-4000-8000-0000000000a2',
    purpose: 'Approves or rejects proposed credits. A different person from the representative who submitted the case.',
  },
  {
    id: 'aurora-both',
    label: 'Aurora representative and approver (one person)',
    tenantId: 'aurora',
    roles: ['Representative', 'Approver'],
    oid: 'a3000000-0000-4000-8000-0000000000a3',
    purpose: 'Holds both roles to show that nobody can approve a case they submitted.',
  },
  {
    id: 'aurora-operator',
    label: 'Aurora operator',
    tenantId: 'aurora',
    roles: ['Operator'],
    oid: 'a4000000-0000-4000-8000-0000000000a4',
    purpose: 'Inspects and recovers waiting, failed, poison and budget-exhausted work.',
  },
  {
    id: 'borealis-representative',
    label: 'Borealis support representative',
    tenantId: 'borealis',
    roles: ['Representative'],
    oid: 'b1000000-0000-4000-8000-0000000000b1',
    purpose: 'Shows that another tenant sees none of the Aurora cases.',
  },
  {
    id: 'borealis-approver',
    label: 'Borealis approver',
    tenantId: 'borealis',
    roles: ['Approver'],
    oid: 'b2000000-0000-4000-8000-0000000000b2',
    purpose: 'Approves or rejects credits for the Borealis tenant only.',
  },
]);

export const findPersona = (id: string | null): Persona | undefined => (id === null ? undefined : PERSONAS.find((persona) => persona.id === id));

/** The account suggestions for a tenant; any other tenant id has none. */
export function hintsFor(tenantId: string): readonly AccountHint[] {
  return tenantId === 'aurora' || tenantId === 'borealis' ? ACCOUNT_HINTS[tenantId] : [];
}

/** The role claim format the API reads: one entry per role and tenant. */
export const roleClaims = (persona: Persona): string[] => persona.roles.map((role) => `Resolve.${role}.${persona.tenantId}`);

export interface AccountHint {
  readonly accountId: string;
  readonly name: string;
  readonly scenario: string;
}

/**
 * The fictional accounts the seeder creates. The API has no account listing, so the form offers these as
 * suggestions; a unit test compares them with the seed data so they cannot drift.
 */
export const ACCOUNT_HINTS: Readonly<Record<TenantId, readonly AccountHint[]>> = Object.freeze({
  aurora: [
    { accountId: 'acct_aurora_0001', name: 'Kestrel Freight (fictional)', scenario: 'A duplicate September charge: a credit is proposed.' },
    { accountId: 'acct_aurora_0002', name: 'Marlow Dental Group (fictional)', scenario: 'An ordinary account with a September outage.' },
    { accountId: 'acct_aurora_0003', name: 'Tidewater Labs (fictional)', scenario: 'Evidence is missing: a finding, not a credit.' },
    { accountId: 'acct_aurora_0004', name: 'Juniper Studio (fictional)', scenario: 'Contradictory records: a finding, not a credit.' },
    { accountId: 'acct_aurora_0005', name: 'Halcyon Foods (fictional)', scenario: 'A duplicate above the policy limit: code reduces the credit.' },
    { accountId: 'acct_aurora_0006', name: 'Ember Analytics (fictional)', scenario: 'A long invoice history, for paging.' },
    { accountId: 'acct_aurora_0007', name: 'Quill and Anvil Press (fictional)', scenario: 'An invoice line that tries to instruct the agent; it stays data.' },
  ],
  borealis: [
    { accountId: 'acct_borealis_0001', name: 'Fjord Robotics (fictional)', scenario: 'A duplicate September charge in EUR.' },
    { accountId: 'acct_borealis_0002', name: 'Lumen Textiles (fictional)', scenario: 'An ordinary account.' },
    { accountId: 'acct_borealis_0003', name: 'Nordlys Bakery (fictional)', scenario: 'Evidence is missing: a finding, not a credit.' },
    { accountId: 'acct_borealis_0004', name: 'Skerry Marine (fictional)', scenario: 'Contradictory records: a finding, not a credit.' },
  ],
});
