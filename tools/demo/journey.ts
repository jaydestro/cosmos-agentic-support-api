import { setTimeout as delay } from 'node:timers/promises';
import type { components, ResolveClient } from '../../contracts/client/index.ts';
import { CliError, type Command, type CommonOptions } from './args.ts';
import { apiValue } from './transport.ts';

type Schemas = components['schemas'];
type CaseDetail = Schemas['CaseDetail'];
type Proposal = Schemas['Proposal'];

export interface JourneyDependencies {
  readonly emit: (value: unknown) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Snapshot {
  readonly case: CaseDetail;
  readonly runs: Schemas['Run'][];
  readonly proposals: Proposal[];
  readonly timeline: Schemas['TimelineItem'][];
  readonly usage: { readonly runId: string; readonly events: Schemas['UsageEvent'][] }[];
  readonly credit: Schemas['CreditResult'] | null;
}

const TIMELINE_KINDS = new Set([
  'case_created', 'run_queued', 'run_started', 'tool_called', 'model_called', 'proposal_submitted',
  'finding_recorded', 'proposal_rejected_by_code', 'decision_approved', 'decision_rejected',
  'revision_requested', 'execution_queued', 'credit_executed', 'credit_reconciled', 'run_failed',
  'run_blocked', 'run_restarted', 'run_budget_exhausted', 'run_resumed', 'work_poisoned', 'work_requeued', 'approval_expired',
]);

interface Page<T> {
  readonly items: T[];
  readonly continuationToken: string | null;
}

/** Opaque cursors are passed unchanged. Repeated cursors, ordering defects and runaway lists fail closed. */
async function allPages<T extends { seq: number }>(read: (token: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  let previous = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await read(token);
    if (page.items.length > 50) throw new CliError('invalid_pagination', 'API page exceeded the requested 50-event bound.');
    for (const item of page.items) {
      if (!Number.isSafeInteger(item.seq) || item.seq <= previous) {
        throw new CliError('invalid_pagination', 'API events were not strictly ordered by sequence.');
      }
      previous = item.seq;
      items.push(item);
    }
    if (page.continuationToken === null) return items;
    token = page.continuationToken;
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(token) || seen.has(token)) {
      throw new CliError('invalid_pagination', 'API returned an invalid or repeated continuation token.');
    }
    seen.add(token);
  }
  throw new CliError('pagination_limit', 'API pagination exceeded 100 pages; no complete snapshot was produced.');
}

/** Usage is read from the beginning each time: reserved events can settle in place. */
export async function inspectCase(client: ResolveClient, caseId: string): Promise<Snapshot> {
  const detail = await apiValue(client.GET('/cases/{caseId}', { params: { path: { caseId } } }));
  const runs = await apiValue(client.GET('/cases/{caseId}/runs', { params: { path: { caseId } } }));
  const proposals = await apiValue(client.GET('/cases/{caseId}/proposals', { params: { path: { caseId } } }));
  const timeline = await allPages((continuationToken) => apiValue(client.GET('/cases/{caseId}/timeline', {
    params: { path: { caseId }, query: { limit: 50, ...(continuationToken === undefined ? {} : { continuationToken }) } },
  })));
  const usage: Snapshot['usage'] = [];
  for (const run of runs.items) {
    const events = await allPages((continuationToken) => apiValue(client.GET('/cases/{caseId}/runs/{runId}/usage', {
      params: { path: { caseId, runId: run.runId }, query: { limit: 50, ...(continuationToken === undefined ? {} : { continuationToken }) } },
    })));
    usage.push({ runId: run.runId, events });
  }
  const credit = detail.status === 'credited'
    ? await apiValue(client.GET('/cases/{caseId}/credit', { params: { path: { caseId } } }))
    : detail.creditResult;
  return { case: detail, runs: runs.items, proposals: proposals.items, timeline, usage, credit };
}

