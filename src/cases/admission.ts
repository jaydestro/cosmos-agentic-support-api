import type { TenantLimits } from '../config/limits.ts';
import { SCHEMA_VERSION } from '../data/documents.ts';
import { utcDay } from '../domain/ids.ts';
import { addMs, type Clock } from '../domain/time.ts';
import { ADMISSION_DOC_ID, TENANT_PARTITION, type AdmissionDoc, type AdmissionSlot } from './documents.ts';
import { CaseWriteError, type CaseOp, type CaseStore } from './store.ts';

/**
 * How long a run may hold a concurrency slot without renewing it. The longest handler runs two
 * minutes (the outbox claim lease) and a failed handler is retried within about fifteen seconds, so
 * ten minutes covers several retry rounds and a cold start. A crash therefore blocks at most one
 * slot for ten minutes, after which the slot frees itself; there is no sweeper to pay for.
 */
export const SLOT_LEASE_MS = 10 * 60 * 1000;

const CONCURRENCY_RETRY_AFTER_SECONDS = 5;
const BUSY_RETRY_AFTER_SECONDS = 1;
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 5;

export type RejectionReason = 'tenant_daily_case_limit' | 'tenant_concurrency_limit' | 'tenant_admission_busy';

export type Admission = { ok: true } | { ok: false; reason: RejectionReason; retryAfterSeconds: number };

export type LiveCostRefusal = 'tenant_live_cost_limit' | 'tenant_admission_busy';

/** `day` is the UTC day whose counter holds the reservation; settling it later is a no-op once that day has passed. */
export type LiveCostReservation = { ok: true; day: string } | { ok: false; reason: LiveCostRefusal; retryAfterSeconds: number };

export interface AdmissionControl {
  /**
   * Takes a concurrency slot for `runKey` (`<caseId>:<runId>`) and, for a new case, counts it against
   * the daily allowance. Asking again for a key that already holds a slot succeeds without counting twice.
   */
  admit(tenantId: string, runKey: string, kind: 'new_case' | 'run'): Promise<Admission>;
  /**
   * Adds or renews the slot without a capacity check: work that was already accepted must be able to
   * start. After an outage this can briefly exceed the limit. Returns `false` when contention
   * prevented the write; the run continues and the slot simply is not counted.
   */
  hold(tenantId: string, runKey: string): Promise<boolean>;
  /**
   * Frees the slot. With `refundCase` the daily allowance is returned as well, which is only right
   * when the case was provably not created. Best effort: an expired lease frees the slot anyway.
   */
  release(tenantId: string, runKey: string, options?: { refundCase?: boolean }): Promise<void>;
  /**
   * Adds the estimated cost of one model call to the tenant's live spend for today, only when the
   * total stays within the daily limit. Taken before the call so concurrent runs cannot all pass
   * the same check. A refusal is `tenant_live_cost_limit` (the allowance returns with the next UTC
   * day) or `tenant_admission_busy` (contention; the caller may retry shortly).
   */
  reserveLiveCost(tenantId: string, estimateMicroUsd: number): Promise<LiveCostReservation>;
  /**
   * Replaces a reservation by what the call was charged: the difference is applied to the counter
   * of the day the reservation was taken on, and a charge above the reservation is recorded in full
   * (the limit is soft). Returns `false` when nothing was changed, either because that day has
   * passed or because contention won; the counter then keeps the reservation, which errs high.
   */
  settleLiveCost(tenantId: string, day: string, reservedMicroUsd: number, chargedMicroUsd: number): Promise<boolean>;
}

export interface AdmissionDeps {
  store: CaseStore;
  limits: Pick<TenantLimits, 'concurrentRuns' | 'casesPerUtcDay' | 'liveCostMicroUsdPerUtcDay'>;
  clock: Clock;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

type Outcome<T> = { write: AdmissionDoc; result: T } | { write?: undefined; result: T };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function emptyDoc(tenantId: string, now: Date): AdmissionDoc {
  return {
    id: ADMISSION_DOC_ID,
    tenantId,
    caseId: TENANT_PARTITION,
    type: 'admission',
    schemaVersion: SCHEMA_VERSION,
    day: utcDay(now),
    casesToday: 0,
    liveCostMicroUsdToday: 0,
    slots: [],
    updatedAt: now.toISOString(),
  };
}

/** Drops expired slots and starts new counters on a new UTC day. */
function normalize(doc: AdmissionDoc, now: Date): AdmissionDoc {
  const slots = doc.slots.filter((slot) => Date.parse(slot.until) > now.getTime());
  const day = utcDay(now);
  return day === doc.day ? { ...doc, slots } : { ...doc, day, casesToday: 0, liveCostMicroUsdToday: 0, slots };
}

function secondsUntilNextUtcDay(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

function assertMicroUsd(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('A live cost must be a whole, non-negative number of micro-USD.');
}

export function createAdmissionControl(deps: AdmissionDeps): AdmissionControl {
  const { store, limits, clock } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;

  /**
   * Read, decide, write with the ETag. A competing writer makes the write fail, and the decision is
   * remade from fresh state. The loop is bounded; `settled: false` means contention won.
   */
  async function mutate<T>(
    tenantId: string,
    decide: (doc: AdmissionDoc, now: Date) => Outcome<T>,
  ): Promise<{ settled: true; result: T } | { settled: false }> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const now = clock.now();
      const current = await store.get('admission', tenantId, TENANT_PARTITION, ADMISSION_DOC_ID);
      const outcome = decide(normalize(current?.doc ?? emptyDoc(tenantId, now), now), now);
      if (outcome.write === undefined) return { settled: true, result: outcome.result };
      const op: CaseOp =
        current === null ? { op: 'create', doc: outcome.write } : { op: 'replace', doc: outcome.write, etag: current.etag };
      try {
        await store.commit(tenantId, TENANT_PARTITION, [op]);
        return { settled: true, result: outcome.result };
      } catch (error) {
        if (!(error instanceof CaseWriteError)) throw error;
      }
      if (attempt < MAX_ATTEMPTS - 1) await sleep(BACKOFF_BASE_MS * 2 ** attempt + Math.floor(random() * BACKOFF_BASE_MS));
    }
    return { settled: false };
  }

