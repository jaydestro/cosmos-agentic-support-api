import type { AdmissionControl } from '../cases/admission.ts';
import {
  AGENT_ACTOR,
  CASE_DOC_ID,
  SYSTEM_ACTOR,
  appendTimeline,
  briefOf,
  isTerminalRun,
  newProposalDoc,
  runKeyFor,
  type CaseDoc,
  type ProposalDoc,
  type RunDoc,
  type TimelineDraft,
  type UsageEventDoc,
} from '../cases/documents.ts';
import { CaseWriteError, type CaseOp, type CaseStore } from '../cases/store.ts';
import { CASE_LIMITS } from '../config/limits.ts';
import { isTransientDependencyError } from '../data/errors.ts';
import type { ReferenceStore } from '../data/reference.ts';
import { runIdFor } from '../domain/ids.ts';
import { formatMinor } from '../domain/money.ts';
import type { Clock } from '../domain/time.ts';
import { PermanentOutboxError, RetryableOutboxError, type OutboxDoc } from '../outbox/types.ts';
import type { Logger } from '../telemetry/log.ts';
import type { CaseFacts } from './adjudicate.ts';
import { addActive, interrupt, overshootOf, reserve, settle } from './budget.ts';
import type { AcceptedSubmission, Retrieved } from './guard.ts';
import { RunStopped, type InvestigationSession, type Investigator, type Investigators } from './investigator.ts';
import { ModelFailure, type ModelClient, type ModelCompletion, type ModelMessage } from './model.ts';
import { TOOL_NAMES, createToolBox, type ToolBox, type ToolCall } from './tools.ts';

/**
 * Executes one `investigation.start` work item: it runs an investigator against the stored case and
 * leaves the run in a state a person or an operator can act on. Everything it knows is read from the
 * case aggregate, so an invocation that is redelivered, or that follows a crash, starts from stored state.
 *
 * Each call an investigator makes is two batches, each atomic in the case's partition:
 *  1. reserve: the usage event (`reserved`) and the run with the allowance counted. Nothing is called
 *     before this commits, so a crash can never lose track of a call that may have happened.
 *  2. settle: the usage event with its outcome, a timeline item, the run and the case.
 * The accepted proposal is one further batch that also completes the run, so the pending proposal is
 * durable in the same write that releases the compute. A crash leaves at most one `reserved` event;
 * the next attempt settles it as `ambiguous` and starts the plan again, spending budget that is never refunded.
 *
 * A model call follows the same two batches and adds the tenant's daily live-cost allowance. The run's
 * allowance is checked first (it is pure, so a refusal touches nothing), then the estimated cost is added
 * to the tenant's counter, then the reserve batch commits and the model is called. After the settle batch
 * the counter is corrected to the priced usage, best effort. Every failure leaves the counter at or above
 * the true spend: a crash, a lost write or a call of unknown outcome keeps the reservation.
 *
 * A write that loses a race is not retried here. It fails the work item with `run_conflict`, and the
 * outbox retries it from a fresh read.
 */

export interface RunnerConfig {
  /** Whether live-model runs are approved. Without it a live run is blocked, never answered by the demo plan. */
  liveApproved: boolean;
  approvalTtlMs: number;
}

export interface RunnerDeps {
  cases: CaseStore;
  admission: AdmissionControl;
  reference: ReferenceStore;
  clock: Clock;
  config: RunnerConfig;
  investigators: Investigators;
  /** The live-model client, or `null` when none is configured; a live run then cannot make a model call. */
  model: ModelClient | null;
  sleep?: (ms: number) => Promise<void>;
  /** Pause before each retry of a call that met a transient dependency failure; the last value repeats. */
  backoffMs?: readonly number[];
}

export interface Runner {
  run(item: OutboxDoc, logger: Logger): Promise<void>;
}

type BlockReason = 'live_not_approved' | 'live_not_configured';

