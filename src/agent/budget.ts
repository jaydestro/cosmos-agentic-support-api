import { usageDocId, type RunDoc, type UsageEventDoc, type UsageQuality, type UsageSummary } from '../cases/documents.ts';
import { SCHEMA_VERSION } from '../data/documents.ts';

/**
 * Run budgets: pure functions over a run document. Nothing here reads a clock or a store, so every rule
 * is testable on its own and the runner only has to persist what these functions return.
 *
 * The rules this module enforces:
 *  - An allowance is reserved before a call, so a crash can never lose track of work that may have
 *    happened. Settling moves the reservation into `charged`.
 *  - A call that failed, or whose outcome is not known, is charged at its reservation. Unknown is not zero.
 *  - Usage may exceed a limit by the last call's overshoot (a soft limit). The overshoot is recorded in
 *    `charged`, and the next reservation fails.
 *  - Counters are only ever added to. A recovered run keeps them; only an authorized, recorded allowance
 *    (a larger `limits`) lets a stopped run continue.
 */

export const EXHAUSTION_REASONS = [
  'active_time_exhausted',
  'steps_exhausted',
  'tool_calls_exhausted',
  'model_calls_exhausted',
  'retries_per_call_exhausted',
  'retries_exhausted',
  'tokens_exhausted',
  'cost_exhausted',
] as const;
export type ExhaustionReason = (typeof EXHAUSTION_REASONS)[number];

/** An amount of the two metered resources. */
export interface Spend {
  tokens: number;
  costMicroUsd: number;
}

export interface CallRequest {
  kind: UsageEventDoc['kind'];
  /** The tool or model name; recorded on the usage event. */
  name: string;
  /** 1 for the first attempt at a call; each retry of the same call counts one more. */
  attempt: number;
  /** Whether this call begins a new agent turn, which is what a step counts. A retry never does. */
  startsTurn: boolean;
  /** The most the call may use. Zero for calls that use no model. */
  estimate: Spend;
  now: Date;
}

export type ReserveResult = { ok: true; run: RunDoc; event: UsageEventDoc } | { ok: false; reason: ExhaustionReason };

/** What a call reports it used. Fields are `null` when the call did not report them. */
export interface CallUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  tokenQuality: UsageQuality;
  costMicroUsd: number | null;
  costQuality: UsageQuality;
}

export interface Settlement {
  outcome: Exclude<UsageEventDoc['outcome'], 'reserved'>;
  errorCode: string | null;
  latencyMs: number | null;
  /** `null` when nothing was reported: a call that uses no model, or one whose usage is not known. */
  usage: CallUsage | null;
  now: Date;
}

export interface SettleResult {
  run: RunDoc;
  event: UsageEventDoc;
  /** How far `charged` is past the limits now, so a caller can record that the soft limit was passed. */
  overshoot: Spend;
}

const MAX_NAME_CHARS = 80;

function assertRequest(request: CallRequest): void {
  if (!Number.isSafeInteger(request.attempt) || request.attempt < 1) {
    throw new RangeError('attempt must be a positive integer');
  }
  if (request.startsTurn && request.attempt > 1) throw new RangeError('a retry does not start an agent turn');
  if (request.name.length < 1 || request.name.length > MAX_NAME_CHARS) {
    throw new RangeError(`a call name must be 1 to ${String(MAX_NAME_CHARS)} characters`);
  }
  const { tokens, costMicroUsd } = request.estimate;
  if (!isCount(tokens) || !isCount(costMicroUsd)) throw new RangeError('an estimate must be a non-negative integer');
}

