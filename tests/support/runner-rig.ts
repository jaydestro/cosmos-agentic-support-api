import assert from 'node:assert/strict';
import { createDemoInvestigator } from '../../src/agent/demo.ts';
import type { Investigator, Investigators } from '../../src/agent/investigator.ts';
import type { ModelClient } from '../../src/agent/model.ts';
import { createRunner, type Runner } from '../../src/agent/runner.ts';
import { createAdmissionControl, type AdmissionControl } from '../../src/cases/admission.ts';
import {
  ADMISSION_DOC_ID,
  CASE_DOC_ID,
  TENANT_PARTITION,
  newRunDoc,
  type CaseCategory,
  type CaseDoc,
  type Money,
  type ProposalDoc,
  type RunDoc,
  type StoredDoc,
  type TimelineDoc,
  type UsageEventDoc,
} from '../../src/cases/documents.ts';
import type { CaseOp, CaseStore } from '../../src/cases/store.ts';
import { BASE_RUN_LIMITS, BASE_TENANT_LIMITS, type RunLimits } from '../../src/config/limits.ts';
import type { ReferenceStore } from '../../src/data/reference.ts';
import { newOutboxDoc, type OutboxDoc, type OutboxPayload } from '../../src/outbox/types.ts';
import { createMemoryLogger, type Logger } from '../../src/telemetry/log.ts';
import { SEED_TENANTS } from '../../tools/seed/data/index.ts';
import { newCaseId, sampleCase } from './case-fixtures.ts';
import { createTestClock, type TestClock } from './clock.ts';
import { createMemoryCases, type BatchRecord, type MemoryCases } from './memory-case-store.ts';
import { createMemoryReference, type MemoryReference } from './memory-reference.ts';
import { WHEN_V2, usd } from './seed-evidence.ts';

export const APPROVAL_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const DUPLICATE_PAIR: readonly string[] = ['inv_aurora_0001_a', 'inv_aurora_0001_b'];
export const BEFORE_ANY_POLICY = new Date('2025-12-31T23:59:59.000Z');

export interface RigOptions {
  caseId?: string;
  tenantId?: string;
  accountId?: string;
  category?: CaseCategory;
  invoiceIds?: readonly string[];
  requestedCredit?: Money | null;
  description?: string;
  /** What the clock reads when the work item runs, and when the case was opened. */
  when?: Date;
  mode?: 'demo' | 'live';
  limits?: Partial<RunLimits>;
  runOverrides?: Partial<RunDoc>;
  caseOverrides?: Partial<CaseDoc>;
  /** Documents seeded with the aggregate, for instance a usage event an earlier attempt left reserved. */
  extraDocs?: readonly StoredDoc[];
  liveApproved?: boolean;
  /** The tenant's daily live-model allowance; defaults to the shipped limit. */
  tenantLiveCostMicroUsdPerUtcDay?: number;
  investigators?: Partial<Investigators>;
  /** The model a live run calls; none by default. */
  model?: ModelClient | null;
  wrapReference?: (store: ReferenceStore) => ReferenceStore;
  wrapCases?: (store: CaseStore) => CaseStore;
  payload?: OutboxPayload;
}

export interface Rig {
  readonly tenantId: string;
  readonly caseId: string;
  readonly memory: MemoryCases;
  readonly reference: MemoryReference;
  readonly clock: TestClock;
  readonly admission: AdmissionControl;
  readonly runner: Runner;
  readonly item: OutboxDoc;
  readonly logger: Logger;
  /** Every line the runner logged. */
  readonly logs: string[];
  /** The pauses the runner asked for between retries; each also moved the clock. */
  readonly sleeps: number[];
  /** Runs a work item (by default the case's own) once, as the outbox processor would. */
  run(item?: OutboxDoc): Promise<void>;
}

