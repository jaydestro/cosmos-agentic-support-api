import { aurora } from './aurora.ts';
import { borealis } from './borealis.ts';
import type { TenantSeed } from './helpers.ts';

export type { TenantSeed } from './helpers.ts';

/** Fictional reference data for the two application tenants. Approvals and results are never seeded. */
export const SEED_TENANTS: readonly TenantSeed[] = [aurora, borealis];