const BLOCK_SUMMARY: Record<BlockReason, string> = {
  live_not_approved: 'Run blocked: live-model runs are not approved on this deployment. Demo mode was not substituted.',
  live_not_configured: 'Run blocked: no live-model adapter is configured on this deployment. Demo mode was not substituted.',
};

const DEFAULT_BACKOFF_MS: readonly number[] = [250, 500];
const MAX_STOP_REASON_CHARS = 80;
const KNOWN_TOOLS: readonly string[] = TOOL_NAMES;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const noop = (): void => undefined;

/** The case and run documents with the ETags their next conditional writes must carry. */
interface Aggregate {
  readonly tenantId: string;
  readonly caseId: string;
  caseDoc: CaseDoc;
  caseEtag: string;
  run: RunDoc;
  runEtag: string;
}

interface Execution {
  readonly agg: Aggregate;
  readonly logger: Logger;
  /** Start of the time not yet added to the run's active time. */
  checkpoint: number;
  /** Set once the batch that stores the accepted proposal has committed. */
  accepted: boolean;
}

interface Transition {
  run: RunDoc;
  caseChanges?: Partial<CaseDoc>;
  drafts: readonly TimelineDraft[];
  /** Written before the timeline items and the run and case replaces. */
  extra?: readonly CaseOp[];
  now: Date;
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`expected an entry at position ${String(index)}`);
  return item;
}

function parsePayload(item: OutboxDoc): { runId: string; revision: number } {
  const { runId, revision } = item.payload;
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    revision > CASE_LIMITS.maxRuns ||
    runId !== runIdFor(revision)
  ) {
    throw new PermanentOutboxError('invalid_payload', 'The investigation work item does not name a run.');
  }
  return { runId: runIdFor(revision), revision };
}

function writeConflict(error: CaseWriteError): PermanentOutboxError | RetryableOutboxError {
  return error.reason === 'missing'
    ? new PermanentOutboxError('aggregate_missing', 'A document of the case aggregate no longer exists.')
    : new RetryableOutboxError('run_conflict', 'The case changed while the run was writing; the work is retried from stored state.');
}

function toolDraft(call: ToolCall, attempt: number): TimelineDraft {
  const data = { tool: call.tool, attempt, outcome: call.outcome, errorCode: call.errorCode };
  if (call.outcome === 'succeeded') return { kind: 'tool_called', actor: AGENT_ACTOR, summary: `Called ${call.tool}.`, data };
  const code = call.errorCode ?? 'unknown';
  return call.tool === 'submit_proposal'
    ? { kind: 'proposal_rejected_by_code', actor: AGENT_ACTOR, summary: `Proposal refused by code: ${code}.`, data }
    : { kind: 'tool_called', actor: AGENT_ACTOR, summary: `Call to ${call.tool} refused by code: ${code}.`, data };
}

interface ModelCallRecord {
  model: string;
  attempt: number;
  outcome: 'succeeded' | 'failed' | 'ambiguous';
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
  finishReason: string | null;
  toolCalls: number | null;
  pricingAsOf: string;
}

/** What is recorded of a model call: its accounting and the shape of the answer, never the text exchanged. */
function modelDraft(record: ModelCallRecord): TimelineDraft {
  const code = record.errorCode ?? 'unknown';
  const summary =
    record.outcome === 'succeeded'
      ? `Called the model ${record.model}.`
      : record.outcome === 'failed'
        ? `Call to the model ${record.model} failed: ${code}.`
        : `Call to the model ${record.model} ended without a usable answer and may have been billed: ${code}.`;
  return { kind: 'model_called', actor: AGENT_ACTOR, summary, data: { ...record } };
}