function isCount(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The first limit the next call would pass, or `null`. Settled usage, outstanding reservations and the
 * new estimate are all counted, so concurrent reservations cannot together pass a limit.
 */
export function exhaustion(run: RunDoc, request: Pick<CallRequest, 'kind' | 'attempt' | 'startsTurn' | 'estimate'>): ExhaustionReason | null {
  const { limits, usage } = run;
  if (usage.activeMs >= limits.activeMs) return 'active_time_exhausted';
  if (request.startsTurn && usage.steps + 1 > limits.steps) return 'steps_exhausted';
  if (request.kind === 'tool' && usage.toolCalls + 1 > limits.toolCalls) return 'tool_calls_exhausted';
  if (request.kind === 'model' && usage.modelCalls + 1 > limits.modelCalls) return 'model_calls_exhausted';
  if (request.attempt > 1) {
    if (request.attempt - 1 > limits.retriesPerCall) return 'retries_per_call_exhausted';
    if (usage.retries + 1 > limits.retriesPerRun) return 'retries_exhausted';
  }
  if (run.charged.tokens + run.reserved.tokens + request.estimate.tokens > limits.tokens) return 'tokens_exhausted';
  if (run.charged.costMicroUsd + run.reserved.costMicroUsd + request.estimate.costMicroUsd > limits.costMicroUsd) {
    return 'cost_exhausted';
  }
  return null;
}

/**
 * Reserves the allowance for one call. On success the returned run and event must be written together
 * (the event create-only, the run with its ETag) before the call is made; on failure nothing changes
 * and the reason is the run's stop reason.
 */
export function reserve(run: RunDoc, request: CallRequest): ReserveResult {
  assertRequest(request);
  const reason = exhaustion(run, request);
  if (reason !== null) return { ok: false, reason };

  const seq = run.nextEventSeq;
  const at = request.now.toISOString();
  const metered = request.estimate.tokens > 0 || request.estimate.costMicroUsd > 0;
  const quality: UsageQuality = metered ? 'unknown' : 'not_applicable';
  const id = usageDocId(run.runId, seq);
  const event: UsageEventDoc = {
    id,
    tenantId: run.tenantId,
    caseId: run.caseId,
    type: 'usage',
    schemaVersion: SCHEMA_VERSION,
    eventId: id,
    runId: run.runId,
    seq,
    kind: request.kind,
    name: request.name,
    outcome: 'reserved',
    attempt: request.attempt,
    at,
    inputTokens: null,
    outputTokens: null,
    tokenQuality: quality,
    costMicroUsd: null,
    costQuality: quality,
    latencyMs: null,
    errorCode: null,
    reservedTokens: request.estimate.tokens,
    reservedCostMicroUsd: request.estimate.costMicroUsd,
  };
  return {
    ok: true,
    event,
    run: {
      ...run,
      updatedAt: at,
      nextEventSeq: seq + 1,
      usage: {
        ...run.usage,
        steps: run.usage.steps + (request.startsTurn ? 1 : 0),
        toolCalls: run.usage.toolCalls + (request.kind === 'tool' ? 1 : 0),
        modelCalls: run.usage.modelCalls + (request.kind === 'model' ? 1 : 0),
        retries: run.usage.retries + (request.attempt > 1 ? 1 : 0),
      },
      reserved: {
        tokens: run.reserved.tokens + request.estimate.tokens,
        costMicroUsd: run.reserved.costMicroUsd + request.estimate.costMicroUsd,
      },
    },
  };
}

const QUALITY_RANK: Record<UsageQuality, number> = { not_applicable: 0, measured: 1, estimated: 2, unknown: 3 };

/** The aggregate is as uncertain as its least certain call; a call that uses nothing does not change it. */
function combine(aggregate: UsageQuality, call: UsageQuality): UsageQuality {
  if (call === 'not_applicable') return aggregate;
  if (aggregate === 'not_applicable') return call;
  return QUALITY_RANK[call] > QUALITY_RANK[aggregate] ? call : aggregate;
}

const isKnown = (quality: UsageQuality): boolean => quality === 'measured' || quality === 'estimated';

interface Metered {
  charge: number;
  first: number | null;
  second: number | null;
  quality: UsageQuality;
}

/** Charges what the call reported when that is a known amount, and its whole reservation otherwise. */
function chargeTokens(reservation: number, usage: CallUsage | null): Metered {
  const input = usage === null ? null : usage.inputTokens;
  const output = usage === null ? null : usage.outputTokens;
  if (usage !== null && isKnown(usage.tokenQuality) && isCount(input) && isCount(output)) {
    return { charge: input + output, first: input, second: output, quality: usage.tokenQuality };
  }
  const reported = usage !== null && usage.tokenQuality !== 'not_applicable';
  return {
    charge: reservation,
    first: isCount(input) ? input : null,
    second: isCount(output) ? output : null,
    quality: reservation > 0 || reported ? 'unknown' : 'not_applicable',
  };
}

function chargeCost(reservation: number, usage: CallUsage | null): Metered {
  const cost = usage === null ? null : usage.costMicroUsd;
  if (usage !== null && isKnown(usage.costQuality) && isCount(cost)) {
    return { charge: cost, first: cost, second: null, quality: usage.costQuality };
  }
  const reported = usage !== null && usage.costQuality !== 'not_applicable';
  return {
    charge: reservation,
    first: isCount(cost) ? cost : null,
    second: null,
    quality: reservation > 0 || reported ? 'unknown' : 'not_applicable',
  };
}

const add = (total: number | null, part: number | null): number | null => (part === null ? total : (total ?? 0) + part);

/**
 * Moves a reservation into `charged` once the call has finished or is known to be lost. The outcome
 * decides which counter moves: `failed` and `ambiguous` are counted separately, and a call refused by
 * code (`rejected_by_code`) is an ordinary call that used a step.
 */
export function settle(run: RunDoc, event: UsageEventDoc, settlement: Settlement): SettleResult {
  if (event.outcome !== 'reserved') throw new RangeError(`usage event ${event.eventId} is already settled`);
  if (event.runId !== run.runId || event.caseId !== run.caseId || event.tenantId !== run.tenantId) {
    throw new RangeError(`usage event ${event.eventId} belongs to another run`);
  }

  const tokens = chargeTokens(event.reservedTokens, settlement.usage);
  const cost = chargeCost(event.reservedCostMicroUsd, settlement.usage);
  const usage: UsageSummary = {
    ...run.usage,
    failedCalls: run.usage.failedCalls + (settlement.outcome === 'failed' ? 1 : 0),
    ambiguousCalls: run.usage.ambiguousCalls + (settlement.outcome === 'ambiguous' ? 1 : 0),
    inputTokens: add(run.usage.inputTokens, tokens.first),
    outputTokens: add(run.usage.outputTokens, tokens.second),
    tokenQuality: combine(run.usage.tokenQuality, tokens.quality),
    costMicroUsd: add(run.usage.costMicroUsd, cost.first),
    costQuality: combine(run.usage.costQuality, cost.quality),
  };
  const settledRun: RunDoc = {
    ...run,
    usage,
    updatedAt: settlement.now.toISOString(),
    charged: { tokens: run.charged.tokens + tokens.charge, costMicroUsd: run.charged.costMicroUsd + cost.charge },
    reserved: {
      tokens: Math.max(0, run.reserved.tokens - event.reservedTokens),
      costMicroUsd: Math.max(0, run.reserved.costMicroUsd - event.reservedCostMicroUsd),
    },
  };
  const settledEvent: UsageEventDoc = {
    ...event,
    outcome: settlement.outcome,
    errorCode: settlement.errorCode,
    latencyMs: settlement.latencyMs,
    inputTokens: tokens.first,
    outputTokens: tokens.second,
    tokenQuality: tokens.quality,
    costMicroUsd: cost.first,
    costQuality: cost.quality,
  };
  return { run: settledRun, event: settledEvent, overshoot: overshootOf(settledRun) };
}

/**
 * Settles calls that were reserved by an earlier attempt of the handler and never finished, as
 * `ambiguous`: they may or may not have happened, so each is charged at its reservation.
 */
export function interrupt(run: RunDoc, events: readonly UsageEventDoc[], now: Date): { run: RunDoc; events: UsageEventDoc[] } {
  let current = run;
  const settled = events.map((event) => {
    const result = settle(current, event, { outcome: 'ambiguous', errorCode: 'interrupted', latencyMs: null, usage: null, now });
    current = result.run;
    return result.event;
  });
  return { run: current, events: settled };
}

/** Adds time the handler spent working. Time spent waiting for a person is never added. */
export function addActive(run: RunDoc, elapsedMs: number): RunDoc {
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.round(elapsedMs) : 0;
  return ms === 0 ? run : { ...run, usage: { ...run.usage, activeMs: run.usage.activeMs + ms } };
}

export function overshootOf(run: Pick<RunDoc, 'charged' | 'limits'>): Spend {
  return {
    tokens: Math.max(0, run.charged.tokens - run.limits.tokens),
    costMicroUsd: Math.max(0, run.charged.costMicroUsd - run.limits.costMicroUsd),
  };
}