  const slotFor = (runKey: string, since: Date): AdmissionSlot => ({
    runKey,
    since: since.toISOString(),
    until: addMs(since, SLOT_LEASE_MS).toISOString(),
  });

  return {
    async admit(tenantId, runKey, kind) {
      const outcome = await mutate<Admission>(tenantId, (doc, now) => {
        if (doc.slots.some((slot) => slot.runKey === runKey)) return { result: { ok: true } };
        if (kind === 'new_case' && doc.casesToday >= limits.casesPerUtcDay) {
          return {
            result: { ok: false, reason: 'tenant_daily_case_limit', retryAfterSeconds: secondsUntilNextUtcDay(now) },
          };
        }
        if (doc.slots.length >= limits.concurrentRuns) {
          return {
            result: { ok: false, reason: 'tenant_concurrency_limit', retryAfterSeconds: CONCURRENCY_RETRY_AFTER_SECONDS },
          };
        }
        return {
          write: {
            ...doc,
            casesToday: doc.casesToday + (kind === 'new_case' ? 1 : 0),
            slots: [...doc.slots, slotFor(runKey, now)],
            updatedAt: now.toISOString(),
          },
          result: { ok: true },
        };
      });
      return outcome.settled
        ? outcome.result
        : { ok: false, reason: 'tenant_admission_busy', retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS };
    },

    async hold(tenantId, runKey) {
      const outcome = await mutate<true>(tenantId, (doc, now) => {
        const existing = doc.slots.find((slot) => slot.runKey === runKey);
        const renewed = slotFor(runKey, now);
        return {
          write: {
            ...doc,
            slots: [...doc.slots.filter((slot) => slot.runKey !== runKey), { ...renewed, since: existing?.since ?? renewed.since }],
            updatedAt: now.toISOString(),
          },
          result: true,
        };
      });
      return outcome.settled;
    },

    async release(tenantId, runKey, options = {}) {
      await mutate<undefined>(tenantId, (doc, now) => {
        const existing = doc.slots.find((slot) => slot.runKey === runKey);
        if (existing === undefined) return { result: undefined };
        // The allowance is only returned for the UTC day it was taken on.
        const refund = options.refundCase === true && utcDay(new Date(existing.since)) === doc.day;
        return {
          write: {
            ...doc,
            casesToday: refund ? Math.max(0, doc.casesToday - 1) : doc.casesToday,
            slots: doc.slots.filter((slot) => slot.runKey !== runKey),
            updatedAt: now.toISOString(),
          },
          result: undefined,
        };
      });
    },

    async reserveLiveCost(tenantId, estimateMicroUsd) {
      assertMicroUsd(estimateMicroUsd);
      const outcome = await mutate<LiveCostReservation>(tenantId, (doc, now) => {
        if (doc.liveCostMicroUsdToday + estimateMicroUsd > limits.liveCostMicroUsdPerUtcDay) {
          return {
            result: { ok: false, reason: 'tenant_live_cost_limit', retryAfterSeconds: secondsUntilNextUtcDay(now) },
          };
        }
        return {
          write: { ...doc, liveCostMicroUsdToday: doc.liveCostMicroUsdToday + estimateMicroUsd, updatedAt: now.toISOString() },
          result: { ok: true, day: doc.day },
        };
      });
      return outcome.settled
        ? outcome.result
        : { ok: false, reason: 'tenant_admission_busy', retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS };
    },

    async settleLiveCost(tenantId, day, reservedMicroUsd, chargedMicroUsd) {
      assertMicroUsd(reservedMicroUsd);
      assertMicroUsd(chargedMicroUsd);
      const delta = chargedMicroUsd - reservedMicroUsd;
      if (delta === 0) return true;
      const outcome = await mutate<boolean>(tenantId, (doc, now) => {
        if (doc.day !== day) return { result: false };
        return {
          write: { ...doc, liveCostMicroUsdToday: Math.max(0, doc.liveCostMicroUsdToday + delta), updatedAt: now.toISOString() },
          result: true,
        };
      });
      return outcome.settled && outcome.result;
    },
  };
}