/** A queued case and its first run over the seeded evidence, and a runner wired to in-memory fakes. */
export async function buildRig(options: RigOptions = {}): Promise<Rig> {
  const tenantId = options.tenantId ?? 'aurora';
  const caseId = options.caseId ?? newCaseId();
  const when = options.when ?? WHEN_V2;
  const memory = createMemoryCases();
  const reference = createMemoryReference(SEED_TENANTS);
  const clock = createTestClock(when);
  const { logger, lines } = createMemoryLogger();
  const sleeps: number[] = [];

  const caseDoc = sampleCase(
    tenantId,
    caseId,
    {
      accountId: options.accountId ?? 'acct_aurora_0001',
      category: options.category ?? 'duplicate_charge',
      invoiceIds: [...(options.invoiceIds ?? DUPLICATE_PAIR)],
      requestedCredit: options.requestedCredit === undefined ? usd(4900) : options.requestedCredit,
      ...(options.description === undefined ? {} : { description: options.description }),
      ...options.caseOverrides,
    },
    when.toISOString(),
  );
  const runDoc: RunDoc = {
    ...newRunDoc({ tenantId, caseId, revision: 1, mode: options.mode ?? 'demo', limits: { ...BASE_RUN_LIMITS, ...options.limits }, now: when }),
    ...options.runOverrides,
  };
  const seeded: CaseOp[] = [caseDoc, runDoc, ...(options.extraDocs ?? [])].map((doc): CaseOp => ({ op: 'create', doc }));
  await memory.store.commit(tenantId, caseId, seeded);
  memory.batches.length = 0;
  memory.calls.length = 0;

  const admission = createAdmissionControl({
    store: memory.store,
    limits: {
      concurrentRuns: 3,
      casesPerUtcDay: 25,
      liveCostMicroUsdPerUtcDay: options.tenantLiveCostMicroUsdPerUtcDay ?? BASE_TENANT_LIMITS.liveCostMicroUsdPerUtcDay,
    },
    clock,
    sleep: () => Promise.resolve(),
  });
  const runner = createRunner({
    cases: options.wrapCases === undefined ? memory.store : options.wrapCases(memory.store),
    admission,
    reference: options.wrapReference === undefined ? reference.store : options.wrapReference(reference.store),
    clock,
    config: { liveApproved: options.liveApproved ?? false, approvalTtlMs: APPROVAL_TTL_MS },
    investigators: { demo: createDemoInvestigator(), live: null, ...options.investigators },
    model: options.model ?? null,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
  });
  const item = newOutboxDoc({
    tenantId,
    caseId,
    kind: 'investigation.start',
    key: 'run-1',
    payload: options.payload ?? { runId: 'run-1', revision: 1 },
    now: when,
  });

  return {
    tenantId,
    caseId,
    memory,
    reference,
    clock,
    admission,
    runner,
    item,
    logger,
    logs: lines,
    sleeps,
    run: (target = item) => runner.run(target, logger),
  };
}

const listOf = <T extends StoredDoc>(rig: Rig, type: T['type']): T[] => rig.memory.docs(rig.tenantId, rig.caseId, type) as T[];

export const caseOf = (rig: Rig): CaseDoc => rig.memory.doc('case', rig.tenantId, rig.caseId, CASE_DOC_ID);
export const runOf = (rig: Rig, runId = 'run-1'): RunDoc => rig.memory.doc('run', rig.tenantId, rig.caseId, runId);
export const timelineOf = (rig: Rig): TimelineDoc[] => listOf<TimelineDoc>(rig, 'timeline').toSorted((a, b) => a.seq - b.seq);
export const usageOf = (rig: Rig): UsageEventDoc[] => listOf<UsageEventDoc>(rig, 'usage').toSorted((a, b) => a.seq - b.seq);
export const proposalsOf = (rig: Rig): ProposalDoc[] => listOf<ProposalDoc>(rig, 'proposal').toSorted((a, b) => a.version - b.version);

/** The batches written to the case's own partition, in order. The tenant's admission document lives in another. */
export const caseBatches = (rig: Rig): BatchRecord[] => rig.memory.batches.filter((batch) => batch.caseId === rig.caseId);

export const shapeOf = (batch: BatchRecord): string => batch.ops.map((op) => `${op.op}:${op.type}`).join(',');

/** The runs holding one of the tenant's concurrency slots. */
export function slotKeys(rig: Rig): string[] {
  if (rig.memory.docs(rig.tenantId, TENANT_PARTITION, 'admission').length === 0) return [];
  return rig.memory.doc('admission', rig.tenantId, TENANT_PARTITION, ADMISSION_DOC_ID).slots.map((slot) => slot.runKey);
}

/** What the tenant's live-model counter holds, or 0 before the tenant document exists. */
export function liveCostToday(rig: Rig): number {
  if (rig.memory.docs(rig.tenantId, TENANT_PARTITION, 'admission').length === 0) return 0;
  return rig.memory.doc('admission', rig.tenantId, TENANT_PARTITION, ADMISSION_DOC_ID).liveCostMicroUsdToday;
}

/** Every committed batch in order, with the writes to the tenant's admission document marked. */
export const writeOrder = (rig: Rig): string[] =>
  rig.memory.batches.map((batch) => (batch.caseId === rig.caseId ? shapeOf(batch) : `tenant:${shapeOf(batch)}`));

/** Everything stored for the case as one string, without the document types named in `excluding`. */
export function storedText(rig: Rig, excluding: readonly string[] = []): string {
  return JSON.stringify(rig.memory.docs(rig.tenantId, rig.caseId).filter((doc) => !excluding.includes(doc.type)));
}

/** What the runner logged, one parsed record per line. */
export const logRecords = (rig: Rig): Record<string, unknown>[] => rig.logs.map((line) => JSON.parse(line) as Record<string, unknown>);

export const logged = (rig: Rig, message: string): Record<string, unknown>[] => logRecords(rig).filter((record) => record.message === message);

