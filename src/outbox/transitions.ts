import { OUTBOX_LIMITS } from '../config/limits.ts';
import { addMs } from '../domain/time.ts';
import type { OutboxDoc } from './types.ts';

const iso = (date: Date): string => date.toISOString();

export function isClaimLive(doc: OutboxDoc, now: Date): boolean {
  return doc.state === 'claimed' && doc.claimedUntil !== null && Date.parse(doc.claimedUntil) > now.getTime();
}

export function msUntilDue(doc: OutboxDoc, now: Date): number {
  return Math.max(0, Date.parse(doc.notBefore) - now.getTime());
}

/** Delay after the Nth failed attempt (1-based). The last value of the schedule repeats. */
export function backoffAfter(attempts: number, schedule: readonly number[] = OUTBOX_LIMITS.backoffMs): number {
  const index = Math.min(Math.max(attempts, 1), schedule.length) - 1;
  return schedule[index] ?? 0;
}

/** Every claim, including a takeover after a crash, consumes one attempt. */
export function claimed(doc: OutboxDoc, workerId: string, now: Date, leaseMs: number): OutboxDoc {
  return {
    ...doc,
    state: 'claimed',
    attempts: doc.attempts + 1,
    claimedBy: workerId,
    claimedUntil: iso(addMs(now, leaseMs)),
    updatedAt: iso(now),
  };
}

export function released(doc: OutboxDoc, now: Date, errorCode: string, delayMs: number): OutboxDoc {
  return {
    ...doc,
    state: 'pending',
    claimedBy: null,
    claimedUntil: null,
    notBefore: iso(addMs(now, delayMs)),
    lastError: { code: errorCode, at: iso(now) },
    updatedAt: iso(now),
  };
}

export function poisoned(doc: OutboxDoc, now: Date, errorCode: string): OutboxDoc {
  return {
    ...doc,
    state: 'poison',
    claimedBy: null,
    claimedUntil: null,
    lastError: { code: errorCode, at: iso(now) },
    updatedAt: iso(now),
  };
}

export function completed(doc: OutboxDoc, now: Date): OutboxDoc {
  return {
    ...doc,
    state: 'completed',
    claimedBy: null,
    claimedUntil: null,
    completedAt: iso(now),
    updatedAt: iso(now),
  };
}

/** An operator's decision to run poison or stalled work again: a fresh budget of attempts, due at once. */
export function requeued(doc: OutboxDoc, now: Date): OutboxDoc {
  return {
    ...doc,
    state: 'pending',
    attempts: 0,
    claimedBy: null,
    claimedUntil: null,
    notBefore: iso(now),
    updatedAt: iso(now),
  };
}
