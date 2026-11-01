import type { components } from '../../contracts/generated/openapi.d.ts';
import type { RunLimits } from '../config/limits.ts';
import { SCHEMA_VERSION } from '../data/documents.ts';
import { digestOf } from '../domain/canonical.ts';
import { runIdFor, sortKeyOf, workKeyOf } from '../domain/ids.ts';
import { addMs } from '../domain/time.ts';
import type { OutboxDoc } from '../outbox/types.ts';

type Schemas = components['schemas'];

export type Actor = Schemas['Actor'];
export type Allowance = Schemas['Allowance'];
export type ApproveRequest = Schemas['ApproveRequest'];
export type CaseCategory = Schemas['CaseCategory'];
export type CaseStatus = Schemas['CaseStatus'];
export type CaseSummary = Schemas['CaseSummary'];
export type CaseDetail = Schemas['CaseDetail'];
export type CreateCaseRequest = Schemas['CreateCaseRequest'];
export type CreditResult = Schemas['CreditResult'];
export type Decision = Schemas['Decision'];
export type DecisionAccepted = Schemas['DecisionAccepted'];
export type EvidenceAssessment = Schemas['EvidenceAssessment'];
export type FindingCode = Schemas['FindingCode'];
export type InvoiceRef = Schemas['InvoiceRef'];
export type Money = Schemas['Money'];
export type PolicyRef = Schemas['PolicyRef'];
export type Proposal = Schemas['Proposal'];
export type ProposalBrief = Schemas['ProposalBrief'];
export type ProposalKind = Schemas['ProposalKind'];
export type ProposalStatus = Schemas['ProposalStatus'];
export type RecoverAccepted = Schemas['RecoverAccepted'];
export type RecoverRequest = Schemas['RecoverRequest'];
export type RejectRequest = Schemas['RejectRequest'];
export type RevisionRequest = Schemas['RevisionRequest'];
export type Run = Schemas['Run'];
export type RunState = Schemas['RunState'];
export type TimelineItem = Schemas['TimelineItem'];
export type UsageEvent = Schemas['UsageEvent'];
export type UsageQuality = Schemas['UsageQuality'];
export type UsageSummary = Schemas['UsageSummary'];
export type WorkItem = Schemas['WorkItem'];
export type WorkKind = Schemas['WorkKind'];
export type WorkState = Schemas['WorkState'];

/** Partition value of the per-tenant admission document, which belongs to no case. */
export const TENANT_PARTITION = '_tenant';

export const CASE_DOC_ID = 'case';
export const IDEMPOTENCY_DOC_ID = 'idem';
export const ADMISSION_DOC_ID = 'tenant';
/** One credit result per case; its fixed id makes the create-only write the exactly-once guard. */
export const CREDIT_RESULT_DOC_ID = 'credit-result';
/** Keyset cursor for case listings: `<createdAt>~<caseId>`, newest first. */
export const CASE_SORT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~case_[0-9a-f]{32}$/;
/** Keyset cursor for operator work listings: `<createdAt>~<caseId>~<document id>`, newest first. */
export const WORK_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~case_[0-9a-f]{32}~[a-z0-9_-]{1,80}$/;
/** Keyset cursor for timelines and usage events: the last sequence number returned. */
export const SEQ_CURSOR = /^\d{1,9}$/;
export const proposalDocId = (version: number): string => `proposal-${String(version)}`;
export const timelineDocId = (seq: number): string => `tl-${String(seq).padStart(5, '0')}`;
export const usageDocId = (runId: string, seq: number): string => `usage-${runId}-${String(seq).padStart(4, '0')}`;
export const decisionIdFor = (caseId: string, version: number): string => `decision-${caseId}-v${String(version)}`;
export const creditResultIdFor = (caseId: string, version: number): string => `result-${caseId}-v${String(version)}`;

/** Fields shared by every document of the `cases` container. */
export interface PartitionedDoc {
  /** Unique within the `[tenantId, caseId]` logical partition. */
  id: string;
  tenantId: string;
  caseId: string;
  type: string;
  schemaVersion: typeof SCHEMA_VERSION;
}

/**
 * The root of the case aggregate. `latestProposal` and `status` are denormalised so listings need
 * no joins; `nextSeq` allocates timeline sequence numbers inside the same ETag-guarded write.
 */
