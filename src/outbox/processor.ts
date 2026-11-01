import { OUTBOX_LIMITS, type OutboxLimits } from '../config/limits.ts';
import { isTransientDependencyError } from '../data/errors.ts';
import type { Clock } from '../domain/time.ts';
import type { Logger } from '../telemetry/log.ts';
import type { OutboxStore } from './store.ts';
import { backoffAfter, claimed, completed, isClaimLive, msUntilDue, poisoned, released } from './transitions.ts';
import { PermanentOutboxError, RetryableOutboxError, parseOutboxDoc, type OutboxDoc, type OutboxKind } from './types.ts';

export interface OutboxHandlerContext {
  /** The claimed document. Its ETag is the precondition for the handler's own atomic completion write. */
  item: OutboxDoc;
  logger: Logger;
  clock: Clock;
}

/**
 * A handler must be idempotent. It may record completion itself, in the same transaction as its
 * effects, or return and let the processor record completion.
 */
export type OutboxHandler = (context: OutboxHandlerContext) => Promise<void>;
export type OutboxHandlers = Partial<Record<OutboxKind, OutboxHandler>>;

export type ProcessOutcome =
  | 'skipped'
  | 'busy'
  | 'completed'
  | 'retry_scheduled'
  | 'poisoned'
  | 'lost_claim'
  | 'unhandled_kind'
  | 'error';

export interface OutboxProcessor {
  process(doc: OutboxDoc, logger?: Logger): Promise<ProcessOutcome>;
  /** Ignores non-outbox documents, collapses repeated versions of one item, and never throws. */
  processBatch(changes: readonly unknown[], logger?: Logger): Promise<ProcessOutcome[]>;
}

export interface OutboxProcessorDeps {
  store: OutboxStore;
  handlers: OutboxHandlers;
  clock: Clock;
  logger: Logger;
  workerId: string;
  /** `diagnostic.echo` only proves the trigger and leases locally. It is refused on Azure. */
  allowDiagnostics: boolean;
  /** When set, the trigger ignores outbox items of any other tenant, so a stray or fixture document is never executed. */
  tenants?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  limits?: OutboxLimits;
  /**
   * Called once after an item moved to poison, so the case it belongs to can say that it needs attention.
   * Best effort: a failure is logged and never changes what happened to the item.
   */
  onPoisoned?: (item: OutboxDoc, code: string, logger: Logger) => Promise<void>;
}

/** Longer than the largest retry backoff, so a scheduled retry can be waited for in-process. */
const MAX_DUE_WAIT_MS = 10_000;
const MAX_ROUNDS = 4;
const BATCH_CONCURRENCY = 4;

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function failureCode(error: unknown): string {
  if (error instanceof PermanentOutboxError || error instanceof RetryableOutboxError) return error.code;
  return isTransientDependencyError(error) ? 'dependency_unavailable' : 'handler_failed';
}

