import { BASE_RUN_LIMITS } from '../../src/config/limits.ts';
import type {
  CaseDetail,
  CreditResult,
  Money,
  Proposal,
  ProposalBrief,
  Role,
  Run,
  RunLimits,
  Session,
  UsageSummary,
} from '../../web/src/types.ts';

/** Fictional identifiers for console unit tests. Nothing here is real data. */
export const CASE_ID = 'case_00000000000000000000000000000001';
export const REPRESENTATIVE_ID = 'a1000000-0000-4000-8000-0000000000a1';
export const APPROVER_ID = 'a2000000-0000-4000-8000-0000000000a2';
export const DIGEST = `sha256:${'ab'.repeat(32)}`;

export const usd = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

export interface SessionOptions {
  readonly principalId?: string;
  readonly tenantId?: string;
  readonly roles?: Role[];
  readonly environment?: Partial<Session['environment']>;
}

export function session(options: SessionOptions = {}): Session {
  return {
    principal: {
      principalId: options.principalId ?? APPROVER_ID,
      tenantId: options.tenantId ?? 'aurora',
      roles: options.roles ?? ['Approver'],
    },
    environment: {
      agentMode: 'demo',
      liveAvailable: false,
      liveBlockedReason: null,
      simulatedCredits: true,
      apiVersion: '1.0.0',
      ...options.environment,
    },
  };
}

export function usage(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    steps: 5,
    toolCalls: 5,
    modelCalls: 0,
    retries: 0,
    failedCalls: 0,
    ambiguousCalls: 0,
    inputTokens: null,
    outputTokens: null,
    tokenQuality: 'not_applicable',
    costMicroUsd: null,
    costQuality: 'not_applicable',
    activeMs: 1200,
    ...overrides,
  };
}

export function limits(overrides: Partial<RunLimits> = {}): RunLimits {
  return { ...BASE_RUN_LIMITS, ...overrides };
}

export function run(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    caseId: CASE_ID,
    revision: 1,
    mode: 'demo',
    state: 'completed',
    stopReason: null,
    createdAt: '2026-10-29T09:00:00.000Z',
    startedAt: '2026-10-29T09:00:01.000Z',
    finishedAt: '2026-10-29T09:00:03.000Z',
    usage: usage(),
    limits: limits(),
    allowanceGrants: 0,
    ...overrides,
  };
}

export function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    caseId: CASE_ID,
    version: 1,
    runId: 'run-1',
    kind: 'credit',
    status: 'pending_approval',
    amount: usd(4900),
    explanation: 'Fictional duplicate charge on two August invoices.',
    invoiceRefs: [{ invoiceId: 'inv_aurora_0001_b', lineIndex: 0 }],
    policyRef: { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' },
    findingCode: null,
    evidenceAssessment: 'consistent',
    digest: DIGEST,
    createdAt: '2026-10-29T09:00:03.000Z',
    approvalExpiresAt: '2026-11-01T09:00:03.000Z',
    decision: null,
    ...overrides,
  };
}

/** The summary of a proposal as it appears inside a case. */
export function briefOf(source: Proposal): ProposalBrief {
  return {
    version: source.version,
    kind: source.kind,
    status: source.status,
    amount: source.amount,
    approvalExpiresAt: source.approvalExpiresAt,
  };
}

export function caseDetail(overrides: Partial<CaseDetail> = {}): CaseDetail {
  return {
    caseId: CASE_ID,
    tenantId: 'aurora',
    status: 'awaiting_approval',
    category: 'duplicate_charge',
    accountId: 'acct_aurora_0001',
    createdAt: '2026-10-29T09:00:00.000Z',
    updatedAt: '2026-10-29T09:00:03.000Z',
    createdBy: { type: 'user', id: REPRESENTATIVE_ID },
    revision: 1,
    latestProposal: briefOf(proposal()),
    description: 'Fictional dispute: two charges for the same August invoice.',
    invoiceIds: ['inv_aurora_0001_a', 'inv_aurora_0001_b'],
    requestedCredit: null,
    latestRun: run(),
    creditResult: null,
    ...overrides,
  };
}

export function creditResult(overrides: Partial<CreditResult> = {}): CreditResult {
  return {
    resultId: 'result-1',
    caseId: CASE_ID,
    proposalVersion: 1,
    amount: usd(4900),
    simulated: true,
    provider: { name: 'simulated-provider', reference: 'sim-ref-0001', idempotencyKey: 'idem-0001', reconciled: false },
    recordedAt: '2026-10-29T09:05:00.000Z',
    ...overrides,
  };
}