export interface CaseDoc extends PartitionedDoc {
  type: 'case';
  /** `<createdAt>~<caseId>`; present only on case documents so listings scan nothing else. */
  sortKey: string;
  status: CaseStatus;
  category: CaseCategory;
  accountId: string;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
  /** Number of runs so far; the latest proposal version equals it. */
  revision: number;
  /** Untrusted free text. It is stored and shown as data and never interpreted. */
  description: string;
  invoiceIds: string[];
  requestedCredit: Money | null;
  latestRunId: string;
  latestProposal: ProposalBrief | null;
  nextSeq: number;
}

/**
 * Written once with the case. It keeps the digest of the request and the original response, so a
 * replay is a point read. The idempotency key itself is never stored: the case id derives from it.
 */
export interface IdempotencyDoc extends PartitionedDoc {
  type: 'idempotency';
  requestDigest: string;
  createdAt: string;
  snapshot: { case: CaseSummary; runId: string };
}

export interface RunDoc extends PartitionedDoc {
  type: 'run';
  /** Immutable sort key of the operator work listing; see `workKeyOf`. */
  workKey: string;
  runId: string;
  revision: number;
  mode: Run['mode'];
  state: RunState;
  stopReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  usage: UsageSummary;
  /** Fixed at creation (and changed only by an authorized, recorded allowance), never by configuration. */
  limits: RunLimits;
  allowanceGrants: number;
  /** Budget accounting. `charged` counts unknown or ambiguous calls at their reservation. */
  charged: { tokens: number; costMicroUsd: number };
  reserved: { tokens: number; costMicroUsd: number };
  nextEventSeq: number;
  /** Operator-visible reason of a revision; untrusted data. `null` for the first run. */
  revisionReason: string | null;
}

export interface UsageEventDoc extends PartitionedDoc {
  type: 'usage';
  eventId: string;
  runId: string;
  seq: number;
  kind: UsageEvent['kind'];
  name: string;
  outcome: UsageEvent['outcome'];
  attempt: number;
  at: string;
  inputTokens: number | null;
  outputTokens: number | null;
  tokenQuality: UsageQuality;
  costMicroUsd: number | null;
  costQuality: UsageQuality;
  latencyMs: number | null;
  errorCode: string | null;
  reservedTokens: number;
  reservedCostMicroUsd: number;
}

export interface TimelineDoc extends PartitionedDoc {
  type: 'timeline';
  seq: number;
  at: string;
  kind: string;
  actor: Actor;
  summary: string;
  data?: Record<string, string | number | boolean | null>;
}

/**
 * The immutable proposal content plus its mutable status and decision. `workKey` is stored only, so
 * the operator listing can page waiting approvals; projections list their fields and never carry it.
 */
export type ProposalDoc = PartitionedDoc & { type: 'proposal'; workKey: string } & Proposal;

/**
 * The single recorded effect of an approved credit. Its fixed id is created exactly once per case,
 * so two executors that both reach the end can never both record a result.
 */
export type CreditResultDoc = PartitionedDoc & { type: 'credit_result' } & CreditResult;

/** Names one run's concurrency slot. Deterministic, so a retry asks for the slot it already holds. */
export const runKeyFor = (caseId: string, runId: string): string => `${caseId}:${runId}`;

export interface AdmissionSlot {
  /** `runKeyFor(caseId, runId)` */
  runKey: string;
  since: string;
  until: string;
}

/** Per-tenant counters and slots, in the `[tenantId, '_tenant']` partition. */
export interface AdmissionDoc extends PartitionedDoc {
  type: 'admission';
  /** UTC day the counters belong to; a new day starts new counters. */
  day: string;
  casesToday: number;
  liveCostMicroUsdToday: number;
  slots: AdmissionSlot[];
  updatedAt: string;
}

export type StoredDoc =
  | CaseDoc
  | IdempotencyDoc
  | RunDoc
  | UsageEventDoc
  | TimelineDoc
  | ProposalDoc
  | CreditResultDoc
  | AdmissionDoc
  | OutboxDoc;

export const TERMINAL_RUN_STATES: readonly RunState[] = ['completed', 'failed', 'budget_exhausted', 'blocked'];
export const isTerminalRun = (state: RunState): boolean => TERMINAL_RUN_STATES.includes(state);