/** Deliberate field projection: never serialize principals, actor IDs or arbitrary API/model/user text. */
export function summarizeSnapshot(snapshot: Snapshot, mode: CommonOptions['mode'], wait: string): unknown {
  const detail = snapshot.case;
  const money = (value: Schemas['Money'] | null): Schemas['Money'] | null =>
    value === null ? null : { amountMinor: value.amountMinor, currency: value.currency };
  return {
    event: 'inspection', mode, fictional: true, simulatedCredits: true, wait,
    case: {
      caseId: detail.caseId, status: detail.status, revision: detail.revision,
      latestProposal: detail.latestProposal === null ? null : {
        version: detail.latestProposal.version, kind: detail.latestProposal.kind, status: detail.latestProposal.status,
        amount: money(detail.latestProposal.amount), approvalExpiresAt: detail.latestProposal.approvalExpiresAt,
      },
    },
    runs: snapshot.runs.map((run) => ({
      runId: run.runId, revision: run.revision, mode: run.mode, state: run.state,
      stopped: run.stopReason !== null,
      usage: {
        steps: run.usage.steps, toolCalls: run.usage.toolCalls, modelCalls: run.usage.modelCalls,
        retries: run.usage.retries, failedCalls: run.usage.failedCalls, ambiguousCalls: run.usage.ambiguousCalls,
        inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, tokenQuality: run.usage.tokenQuality,
        costMicroUsd: run.usage.costMicroUsd, costQuality: run.usage.costQuality, activeMs: run.usage.activeMs,
      },
      limits: {
        steps: run.limits.steps, toolCalls: run.limits.toolCalls, modelCalls: run.limits.modelCalls,
        tokens: run.limits.tokens, costMicroUsd: run.limits.costMicroUsd, retriesPerCall: run.limits.retriesPerCall,
        retriesPerRun: run.limits.retriesPerRun, activeMs: run.limits.activeMs,
      },
    })),
    proposals: snapshot.proposals.map((proposal) => ({
      version: proposal.version, runId: proposal.runId, kind: proposal.kind, status: proposal.status,
      digest: proposal.digest, amount: money(proposal.amount),
      invoiceRefs: proposal.invoiceRefs.map((reference) => ({ invoiceId: reference.invoiceId, lineIndex: reference.lineIndex })),
      policyRef: proposal.policyRef === null ? null : {
        policyId: proposal.policyRef.policyId, version: proposal.policyRef.version, clauseId: proposal.policyRef.clauseId,
      },
      evidenceAssessment: proposal.evidenceAssessment,
      findingCode: proposal.findingCode, approvalExpiresAt: proposal.approvalExpiresAt,
    })),
    timeline: snapshot.timeline.map((item) => ({
      seq: item.seq, at: item.at, kind: TIMELINE_KINDS.has(item.kind) ? item.kind : 'other', actor: item.actor.type,
    })),
    usage: snapshot.usage.map((run) => ({
      runId: run.runId,
      events: run.events.map((event) => ({
        seq: event.seq, kind: event.kind, outcome: event.outcome, attempt: event.attempt,
        inputTokens: event.inputTokens, outputTokens: event.outputTokens, tokenQuality: event.tokenQuality,
        costMicroUsd: event.costMicroUsd, costQuality: event.costQuality, latencyMs: event.latencyMs,
      })),
    })),
    credit: snapshot.credit === null ? null : {
      proposalVersion: snapshot.credit.proposalVersion, amount: money(snapshot.credit.amount),
      simulated: snapshot.credit.simulated, reconciled: snapshot.credit.provider.reconciled,
      recordedAt: snapshot.credit.recordedAt,
    },
  };
}

function ensureMode(detail: CaseDetail, mode: CommonOptions['mode']): void {
  if (detail.latestRun !== null && detail.latestRun.mode !== mode) {
    throw new CliError('run_mode_mismatch', 'The persisted case run does not match the explicitly requested mode.');
  }
}

function pending(status: CaseDetail['status']): boolean {
  return status === 'queued' || status === 'investigating' || status === 'approved';
}

async function pollCase(client: ResolveClient, caseId: string, options: Command, dependencies: JourneyDependencies): Promise<string> {
  if (options.waitMs === 0) return 'not_requested';
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (async (ms: number) => { await delay(ms); });
  const deadline = now() + options.waitMs;
  const maxReads = Math.ceil(options.waitMs / options.pollMs) + 1;
  for (let reads = 0; reads < maxReads; reads++) {
    const remaining = deadline - now();
    if (remaining <= 0) return 'expired';
    const pollingDeadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    let detail: CaseDetail;
    try {
      detail = await apiValue(client.GET('/cases/{caseId}', {
        params: { path: { caseId } }, signal: pollingDeadlineSignal,
      }));
    } catch (error) {
      if (pollingDeadlineSignal.aborted) return 'expired';
      throw error;
    }
    ensureMode(detail, options.mode);
    if (!pending(detail.status) && !(options.command === 'approve' && detail.status === 'awaiting_approval')) return 'settled';
    const pause = Math.min(options.pollMs, deadline - now());
    if (pause <= 0) return 'expired';
    await sleep(pause);
  }
  return 'expired';
}