function proposalDraft(proposal: ProposalDoc): TimelineDraft {
  const policy = proposal.policyRef;
  if (proposal.kind === 'credit') {
    const { amount } = proposal;
    if (amount === null) throw new RangeError('A credit proposal carries an amount.');
    return {
      kind: 'proposal_submitted',
      actor: AGENT_ACTOR,
      summary: `Proposed a credit of ${formatMinor(amount.amountMinor, amount.currency)} for approval.`,
      data: {
        version: proposal.version,
        amountMinor: amount.amountMinor,
        currency: amount.currency,
        policyVersion: policy === null ? null : policy.version,
        clauseId: policy === null ? null : policy.clauseId,
        digest: proposal.digest,
      },
    };
  }
  return {
    kind: 'finding_recorded',
    actor: AGENT_ACTOR,
    summary: `Recorded a finding: ${proposal.findingCode ?? 'none'}.`,
    data: {
      version: proposal.version,
      findingCode: proposal.findingCode,
      policyVersion: policy === null ? null : policy.version,
      clauseId: policy === null ? null : policy.clauseId,
      digest: proposal.digest,
    },
  };
}

/** Why an investigation that ended without a proposal could not make one. */
function noProposalReason(retrieved: Retrieved): string {
  if (retrieved.account.status === 'absent') return 'account_unavailable';
  if (retrieved.policy.status === 'absent') return 'policy_unavailable';
  return 'no_proposal_submitted';
}