export function approvalHasExpired(proposal: Pick<ProposalBrief, 'status' | 'approvalExpiresAt'>, now: Date): boolean {
  return (
    proposal.status === 'pending_approval' &&
    proposal.approvalExpiresAt !== null &&
    Date.parse(proposal.approvalExpiresAt) <= now.getTime()
  );
}

/** Expiry is derived at read time so no timer is needed; writers materialise it when they observe it. */
export function deriveBrief(brief: ProposalBrief | null, now: Date): ProposalBrief | null {
  return brief !== null && approvalHasExpired(brief, now) ? { ...brief, status: 'expired' } : brief;
}

export function derivedStatus(doc: Pick<CaseDoc, 'status' | 'latestProposal'>, now: Date): CaseStatus {
  if (doc.status === 'awaiting_approval' && doc.latestProposal !== null && approvalHasExpired(doc.latestProposal, now)) {
    return 'expired';
  }
  return doc.status;
}

export type CaseSummarySource = Pick<
  CaseDoc,
  'caseId' | 'tenantId' | 'status' | 'category' | 'accountId' | 'createdAt' | 'updatedAt' | 'createdBy' | 'revision' | 'latestProposal'
>;

export function toCaseSummary(doc: CaseSummarySource, now: Date): CaseSummary {
  return {
    caseId: doc.caseId,
    tenantId: doc.tenantId,
    status: derivedStatus(doc, now),
    category: doc.category,
    accountId: doc.accountId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    revision: doc.revision,
    latestProposal: deriveBrief(doc.latestProposal, now),
  };
}

export function toCaseDetail(doc: CaseDoc, latestRun: RunDoc | null, creditResult: CreditResult | null, now: Date): CaseDetail {
  return {
    ...toCaseSummary(doc, now),
    description: doc.description,
    invoiceIds: doc.invoiceIds,
    requestedCredit: doc.requestedCredit,
    latestRun: latestRun === null ? null : toRun(latestRun),
    creditResult,
  };
}

export function toRun(doc: RunDoc): Run {
  return {
    runId: doc.runId,
    caseId: doc.caseId,
    revision: doc.revision,
    mode: doc.mode,
    state: doc.state,
    stopReason: doc.stopReason,
    createdAt: doc.createdAt,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    usage: doc.usage,
    limits: doc.limits,
    allowanceGrants: doc.allowanceGrants,
  };
}

export function toUsageEvent(doc: UsageEventDoc): UsageEvent {
  return {
    eventId: doc.eventId,
    runId: doc.runId,
    seq: doc.seq,
    kind: doc.kind,
    name: doc.name,
    outcome: doc.outcome,
    attempt: doc.attempt,
    at: doc.at,
    inputTokens: doc.inputTokens,
    outputTokens: doc.outputTokens,
    tokenQuality: doc.tokenQuality,
    costMicroUsd: doc.costMicroUsd,
    costQuality: doc.costQuality,
    latencyMs: doc.latencyMs,
    errorCode: doc.errorCode,
  };
}

export function toTimelineItem(doc: TimelineDoc): TimelineItem {
  return {
    seq: doc.seq,
    at: doc.at,
    kind: doc.kind,
    actor: doc.actor,
    summary: doc.summary,
    ...(doc.data === undefined ? {} : { data: doc.data }),
  };
}

export function toProposal(doc: ProposalDoc, now: Date): Proposal {
  return {
    caseId: doc.caseId,
    version: doc.version,
    runId: doc.runId,
    kind: doc.kind,
    status: approvalHasExpired(doc, now) ? 'expired' : doc.status,
    amount: doc.amount,
    explanation: doc.explanation,
    invoiceRefs: doc.invoiceRefs,
    policyRef: doc.policyRef,
    findingCode: doc.findingCode,
    evidenceAssessment: doc.evidenceAssessment,
    digest: doc.digest,
    createdAt: doc.createdAt,
    approvalExpiresAt: doc.approvalExpiresAt,
    decision: doc.decision,
  };
}

export const briefOf = (doc: ProposalDoc): ProposalBrief => ({
  version: doc.version,
  kind: doc.kind,
  status: doc.status,
  amount: doc.amount,
  approvalExpiresAt: doc.approvalExpiresAt,
});

