/**
 * Numeric limits agreed for the sample (see README "Execution limits").
 * Local/CI overrides may only lower them, except the two admission counts named under `TEST_STACK_TENANT_LIMIT_CAPS`.
 * Azure accepts no override at all.
 */
export interface RunLimits {
  steps: number;
  toolCalls: number;
  modelCalls: number;
  tokens: number;
  costMicroUsd: number;
  retriesPerCall: number;
  retriesPerRun: number;
  activeMs: number;
}

export const BASE_RUN_LIMITS: Readonly<RunLimits> = Object.freeze({
  steps: 8,
  toolCalls: 12,
  modelCalls: 8,
  tokens: 30_000,
  costMicroUsd: 250_000,
  retriesPerCall: 2,
  retriesPerRun: 4,
  activeMs: 90_000,
});

export interface CaseLimits {
  /** Runs per case: the original plus at most three revisions. */
  maxRuns: number;
  /** Operator resume grants per run; each grant is capped by the base limits. */
  resumeGrantsPerRun: number;
}

export const CASE_LIMITS: Readonly<CaseLimits> = Object.freeze({ maxRuns: 4, resumeGrantsPerRun: 2 });

export interface TenantLimits {
  concurrentRuns: number;
  casesPerUtcDay: number;
  liveCostMicroUsdPerUtcDay: number;
}

export const BASE_TENANT_LIMITS: Readonly<TenantLimits> = Object.freeze({
  concurrentRuns: 3,
  casesPerUtcDay: 25,
  liveCostMicroUsdPerUtcDay: 2_000_000,
});

/**
 * Admission counts spend nothing, but a shared local or CI stack has only two tenants and one day of allowance, so
 * its test suites would exhaust them. These two counts, and no others, may be raised above the agreed values when
 * RESOLVE_ENV is local or ci, up to these caps. Run budgets and the live spending limit can only ever be lowered.
 */
export const TEST_STACK_TENANT_LIMIT_CAPS: Readonly<Partial<TenantLimits>> = Object.freeze({
  concurrentRuns: 100,
  casesPerUtcDay: 1_000,
});

/**
 * Bounds for one live-model request. The output cap is what a single call may spend on its answer (reasoning
 * included) and is reserved in full before the call; the timeout bounds how long a run waits on one call.
 */
export const LIVE_MODEL_LIMITS = Object.freeze({
  maxOutputTokens: Object.freeze({ default: 1_024, min: 64, max: 4_096 }),
  requestTimeoutMs: Object.freeze({ default: 30_000, min: 1_000, max: 60_000 }),
});

export interface OutboxLimits {
  maxAttempts: number;
  backoffMs: readonly number[];
  claimLeaseMs: number;
}

/** The claim lease must outlast the longest handler: the per-run active-time cap plus a margin. */
export const OUTBOX_LIMITS: Readonly<OutboxLimits> = Object.freeze({
  maxAttempts: 5,
  backoffMs: Object.freeze([1_000, 2_000, 4_000, 8_000]),
  claimLeaseMs: 120_000,
});

/**
 * How long a pending outbox item may stay overdue before the operator listing calls it recoverable.
 * It is far longer than the largest retry backoff, so an item that is merely waiting to be retried is never listed.
 */
export const RECOVERABLE_GRACE_MS = 300_000;

export const HTTP_LIMITS = Object.freeze({
  bodyBytes: 16 * 1024,
  descriptionChars: 4_000,
  defaultPageSize: 20,
  maxPageSize: 50,
  defaultTimelinePageSize: 50,
  maxTimelinePageSize: 100,
});

export const APPROVAL_TTL_SECONDS = Object.freeze({
  default: 72 * 3600,
  azureMin: 3600,
  localMin: 2,
  max: 168 * 3600,
});

/** Idempotency records live as long as their case; there is no separate expiry. */
export const IDEMPOTENCY_RETENTION = 'case-lifetime' as const;
