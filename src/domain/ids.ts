import { sha256Hex } from './canonical.ts';

export const ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;
export const CASE_ID_PATTERN = /^case_[0-9a-f]{32}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,64}$/;

/**
 * Case ids are derived from the idempotency scope (tenant, caller, key) so that the first write of a
 * case, its idempotency record, its first timeline item and its outbox work all land in one logical
 * partition and one transactional batch, and a replay is a point read.
 */
export function deriveCaseId(tenantId: string, principalId: string, idempotencyKey: string): string {
  return `case_${sha256Hex(`${tenantId}\n${principalId}\n${idempotencyKey}`).slice(0, 32)}`;
}

export function runIdFor(revision: number): string {
  return `run-${revision}`;
}

/** Sortable key used for keyset pagination: `<ISO timestamp>~<id>`. */
export function sortKeyOf(createdAtIso: string, id: string): string {
  return `${createdAtIso}~${id}`;
}

/**
 * Sort key of operator-visible work (a proposal, a run or an outbox item): `<ISO timestamp>~<caseId>~<document id>`.
 * It never changes after creation and is unique within a tenant, so it works as a keyset cursor on its own.
 */
export function workKeyOf(createdAtIso: string, caseId: string, docId: string): string {
  return `${createdAtIso}~${caseId}~${docId}`;
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