export function toCreditResult(doc: CreditResultDoc): CreditResult {
  return {
    resultId: doc.resultId,
    caseId: doc.caseId,
    proposalVersion: doc.proposalVersion,
    amount: doc.amount,
    simulated: doc.simulated,
    provider: doc.provider,
    recordedAt: doc.recordedAt,
  };
}

export interface NewCreditResult {
  tenantId: string;
  caseId: string;
  proposalVersion: number;
  amount: Money;
  provider: CreditResult['provider'];
  now: Date;
}

export function newCreditResultDoc(input: NewCreditResult): CreditResultDoc {
  return {
    id: CREDIT_RESULT_DOC_ID,
    tenantId: input.tenantId,
    caseId: input.caseId,
    type: 'credit_result',
    schemaVersion: SCHEMA_VERSION,
    resultId: creditResultIdFor(input.caseId, input.proposalVersion),
    proposalVersion: input.proposalVersion,
    amount: { ...input.amount },
    simulated: true,
    provider: { ...input.provider },
    recordedAt: input.now.toISOString(),
  };
}

/** What a proposal says, as the investigation produced it. */
export type ProposalContent = Pick<
  Proposal,
  'kind' | 'amount' | 'explanation' | 'invoiceRefs' | 'policyRef' | 'findingCode' | 'evidenceAssessment'
>;

/**
 * Fingerprint of the proposal a decision applies to. It covers everything an approver reads, including the
 * policy version and clause, and nothing that changes as the proposal is decided (status, decision) or
 * is administrative (creation time, expiry). Arrays are ordered, so the order of `invoiceRefs` matters.
 */
export function proposalDigest(proposal: Pick<Proposal, 'caseId' | 'version' | 'runId'> & ProposalContent): string {
  return digestOf({
    caseId: proposal.caseId,
    version: proposal.version,
    runId: proposal.runId,
    kind: proposal.kind,
    amount: proposal.amount,
    explanation: proposal.explanation,
    invoiceRefs: proposal.invoiceRefs,
    policyRef: proposal.policyRef,
    findingCode: proposal.findingCode,
    evidenceAssessment: proposal.evidenceAssessment,
  });
}

export interface NewProposal {
  tenantId: string;
  caseId: string;
  runId: string;
  /** The revision of the run that produced it: proposal `n` comes from run `n`. */
  version: number;
  content: ProposalContent;
  now: Date;
  approvalTtlMs: number;
}

/**
 * A credit waits for a human (`pending_approval`) until `approvalExpiresAt`; a finding is only reported:
 * it has nothing to approve, so it carries no expiry and no decision. The stored copy shares nothing with `content`.
 */
export function newProposalDoc(input: NewProposal): ProposalDoc {
  const { content } = input;
  const credit = content.kind === 'credit';
  return {
    id: proposalDocId(input.version),
    tenantId: input.tenantId,
    caseId: input.caseId,
    type: 'proposal',
    schemaVersion: SCHEMA_VERSION,
    workKey: workKeyOf(input.now.toISOString(), input.caseId, proposalDocId(input.version)),
    version: input.version,
    runId: input.runId,
    kind: content.kind,
    status: credit ? 'pending_approval' : 'reported',
    amount: content.amount === null ? null : { ...content.amount },
    explanation: content.explanation,
    invoiceRefs: content.invoiceRefs.map((ref) => ({ ...ref })),
    policyRef: content.policyRef === null ? null : { ...content.policyRef },
    findingCode: content.findingCode,
    evidenceAssessment: content.evidenceAssessment,
    digest: proposalDigest({ caseId: input.caseId, version: input.version, runId: input.runId, ...content }),
    createdAt: input.now.toISOString(),
    approvalExpiresAt: credit ? addMs(input.now, input.approvalTtlMs).toISOString() : null,
    decision: null,
  };
}

export interface TimelineDraft {
  kind: string;
  actor: Actor;
  summary: string;
  data?: Record<string, string | number | boolean | null>;
}

/**
 * Allocates consecutive sequence numbers from the case document. The returned case document must be
 * written in the same batch (ETag-guarded) as the returned timeline documents, which is what keeps
 * the sequence gap-free and unique even with competing writers.
 */