export function createOutboxProcessor(deps: OutboxProcessorDeps): OutboxProcessor {
  const { store, clock, workerId } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const limits = deps.limits ?? OUTBOX_LIMITS;

  const reread = (doc: OutboxDoc): Promise<OutboxDoc | null> => store.read(doc.tenantId, doc.caseId, doc.id);
  const ownsClaim = (doc: OutboxDoc | null): doc is OutboxDoc & { _etag: string } =>
    doc !== null && doc.state === 'claimed' && doc.claimedBy === workerId && typeof doc._etag === 'string';

  async function finalize(item: OutboxDoc): Promise<'completed' | 'lost_claim'> {
    const latest = await reread(item);
    if (latest?.state === 'completed') return 'completed';
    if (!ownsClaim(latest)) return 'lost_claim';
    return (await store.replace(completed(latest, clock.now()), latest._etag)) === null ? 'lost_claim' : 'completed';
  }

  async function notifyPoisoned(item: OutboxDoc, code: string, log: Logger): Promise<void> {
    if (deps.onPoisoned === undefined) return;
    try {
      await deps.onPoisoned(item, code, log);
    } catch (error) {
      log.error('poison notification failed', { code: failureCode(error) });
    }
  }

  async function recordFailure(item: OutboxDoc, error: unknown, log: Logger): Promise<ProcessOutcome> {
    const code = failureCode(error);
    // The handler's transaction may have committed even though the call failed; the stored state decides.
    const latest = await reread(item);
    if (latest?.state === 'completed') return 'completed';
    if (!ownsClaim(latest)) return 'lost_claim';
    const now = clock.now();
    if (error instanceof PermanentOutboxError || latest.attempts >= latest.maxAttempts) {
      const stored = await store.replace(poisoned(latest, now, code), latest._etag);
      log.warn('outbox item moved to poison', { code, attempts: latest.attempts });
      if (stored === null) return 'lost_claim';
      await notifyPoisoned(stored, code, log);
      return 'poisoned';
    }
    const delay = backoffAfter(latest.attempts, limits.backoffMs);
    const stored = await store.replace(released(latest, now, code, delay), latest._etag);
    log.warn('outbox item scheduled for retry', { code, attempts: latest.attempts, delayMs: delay });
    return stored === null ? 'lost_claim' : 'retry_scheduled';
  }

  async function process(doc: OutboxDoc, logger: Logger = deps.logger): Promise<ProcessOutcome> {
    const log = logger.child({ outboxId: doc.id, outboxKind: doc.kind, tenantId: doc.tenantId });
    if (doc.kind === 'diagnostic.echo' && !deps.allowDiagnostics) {
      log.warn('diagnostic outbox item refused');
      return 'unhandled_kind';
    }
    const handler = deps.handlers[doc.kind];
    if (handler === undefined) {
      log.warn('no handler registered for outbox kind');
      return 'unhandled_kind';
    }

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      // The delivered change may be stale; the stored document is the source of truth.
      const fresh = await reread(doc);
      if (fresh === null || fresh.state === 'completed' || fresh.state === 'poison') return 'skipped';
      const now = clock.now();
      if (isClaimLive(fresh, now)) return 'busy';
      if (fresh.state === 'pending') {
        const wait = msUntilDue(fresh, now);
        if (wait > MAX_DUE_WAIT_MS) return 'busy';
        if (wait > 0) {
          await sleep(wait);
          continue;
        }
      }
      if (typeof fresh._etag !== 'string') throw new Error('outbox document was read without an ETag');
      const claim = await store.replace(claimed(fresh, workerId, now, limits.claimLeaseMs), fresh._etag);
      if (claim === null) continue;

      try {
        await handler({ item: claim, logger: log, clock });
      } catch (error) {
        return recordFailure(claim, error, log);
      }
      return finalize(claim);
    }
    return 'busy';
  }

  async function safeProcess(doc: OutboxDoc, logger: Logger): Promise<ProcessOutcome> {
    try {
      const outcome = await process(doc, logger);
      logger.info('outbox item processed', { outboxId: doc.id, outboxKind: doc.kind, outcome });
      return outcome;
    } catch (error) {
      logger.error('outbox item could not be processed', {
        outboxId: doc.id,
        outboxKind: doc.kind,
        code: failureCode(error),
      });
      return 'error';
    }
  }

  return {
    process,

    async processBatch(changes, logger = deps.logger) {
      const unique = new Map<string, OutboxDoc>();
      for (const change of changes) {
        const doc = parseOutboxDoc(change);
        if (doc !== null && (deps.tenants === undefined || deps.tenants.includes(doc.tenantId))) {
          unique.set(`${doc.tenantId}|${doc.caseId}|${doc.id}`, doc);
        }
      }
      const queue = [...unique.values()];
      const outcomes: ProcessOutcome[] = [];
      const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          outcomes.push(await safeProcess(next, logger));
        }
      });
      await Promise.all(workers);
      return outcomes;
    },
  };
}