/** One public API journey; no direct Cosmos/model calls and no automatic mutation retries. */
export async function runJourney(command: Command, client: ResolveClient, dependencies: JourneyDependencies): Promise<number> {
  const session = await apiValue(client.GET('/session'));
  if (session.environment.agentMode !== command.mode) {
    throw new CliError('mode_mismatch', 'The deployed API mode differs from --mode; no mutation was submitted.');
  }
  if (command.command === 'start' && command.mode === 'live' && !session.environment.liveAvailable) {
    throw new CliError('live_unavailable', 'The deployed live investigator is unavailable; no demo fallback or mutation was submitted.');
  }
  let caseId: string;
  switch (command.command) {
    case 'start': {
      const tenant = session.principal.tenantId;
      if (tenant !== 'aurora' && tenant !== 'borealis') {
        throw new CliError('fixture_unavailable', 'The authenticated application tenant has no supported fictional duplicate fixture.');
      }
      const request: Schemas['CreateCaseRequest'] = {
        accountId: `acct_${tenant}_0001`,
        invoiceIds: [`inv_${tenant}_0001_a`, `inv_${tenant}_0001_b`],
        category: 'duplicate_charge',
        requestedCredit: { amountMinor: tenant === 'aurora' ? 4900 : 5900, currency: tenant === 'aurora' ? 'USD' : 'EUR' },
        description: 'Fictional billing dispute: two paid invoices cover the same September subscription period.',
      };
      const accepted = await apiValue(client.POST('/cases', {
        params: { header: { 'Idempotency-Key': command.idempotencyKey } }, body: request,
      }));
      caseId = accepted.case.caseId;
      // Emit immediately so an interrupted poll never loses the accepted case ID.
      dependencies.emit({ event: 'case_accepted', mode: command.mode, fictional: true, caseId, runId: accepted.runId, replayed: accepted.replayed });
      break;
    }
    case 'inspect':
      caseId = command.caseId;
      break;
    case 'approve':
    case 'reject': {
      caseId = command.caseId;
      const detail = await apiValue(client.GET('/cases/{caseId}', { params: { path: { caseId } } }));
      ensureMode(detail, command.mode);
      if (detail.latestProposal?.version !== command.version) {
        throw new CliError('stale_version', 'The explicit version is not the latest proposal; inspect again before deciding.');
      }
      if (detail.status !== 'awaiting_approval') {
        throw new CliError('proposal_not_decidable', 'The case is not awaiting a human decision.');
      }
      const proposal = await apiValue(client.GET('/cases/{caseId}/proposals/{version}', {
        params: { path: { caseId, version: command.version } },
      }));
      const expiry = proposal.approvalExpiresAt === null ? NaN : Date.parse(proposal.approvalExpiresAt);
      if (proposal.caseId !== caseId || proposal.version !== command.version || proposal.kind !== 'credit' ||
          proposal.status !== 'pending_approval' || proposal.policyRef === null || proposal.amount === null ||
          !/^sha256:[0-9a-f]{64}$/.test(proposal.digest) || !Number.isSafeInteger(proposal.policyRef.version) ||
          proposal.policyRef.version < 1 || proposal.policyRef.version > 999 ||
          !Number.isFinite(expiry) || expiry <= (dependencies.now ?? Date.now)()) {
        throw new CliError('proposal_not_decidable', 'The exact fetched proposal is not an unexpired pending credit with a valid policy and digest.');
      }
      const binding = { policyVersion: proposal.policyRef.version, proposalDigest: proposal.digest };
      // Race/supersession/policy changes are still enforced by the deployed decision endpoint.
      if (command.command === 'approve') {
        const result = await apiValue(client.POST('/cases/{caseId}/proposals/{version}/approve', {
          params: { path: { caseId, version: command.version } },
          body: { ...binding, ...(command.comment === undefined ? {} : { comment: command.comment }) },
        }));
        if (result.decision.caseId !== caseId || result.decision.proposalVersion !== command.version ||
            result.decision.proposalDigest !== binding.proposalDigest || result.decision.policyVersion !== binding.policyVersion ||
            result.decision.outcome !== 'approved') {
          throw new CliError('invalid_response', 'The recorded approval did not match the explicit decision binding.');
        }
        dependencies.emit({ event: 'decision_accepted', mode: command.mode, fictional: true, caseId, version: result.decision.proposalVersion, outcome: result.decision.outcome });
      } else {
        const result = await apiValue(client.POST('/cases/{caseId}/proposals/{version}/reject', {
          params: { path: { caseId, version: command.version } }, body: { ...binding, reason: command.reason },
        }));
        if (result.caseId !== caseId || result.proposalVersion !== command.version ||
            result.proposalDigest !== binding.proposalDigest || result.policyVersion !== binding.policyVersion ||
            result.outcome !== 'rejected') {
          throw new CliError('invalid_response', 'The recorded rejection did not match the explicit decision binding.');
        }
        dependencies.emit({ event: 'decision_recorded', mode: command.mode, fictional: true, caseId, version: result.proposalVersion, outcome: result.outcome });
      }
      break;
    }
  }
  const wait = await pollCase(client, caseId, command, dependencies);
  const snapshot = await inspectCase(client, caseId);
  ensureMode(snapshot.case, command.mode);
  dependencies.emit(summarizeSnapshot(snapshot, command.mode, wait));
  if (wait === 'expired' || snapshot.case.status === 'needs_attention') return 2;
  if (command.command === 'approve' && snapshot.case.status !== 'credited') return 2;
  if (command.command === 'reject' && snapshot.case.status !== 'rejected') return 2;
  if (command.command === 'start' && pending(snapshot.case.status)) return 2;
  return 0;
}
