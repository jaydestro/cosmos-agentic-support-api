import type { RoleName } from '../contract/load.ts';

export type { RoleName };

export interface Principal {
  readonly principalId: string;
  readonly tenantId: string;
  readonly roles: readonly RoleName[];
}

const ROLE_CLAIM = /^Resolve\.(Representative|Approver|Operator)\.([a-z][a-z0-9_-]{2,63})$/;
const ROLE_ORDER: readonly RoleName[] = ['Representative', 'Approver', 'Operator'];

export type TenantMapping =
  | { ok: true; tenantId: string; roles: RoleName[] }
  | { ok: false; reason: 'no_resolve_role' | 'tenant_ambiguous' | 'tenant_unknown' };

/**
 * Maps Entra app roles of the form `Resolve.<Role>.<tenant>` to exactly one application tenant.
 * A caller with roles in several tenants, or in an unknown tenant, is refused rather than guessed.
 */
export function mapRoles(rolesClaim: unknown, knownTenants: readonly string[]): TenantMapping {
  if (!Array.isArray(rolesClaim)) return { ok: false, reason: 'no_resolve_role' };
  const byTenant = new Map<string, Set<RoleName>>();
  for (const entry of rolesClaim) {
    if (typeof entry !== 'string') continue;
    const match = ROLE_CLAIM.exec(entry);
    if (!match) continue;
    const role = match[1] as RoleName;
    const tenant = match[2] as string;
    const roles = byTenant.get(tenant) ?? new Set<RoleName>();
    roles.add(role);
    byTenant.set(tenant, roles);
  }
  if (byTenant.size === 0) return { ok: false, reason: 'no_resolve_role' };
  if (byTenant.size > 1) return { ok: false, reason: 'tenant_ambiguous' };
  const [tenantId, roles] = [...byTenant.entries()][0] as [string, Set<RoleName>];
  if (!knownTenants.includes(tenantId)) return { ok: false, reason: 'tenant_unknown' };
  return { ok: true, tenantId, roles: ROLE_ORDER.filter((role) => roles.has(role)) };
}

export function hasAnyRole(principal: Principal, allowed: readonly RoleName[]): boolean {
  return principal.roles.some((role) => allowed.includes(role));
}
