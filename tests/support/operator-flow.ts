import assert from 'node:assert/strict';
import type { Money } from '../../src/cases/documents.ts';
import { OUTBOX_LIMITS, type RunLimits } from '../../src/config/limits.ts';
import { creditKeyFor } from '../../src/credits/provider.ts';
import { claimed } from '../../src/outbox/transitions.ts';
import { outboxId, type OutboxDoc } from '../../src/outbox/types.ts';
import {
  actors,
  approve,
  awaitingApproval,
  caseOf,
  ok,
  openCase,
  TENANT,
  type Actors,
  type DecisionAcceptedView,
  type OpenOptions,
  type RunView,
} from './decision-flow.ts';
import { BASE_CONFIG, NOW } from './handler-harness.ts';
import type { BatchRecord } from './memory-case-store.ts';

/** Shared setup for the unit tests of operator inspection and recovery. */

// Plain letters and digits only, so JSON escaping can never hide the text from a log search.
export const MARKER = 'zq4471';

export const CREDIT_OUTBOX_ID = outboxId('credit.execute', 'v1');

/** What an operator typed to justify a recovery: kept in the timeline, never written to a log. */
export const REASON = `Checked the ledger by hand (${MARKER}); it is safe to run this again.`;

export const requeueBody = (reason = REASON) => ({ action: 'requeue', reason });
export const resumeBody = (allowance: Readonly<Record<string, number>>, reason = REASON) => ({ action: 'resume', reason, allowance });

/** Not the amount the proposal asks for, so a ledger holding it disagrees with the credit about to be issued. */
const CONFLICTING: Money = { amountMinor: 100, currency: 'USD' };

export const transient = (code = 429): Error => Object.assign(new Error('throttled'), { code });
export const snapshot = (who: Actors, caseId: string) => structuredClone(who.world.memory.docs(TENANT, caseId));
export const batchCount = (who: Actors): number => who.world.memory.batches.length;
export const batchesFor = (who: Actors, caseId: string): BatchRecord[] => who.world.memory.batches.filter((batch) => batch.caseId === caseId);
export const commitCalls = (who: Actors, caseId: string): number =>
  who.world.memory.calls.filter((call) => call.method === 'commit' && call.caseId === caseId).length;
export const opsOf = (batch: BatchRecord | undefined): string[] => (batch?.ops ?? []).map((op) => `${op.op}:${op.type}`);
export const outboxOf = (who: Actors, kind: string): OutboxDoc[] => who.world.memory.outboxDocs().filter((doc) => doc.kind === kind);
export const startsOf = (who: Actors, caseId: string): OutboxDoc[] => outboxOf(who, 'investigation.start').filter((doc) => doc.caseId === caseId);
export const slotsOf = (who: Actors): string[] => who.world.memory.doc('admission', TENANT, '_tenant', 'tenant').slots.map((slot) => slot.runKey);

export const creditOutbox = (who: Actors, caseId: string): OutboxDoc => who.world.memory.doc('outbox', TENANT, caseId, CREDIT_OUTBOX_ID);

export async function runsOf(who: Actors, caseId: string): Promise<RunView[]> {
  const reply = await who.representative.call('listInvestigationRuns', { params: { caseId } });
  return ok<{ items: RunView[] }>(reply).items;
}

/** Callers whose runs are cut off by `limits`. Every other limit keeps its agreed value. */
export function stoppedAt(limits: Partial<RunLimits>, concurrentRuns?: number): Actors {
  const runLimits = { ...BASE_CONFIG.runLimits, ...limits };
  return concurrentRuns === undefined
    ? actors({ config: { runLimits } })
    : actors({ config: { runLimits, tenantLimits: { ...BASE_CONFIG.tenantLimits, concurrentRuns } } });
}

/** Opens a case whose run stops at its allowance and delivers it, so the run waits for an operator. */
export async function exhaustedRun(who: Actors, options: OpenOptions = {}): Promise<string> {
  const caseId = await openCase(who, options);
  assert.deepEqual(await who.representative.drain(), ['completed']);
  const detail = await caseOf(who.representative, caseId);
  assert.equal(detail.status, 'needs_attention');
  assert.equal(detail.latestRun?.state, 'budget_exhausted');
  return caseId;
}

/** Approves a proposal whose credit the ledger already holds for another amount, so the credit work is poisoned at once. */
export async function poisonedCredit(who: Actors, options: OpenOptions = {}): Promise<string> {
  const pending = await awaitingApproval(who, options);
  ok<DecisionAcceptedView>(await approve(who.approver, pending), 202);
  who.world.provider.record({
    key: creditKeyFor(pending.caseId, 1),
    tenantId: TENANT,
    caseId: pending.caseId,
    amount: CONFLICTING,
    reference: 'sim-conflicting',
    createdAt: NOW.toISOString(),
  });
  assert.deepEqual(await who.approver.drain(), ['poisoned']);
  return pending.caseId;
}

/** Leaves the credit work claimed by a worker that then vanishes: the claim is live until the clock passes its lease. */
export async function claimCredit(who: Actors, caseId: string): Promise<OutboxDoc> {
  const { memory, clock } = who.world;
  const queued = await memory.outbox.read(TENANT, caseId, CREDIT_OUTBOX_ID);
  assert.ok(queued, 'the credit work exists');
  assert.ok(queued._etag, 'the credit work has an ETag');
  const item = await memory.outbox.replace(claimed(queued, 'worker-gone', clock.now(), OUTBOX_LIMITS.claimLeaseMs), queued._etag);
  assert.ok(item, 'the claim was recorded');
  return item;
}