export const scripted = (investigate: Investigator['investigate'], mode: Investigator['mode'] = 'demo'): Investigator => ({ mode, investigate });

/** An investigator that fails the test if the runner ever hands it a session. */
export const forbidden = (mode: Investigator['mode'] = 'demo'): Investigator =>
  scripted(() => Promise.reject(new Error('this investigator must not run')), mode);

export const transientError = (message: string): Error => Object.assign(new Error(message), { code: 503 });

/** Makes the account lookup fail the given number of times (`Infinity` for always), then answer from the seed. */
export function failingAccount(failures: number, error: Error): (store: ReferenceStore) => ReferenceStore {
  return (store) => {
    let remaining = failures;
    return {
      ...store,
      getAccount(tenantId, accountId) {
        if (remaining <= 0) return store.getAccount(tenantId, accountId);
        remaining -= 1;
        return Promise.reject(error);
      },
    };
  };
}

/** Moves the clock after every write to the case aggregate, which is how a test makes a run take time. */
export function advanceOnCommit(rig: Rig, ms: number): void {
  rig.memory.hooks.afterCommit = (batch) => {
    if (batch.caseId === rig.caseId) rig.clock.advance(ms);
  };
}

export type CrashPhase = 'before' | 'after';

/**
 * Fails the `index`th write to the case aggregate (counting from 0), once: `before` leaves nothing written,
 * `after` applies the write and loses the response, which is how a process that dies mid-write looks.
 */
export function crashAt(rig: Rig, index: number, phase: CrashPhase): void {
  let seen = 0;
  const fail = (batch: BatchRecord): void => {
    if (batch.caseId !== rig.caseId) return;
    const current = seen;
    seen += 1;
    if (current === index) throw new Error('injected crash');
  };
  if (phase === 'before') rig.memory.hooks.beforeCommit = fail;
  else rig.memory.hooks.afterCommit = fail;
}

export function clearHooks(rig: Rig): void {
  rig.memory.hooks.beforeCommit = undefined;
  rig.memory.hooks.afterCommit = undefined;
}

/** What must hold between any two writes of a run, however it ended or was interrupted. */
export function assertAggregateInvariants(rig: Rig): void {
  const caseDoc = caseOf(rig);
  const run = runOf(rig);
  const timeline = timelineOf(rig);
  const usage = usageOf(rig);

  assert.deepEqual(
    timeline.map((entry) => entry.seq),
    timeline.map((_entry, index) => index + 1),
    'timeline sequence numbers are contiguous from 1',
  );
  assert.equal(caseDoc.nextSeq, timeline.length + 1, 'the case allocates the next timeline sequence number');
  assert.deepEqual(
    usage.map((event) => event.seq),
    usage.map((_event, index) => index + 1),
    'usage sequence numbers are contiguous from 1',
  );
  assert.equal(run.nextEventSeq, usage.length + 1, 'the run allocates the next usage sequence number');
  assert.equal(run.usage.toolCalls, usage.filter((event) => event.kind === 'tool').length, 'every counted tool call has an event');
  assert.equal(run.usage.modelCalls, usage.filter((event) => event.kind === 'model').length, 'every counted model call has an event');
  assert.equal(run.usage.failedCalls, usage.filter((event) => event.outcome === 'failed').length, 'failed calls are counted as they are recorded');
  assert.equal(run.usage.ambiguousCalls, usage.filter((event) => event.outcome === 'ambiguous').length, 'ambiguous calls are counted as they are recorded');
  assert.equal(run.usage.retries, usage.filter((event) => event.attempt > 1).length, 'retries are the attempts after the first');
  if (run.mode === 'demo') {
    assert.equal(run.usage.steps, usage.filter((event) => event.attempt === 1).length, 'a demo step is a first attempt');
  } else {
    assert.equal(
      run.usage.steps,
      usage.filter((event) => event.kind === 'model' && event.attempt === 1).length,
      'a live step is the first attempt of a model call',
    );
  }
  for (const event of usage) {
    if (event.outcome !== 'ambiguous') continue;
    // A tool call is ambiguous only when it was interrupted; a model call can also end without a usable answer.
    if (event.kind === 'tool') assert.equal(event.errorCode, 'interrupted', 'an interrupted call says so');
    else assert.ok(event.errorCode === 'interrupted' || event.errorCode?.startsWith('model_') === true, 'an ambiguous model call says why');
  }
  assert.ok(proposalsOf(rig).length <= 1, 'one run stores at most one proposal');
}

/** What must hold once a run has ended: nothing is left reserved and the tenant slot is free. */
export function assertQuiescent(rig: Rig): void {
  assert.equal(usageOf(rig).filter((event) => event.outcome === 'reserved').length, 0, 'no call is left reserved');
  assert.deepEqual(slotKeys(rig), [], 'the tenant slot is released');
}