export function appendTimeline(
  caseDoc: CaseDoc,
  drafts: readonly TimelineDraft[],
  now: Date,
): { caseDoc: CaseDoc; docs: TimelineDoc[] } {
  const at = now.toISOString();
  const docs = drafts.map(
    (draft, offset): TimelineDoc => ({
      id: timelineDocId(caseDoc.nextSeq + offset),
      tenantId: caseDoc.tenantId,
      caseId: caseDoc.caseId,
      type: 'timeline',
      schemaVersion: SCHEMA_VERSION,
      seq: caseDoc.nextSeq + offset,
      at,
      kind: draft.kind,
      actor: draft.actor,
      summary: draft.summary,
      ...(draft.data === undefined ? {} : { data: draft.data }),
    }),
  );
  return { caseDoc: { ...caseDoc, nextSeq: caseDoc.nextSeq + drafts.length, updatedAt: at }, docs };
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: 'resolve' };
export const AGENT_ACTOR: Actor = { type: 'agent', id: 'investigator' };

/**
 * A demo run makes no API calls, so its token and cost fields are `null` with quality
 * `not_applicable`. A live run starts at a measured zero and later turns estimated or unknown
 * when a call's usage cannot be confirmed: unknown is never reported as zero.
 */
export function initialUsage(mode: Run['mode']): UsageSummary {
  const live = mode === 'live';
  return {
    steps: 0,
    toolCalls: 0,
    modelCalls: 0,
    retries: 0,
    failedCalls: 0,
    ambiguousCalls: 0,
    inputTokens: live ? 0 : null,
    outputTokens: live ? 0 : null,
    tokenQuality: live ? 'measured' : 'not_applicable',
    costMicroUsd: live ? 0 : null,
    costQuality: live ? 'measured' : 'not_applicable',
    activeMs: 0,
  };
}

export interface NewRun {
  tenantId: string;
  caseId: string;
  revision: number;
  mode: Run['mode'];
  limits: RunLimits;
  now: Date;
  revisionReason?: string | null;
}

export function newRunDoc(input: NewRun): RunDoc {
  const at = input.now.toISOString();
  return {
    id: runIdFor(input.revision),
    tenantId: input.tenantId,
    caseId: input.caseId,
    type: 'run',
    schemaVersion: SCHEMA_VERSION,
    workKey: workKeyOf(at, input.caseId, runIdFor(input.revision)),
    runId: runIdFor(input.revision),
    revision: input.revision,
    mode: input.mode,
    state: 'queued',
    stopReason: null,
    createdAt: at,
    startedAt: null,
    finishedAt: null,
    updatedAt: at,
    usage: initialUsage(input.mode),
    limits: { ...input.limits },
    allowanceGrants: 0,
    charged: { tokens: 0, costMicroUsd: 0 },
    reserved: { tokens: 0, costMicroUsd: 0 },
    nextEventSeq: 1,
    revisionReason: input.revisionReason ?? null,
  };
}

export interface NewCase {
  tenantId: string;
  caseId: string;
  createdBy: Actor;
  request: CreateCaseRequest;
  now: Date;
  runId: string;
}

/** A queued case whose first run is `runId`. `nextSeq` starts at 1; the caller appends the first timeline items. */
export function newCaseDoc(input: NewCase): CaseDoc {
  const at = input.now.toISOString();
  return {
    id: CASE_DOC_ID,
    tenantId: input.tenantId,
    caseId: input.caseId,
    type: 'case',
    schemaVersion: SCHEMA_VERSION,
    sortKey: sortKeyOf(at, input.caseId),
    status: 'queued',
    category: input.request.category,
    accountId: input.request.accountId,
    createdAt: at,
    updatedAt: at,
    createdBy: input.createdBy,
    revision: 1,
    description: input.request.description,
    invoiceIds: [...(input.request.invoiceIds ?? [])],
    requestedCredit: input.request.requestedCredit ?? null,
    latestRunId: input.runId,
    latestProposal: null,
    nextSeq: 1,
  };
}

export interface NewIdempotency {
  tenantId: string;
  caseId: string;
  requestDigest: string;
  snapshot: IdempotencyDoc['snapshot'];
  now: Date;
}

export function newIdempotencyDoc(input: NewIdempotency): IdempotencyDoc {
  return {
    id: IDEMPOTENCY_DOC_ID,
    tenantId: input.tenantId,
    caseId: input.caseId,
    type: 'idempotency',
    schemaVersion: SCHEMA_VERSION,
    requestDigest: input.requestDigest,
    createdAt: input.now.toISOString(),
    snapshot: input.snapshot,
  };
}
