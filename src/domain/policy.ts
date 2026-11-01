import type { Policy, PolicyDoc } from '../data/documents.ts';

type PolicyBody = Omit<Policy, 'status'>;

const toBody = (doc: PolicyDoc): PolicyBody => ({
  policyId: doc.policyId,
  version: doc.version,
  effectiveFrom: doc.effectiveFrom,
  currency: doc.currency,
  clauses: doc.clauses,
});

/**
 * Policy versions are immutable. A version is visible once `effectiveFrom` has passed; within a
 * policy id the highest visible version is `effective` and the others are `superseded`. Versions
 * that are not yet effective are not exposed. Sorted by policy id, then newest version first.
 */
export function derivePolicies(docs: readonly PolicyDoc[], now: Date): Policy[] {
  const visible = docs.filter((doc) => Date.parse(doc.effectiveFrom) <= now.getTime());
  const highest = new Map<string, number>();
  for (const doc of visible) {
    highest.set(doc.policyId, Math.max(highest.get(doc.policyId) ?? 0, doc.version));
  }
  return visible
    .map((doc): Policy => ({
      ...toBody(doc),
      status: highest.get(doc.policyId) === doc.version ? 'effective' : 'superseded',
    }))
    .sort((a, b) => (a.policyId === b.policyId ? b.version - a.version : a.policyId < b.policyId ? -1 : 1));
}

/** The version the agent must cite: the highest version that is effective at `now`. */
export function effectivePolicy(docs: readonly PolicyDoc[], now: Date, policyId?: string): Policy | null {
  const policies = derivePolicies(docs, now).filter(
    (policy) => policy.status === 'effective' && (policyId === undefined || policy.policyId === policyId),
  );
  return policies[0] ?? null;
}