export function createRunner(deps: RunnerDeps): Runner {
  const { cases, admission, reference, clock, config, investigators, model } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;

  const pauseBefore = (attempt: number): number =>
    backoffMs.length === 0 ? 0 : (backoffMs[Math.min(attempt, backoffMs.length) - 1] ?? 0);

  /** Milliseconds worked since the last tick. The approval wait and any crash gap are never part of it. */
  function tick(exec: Execution, now: Date): number {
    const ms = now.getTime() - exec.checkpoint;
    exec.checkpoint = now.getTime();
    return ms;
  }

  async function persist(exec: Execution, change: { run: RunDoc; caseDoc?: CaseDoc }, extra: readonly CaseOp[] = []): Promise<string[]> {
    const { agg } = exec;
    const ops: CaseOp[] = [...extra, { op: 'replace', doc: change.run, etag: agg.runEtag }];
    if (change.caseDoc !== undefined) ops.push({ op: 'replace', doc: change.caseDoc, etag: agg.caseEtag });
    let etags: string[];
    try {
      etags = await cases.commit(agg.tenantId, agg.caseId, ops);
    } catch (error) {
      if (error instanceof CaseWriteError) throw writeConflict(error);
      throw error;
    }
    agg.run = change.run;
    agg.runEtag = nth(etags, extra.length);
    if (change.caseDoc !== undefined) {
      agg.caseDoc = change.caseDoc;
      agg.caseEtag = nth(etags, extra.length + 1);
    }
    return etags;
  }

  /** A state change with its timeline items: the case document allocates the sequence, so it is replaced in the same batch. */
  async function transition(exec: Execution, input: Transition): Promise<string[]> {
    const appended = appendTimeline(exec.agg.caseDoc, input.drafts, input.now);
    const caseDoc: CaseDoc = { ...appended.caseDoc, ...input.caseChanges };
    const created: CaseOp[] = appended.docs.map((doc) => ({ op: 'create', doc }));
    return persist(exec, { run: input.run, caseDoc }, [...(input.extra ?? []), ...created]);
  }

  /** Settles what an earlier attempt reserved and never finished. The run is `running` only if one crashed. */
  async function settleInterrupted(exec: Execution, now: Date): Promise<{ run: RunDoc; extra: CaseOp[]; count: number }> {
    const { agg } = exec;
    const outstanding = await cases.listReservedUsage(agg.tenantId, agg.caseId, agg.run.runId);
    const interrupted = interrupt(
      agg.run,
      outstanding.map((entry) => entry.doc),
      now,
    );
    const extra: CaseOp[] = interrupted.events.map((doc, index) => ({ op: 'replace', doc, etag: nth(outstanding, index).etag }));
    return { run: interrupted.run, extra, count: interrupted.events.length };
  }

  async function begin(exec: Execution): Promise<void> {
    const { agg } = exec;
    const now = clock.now();
    const at = now.toISOString();
    if (agg.run.state === 'running') {
      const interrupted = await settleInterrupted(exec, now);
      await transition(exec, {
        run: { ...interrupted.run, updatedAt: at },
        caseChanges: { status: 'investigating' },
        drafts: [
          {
            kind: 'run_restarted',
            actor: SYSTEM_ACTOR,
            summary: 'Investigation restarted after an interruption.',
            data: { runId: agg.run.runId, interruptedCalls: interrupted.count },
          },
        ],
        extra: interrupted.extra,
        now,
      });
      return;
    }
    await transition(exec, {
      run: { ...agg.run, state: 'running', startedAt: agg.run.startedAt ?? at, finishedAt: null, stopReason: null, updatedAt: at },
      caseChanges: { status: 'investigating' },
      drafts: [
        {
          kind: 'run_started',
          actor: SYSTEM_ACTOR,
          summary: 'Investigation started.',
          data: { runId: agg.run.runId, mode: agg.run.mode, resumed: agg.run.startedAt !== null },
        },
      ],
      now,
    });
  }

  async function block(exec: Execution, reason: BlockReason): Promise<void> {
    const { agg } = exec;
    const now = clock.now();
    const at = now.toISOString();
    const interrupted = agg.run.state === 'running' ? await settleInterrupted(exec, now) : { run: agg.run, extra: [], count: 0 };
    await transition(exec, {
      run: { ...interrupted.run, state: 'blocked', stopReason: reason, finishedAt: at, updatedAt: at },
      caseChanges: { status: 'needs_attention' },
      drafts: [{ kind: 'run_blocked', actor: SYSTEM_ACTOR, summary: BLOCK_SUMMARY[reason], data: { reason, mode: agg.run.mode } }],
      extra: interrupted.extra,
      now,
    });
  }

  /** Records that the run stopped for a reason that needs a person: budget spent, or a failure retrying cannot fix. */
  async function stop(exec: Execution, stopped: RunStopped): Promise<void> {
    const now = clock.now();
    const at = now.toISOString();
    const reason = stopped.reason.slice(0, MAX_STOP_REASON_CHARS);
    const budget = stopped.kind === 'budget_exhausted';
    const finished: RunDoc = {
      ...addActive(exec.agg.run, tick(exec, now)),
      state: budget ? 'budget_exhausted' : 'failed',
      stopReason: reason,
      finishedAt: at,
      updatedAt: at,
    };
    const overshoot = overshootOf(finished);
    const draft: TimelineDraft = budget
      ? {
          kind: 'run_budget_exhausted',
          actor: SYSTEM_ACTOR,
          summary: `Run stopped: the allowance is exhausted (${reason}).`,
          data: { reason, overshootTokens: overshoot.tokens, overshootCostMicroUsd: overshoot.costMicroUsd },
        }
      : { kind: 'run_failed', actor: SYSTEM_ACTOR, summary: `Run failed: ${reason}.`, data: { reason } };
    await transition(exec, { run: finished, caseChanges: { status: 'needs_attention' }, drafts: [draft], now });
  }

  /** The batch that stores an accepted proposal, completes the run and hands the case to a person. */
  async function accept(exec: Execution, settled: { run: RunDoc; event: UsageEventDoc }, usageEtag: string, submission: AcceptedSubmission, now: Date): Promise<void> {
    const { agg } = exec;
    const at = now.toISOString();
    const proposal = newProposalDoc({
      tenantId: agg.tenantId,
      caseId: agg.caseId,
      runId: settled.run.runId,
      version: settled.run.revision,
      content: submission,
      now,
      approvalTtlMs: config.approvalTtlMs,
    });
    await transition(exec, {
      run: { ...settled.run, state: 'completed', stopReason: null, finishedAt: at, updatedAt: at },
      caseChanges: { status: proposal.kind === 'credit' ? 'awaiting_approval' : 'finding_reported', latestProposal: briefOf(proposal) },
      drafts: [proposalDraft(proposal)],
      extra: [
        { op: 'replace', doc: settled.event, etag: usageEtag },
        { op: 'create', doc: proposal },
      ],
      now,
    });
    exec.accepted = true;
  }

  /** Settles a call that threw. Nothing about the failure beyond its code is stored. */
  async function recordFailure(exec: Execution, event: UsageEventDoc, usageEtag: string, tool: string, attempt: number, code: string, startedMs: number): Promise<void> {
    const now = clock.now();
    const run = addActive(exec.agg.run, tick(exec, now));
    const settled = settle(run, event, { outcome: 'failed', errorCode: code, latencyMs: Math.max(0, now.getTime() - startedMs), usage: null, now });
    await transition(exec, {
      run: settled.run,
      drafts: [
        {
          kind: 'tool_called',
          actor: AGENT_ACTOR,
          summary: `Call to ${tool} failed: ${code}.`,
          data: { tool, attempt, outcome: 'failed', errorCode: code },
        },
      ],
      extra: [{ op: 'replace', doc: settled.event, etag: usageEtag }],
      now,
    });
  }

  async function callTool(exec: Execution, toolbox: ToolBox, name: string, args: unknown): Promise<ToolCall> {
    if (exec.accepted) return toolbox.call(name, args);
    const tool = KNOWN_TOOLS.includes(name) ? name : 'unknown';
    const { mode } = exec.agg.run;

    for (let attempt = 1; ; attempt += 1) {
      const reservedAt = clock.now();
      exec.agg.run = addActive(exec.agg.run, tick(exec, reservedAt));
      const reservation = reserve(exec.agg.run, {
        kind: 'tool',
        name: tool,
        attempt,
        startsTurn: mode === 'demo' && attempt === 1,
        estimate: { tokens: 0, costMicroUsd: 0 },
        now: reservedAt,
      });
      if (!reservation.ok) throw new RunStopped('budget_exhausted', reservation.reason);
      const etags = await persist(exec, { run: reservation.run }, [{ op: 'create', doc: reservation.event }]);
      const usageEtag = nth(etags, 0);

      const startedMs = clock.now().getTime();
      let call: ToolCall;
      try {
        call = await toolbox.call(name, args);
      } catch (error) {
        const code = isTransientDependencyError(error) ? 'dependency_unavailable' : 'tool_error';
        exec.logger.warn('tool call failed', { tool, attempt, errorCode: code, errorName: error instanceof Error ? error.name : 'unknown' });
        await recordFailure(exec, reservation.event, usageEtag, tool, attempt, code, startedMs);
        if (code === 'tool_error') throw new RunStopped('failed', code);
        await sleep(pauseBefore(attempt));
        continue;
      }

      const now = clock.now();
      const run = addActive(exec.agg.run, tick(exec, now));
      const settled = settle(run, reservation.event, {
        outcome: call.outcome,
        errorCode: call.errorCode,
        latencyMs: Math.max(0, now.getTime() - startedMs),
        usage: null,
        now,
      });
      if (call.submission !== null) {
        await accept(exec, settled, usageEtag, call.submission, now);
        return call;
      }
      await transition(exec, {
        run: settled.run,
        drafts: [toolDraft(call, attempt)],
        extra: [{ op: 'replace', doc: settled.event, etag: usageEtag }],
        now,
      });
      return call;
    }
  }

  /** Best effort: whatever stays unsettled stays counted, which errs high. */
  async function settleTenantCost(exec: Execution, day: string, reserved: number, charged: number): Promise<void> {
    try {
      const settled = await admission.settleLiveCost(exec.agg.tenantId, day, reserved, charged);
      if (!settled) exec.logger.info('tenant live cost left as reserved', { reservedMicroUsd: reserved, chargedMicroUsd: charged });
    } catch (error) {
      exec.logger.warn('tenant live cost settlement failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    }
  }

  async function callModel(exec: Execution, messages: readonly ModelMessage[]): Promise<ModelCompletion> {
    if (model === null || exec.agg.run.mode !== 'live') throw new RunStopped('failed', 'live_not_configured');
    // The run is complete once a proposal is stored; there is nothing left to ask.
    if (exec.accepted) throw new RunStopped('failed', 'model_after_submission');
    const { tenantId } = exec.agg;
    const { deployment, pricing } = model;

    for (let attempt = 1; ; attempt += 1) {
      const estimate = model.estimate(messages);
      const reservedAt = clock.now();
      exec.agg.run = addActive(exec.agg.run, tick(exec, reservedAt));
      const reservation = reserve(exec.agg.run, {
        kind: 'model',
        name: deployment,
        attempt,
        startsTurn: attempt === 1,
        estimate,
        now: reservedAt,
      });
      if (!reservation.ok) throw new RunStopped('budget_exhausted', reservation.reason);

      const tenant = await admission.reserveLiveCost(tenantId, estimate.costMicroUsd);
      if (!tenant.ok) {
        if (tenant.reason === 'tenant_admission_busy') {
          throw new RetryableOutboxError('tenant_admission_busy', 'The tenant allowance was busy; the work is retried from stored state.');
        }
        throw new RunStopped('budget_exhausted', 'tenant_cost_exhausted');
      }

      let usageEtag: string;
      try {
        usageEtag = nth(await persist(exec, { run: reservation.run }, [{ op: 'create', doc: reservation.event }]), 0);
      } catch (error) {
        // Only a write known not to have been applied returns the reservation. After any other failure the
        // usage event may exist, and the next attempt settles it as ambiguous at its full reservation.
        if (error instanceof RetryableOutboxError || error instanceof PermanentOutboxError) {
          await settleTenantCost(exec, tenant.day, estimate.costMicroUsd, 0);
        }
        throw error;
      }

      const startedMs = clock.now().getTime();
      let result: { completion: ModelCompletion } | { failure: ModelFailure };
      try {
        result = { completion: await model.complete(messages) };
      } catch (error) {
        const failure = error instanceof ModelFailure ? error : new ModelFailure('model_client_error', 'ambiguous', false);
        exec.logger.warn('model call failed', {
          model: deployment,
          attempt,
          errorCode: failure.code,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        result = { failure };
      }

      const now = clock.now();
      const run = addActive(exec.agg.run, tick(exec, now));
      const latencyMs = Math.max(0, now.getTime() - startedMs);

      if ('failure' in result) {
        const { failure } = result;
        const settled = settle(run, reservation.event, { outcome: failure.outcome, errorCode: failure.code, latencyMs, usage: null, now });
        await transition(exec, {
          run: settled.run,
          drafts: [
            modelDraft({
              model: deployment,
              attempt,
              outcome: failure.outcome,
              errorCode: failure.code,
              inputTokens: null,
              outputTokens: null,
              costMicroUsd: null,
              finishReason: null,
              toolCalls: null,
              pricingAsOf: pricing.asOf,
            }),
          ],
          extra: [{ op: 'replace', doc: settled.event, etag: usageEtag }],
          now,
        });
        // The tenant counter keeps the whole reservation: the call may have been processed and billed.
        if (!failure.retryable) throw new RunStopped('failed', failure.code);
        await sleep(Math.max(pauseBefore(attempt), failure.retryAfterMs ?? 0));
        continue;
      }

      const { completion } = result;
      const { usage } = completion;
      const priced = usage === null ? null : model.priceOf(usage);
      const settled = settle(run, reservation.event, {
        outcome: 'succeeded',
        errorCode: null,
        latencyMs,
        usage:
          usage === null
            ? null
            : {
                inputTokens: usage.promptTokens,
                outputTokens: usage.completionTokens,
                tokenQuality: 'measured',
                costMicroUsd: priced,
                costQuality: 'estimated',
              },
        now,
      });
      await transition(exec, {
        run: settled.run,
        drafts: [
          modelDraft({
            model: deployment,
            attempt,
            outcome: 'succeeded',
            errorCode: null,
            inputTokens: usage === null ? null : usage.promptTokens,
            outputTokens: usage === null ? null : usage.completionTokens,
            costMicroUsd: priced,
            finishReason: completion.finishReason,
            toolCalls: completion.toolCalls.length,
            pricingAsOf: pricing.asOf,
          }),
        ],
        extra: [{ op: 'replace', doc: settled.event, etag: usageEtag }],
        now,
      });
      // The run is settled first. A crash before this point leaves the counter at the estimate, which is the safe side.
      await settleTenantCost(exec, tenant.day, estimate.costMicroUsd, priced ?? estimate.costMicroUsd);
      return completion;
    }
  }

  function investigatorFor(run: RunDoc): Investigator | BlockReason {
    if (run.mode === 'demo') return investigators.demo;
    if (!config.liveApproved) return 'live_not_approved';
    return investigators.live ?? 'live_not_configured';
  }

  async function execute(item: OutboxDoc, logger: Logger): Promise<void> {
    const { runId, revision } = parsePayload(item);
    const { tenantId, caseId } = item;
    const [caseRead, runRead] = await Promise.all([
      cases.get('case', tenantId, caseId, CASE_DOC_ID),
      cases.get('run', tenantId, caseId, runId),
    ]);
    if (caseRead === null || runRead === null) {
      throw new PermanentOutboxError('aggregate_missing', 'The case or run named by the investigation work item does not exist.');
    }
    if (runRead.doc.revision !== revision) {
      throw new PermanentOutboxError('invalid_payload', 'The investigation work item names a revision the run does not have.');
    }

    const runKey = runKeyFor(caseId, runId);
    if (isTerminalRun(runRead.doc.state)) {
      await admission.release(tenantId, runKey);
      logger.info('investigation already finished', { runId, state: runRead.doc.state });
      return;
    }
    if (caseRead.doc.latestRunId !== runId) {
      throw new PermanentOutboxError('run_superseded', 'A later run replaced the one this work item names.');
    }

    const exec: Execution = {
      agg: { tenantId, caseId, caseDoc: caseRead.doc, caseEtag: caseRead.etag, run: runRead.doc, runEtag: runRead.etag },
      logger,
      checkpoint: clock.now().getTime(),
      accepted: false,
    };

    const investigator = investigatorFor(runRead.doc);
    if (typeof investigator === 'string') {
      await block(exec, investigator);
      await admission.release(tenantId, runKey);
      logger.warn('investigation blocked', { runId, stopReason: investigator });
      return;
    }

    await admission.hold(tenantId, runKey);
    await begin(exec);

    const { caseDoc } = exec.agg;
    const facts: CaseFacts = {
      category: caseDoc.category,
      invoiceIds: [...caseDoc.invoiceIds],
      requestedCredit: caseDoc.requestedCredit === null ? null : { ...caseDoc.requestedCredit },
    };
    const toolbox = createToolBox({ reference, clock }, { tenantId, accountId: caseDoc.accountId, facts });

    // Calls share one in-memory aggregate and one ETag chain, so they run one at a time.
    let tail: Promise<void> = Promise.resolve();
    const serialized = <T>(task: () => Promise<T>): Promise<T> => {
      const result = tail.then(task);
      tail = result.then(noop, noop);
      return result;
    };
    const session: InvestigationSession = {
      facts,
      call: (name, args) => serialized(() => callTool(exec, toolbox, name, args)),
      model: (messages) => serialized(() => callModel(exec, messages)),
      retrieved: () => toolbox.retrieved(),
    };

    let stopped: RunStopped | null = null;
    try {
      await investigator.investigate(session);
    } catch (error) {
      if (!(error instanceof RunStopped)) throw error;
      stopped = error;
    } finally {
      await tail;
    }

    if (!exec.accepted) {
      await stop(exec, stopped ?? new RunStopped('failed', noProposalReason(toolbox.retrieved())));
    }
    await admission.release(tenantId, runKey);
    logger.info('investigation finished', { runId, state: exec.agg.run.state, stopReason: exec.agg.run.stopReason });
  }

  return { run: execute };
}
