import { randomBytes } from 'node:crypto';
import {
  newCaseDoc,
  newRunDoc,
  proposalDigest,
  proposalDocId,
  usageDocId,
  type CaseDoc,
  type ProposalDoc,
  type RunDoc,
  type TimelineDoc,
  type UsageEventDoc,
} from '../../src/cases/documents.ts';
import { BASE_RUN_LIMITS } from '../../src/config/limits.ts';
import { SCHEMA_VERSION } from '../../src/data/documents.ts';
import { workKeyOf } from '../../src/domain/ids.ts';

export const newCaseId = (): string => `case_${randomBytes(16).toString('hex')}`;
export const uniqueTenant = (prefix = 'fixture'): string => `${prefix}-${randomBytes(5).toString('hex')}`;

export const AT = '2026-03-01T10:00:00.000Z';

export function sampleCase(tenantId: string, caseId: string, overrides: Partial<CaseDoc> = {}, at: string = AT): CaseDoc {
  const doc = newCaseDoc({
    tenantId,
    caseId,
    createdBy: { type: 'user', id: 'user-1' },
    request: { accountId: 'acct_aurora_0001', category: 'duplicate_charge', description: 'Charged twice in March.' },
    now: new Date(at),
    runId: 'run-1',
  });
  return { ...doc, ...overrides };
}

export function sampleRun(tenantId: string, caseId: string, revision = 1, overrides: Partial<RunDoc> = {}): RunDoc {
  return { ...newRunDoc({ tenantId, caseId, revision, mode: 'demo', limits: BASE_RUN_LIMITS, now: new Date(AT) }), ...overrides };
}

export function sampleTimeline(tenantId: string, caseId: string, seq: number, overrides: Partial<TimelineDoc> = {}): TimelineDoc {
  return {
    id: `tl-${String(seq).padStart(5, '0')}`,
    tenantId,
    caseId,
    type: 'timeline',
    schemaVersion: SCHEMA_VERSION,
    seq,
    at: AT,
    kind: 'tool_called',
    actor: { type: 'agent', id: 'investigator' },
    summary: `step ${String(seq)}`,
    ...overrides,
  };
}

export function sampleUsage(tenantId: string, caseId: string, runId: string, seq: number, overrides: Partial<UsageEventDoc> = {}): UsageEventDoc {
  return {
    id: usageDocId(runId, seq),
    tenantId,
    caseId,
    type: 'usage',
    schemaVersion: SCHEMA_VERSION,
    eventId: `${runId}-${String(seq)}`,
    runId,
    seq,
    kind: 'tool',
    name: 'get_account',
    outcome: 'succeeded',
    attempt: 1,
    at: AT,
    inputTokens: null,
    outputTokens: null,
    tokenQuality: 'not_applicable',
    costMicroUsd: null,
    costQuality: 'not_applicable',
    latencyMs: 1,
    errorCode: null,
    reservedTokens: 0,
    reservedCostMicroUsd: 0,
    ...overrides,
  };
}

export function sampleProposal(tenantId: string, caseId: string, version = 1, overrides: Partial<ProposalDoc> = {}): ProposalDoc {
  const content = {
    caseId,
    version,
    runId: `run-${String(version)}`,
    kind: 'credit' as const,
    amount: { amountMinor: 4900, currency: 'USD' as const },
    explanation: 'Two paid invoices cover the same period.',
    invoiceRefs: [{ invoiceId: 'inv_aurora_0001_b', lineIndex: null }],
    policyRef: { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' },
    findingCode: null,
    evidenceAssessment: 'consistent' as const,
  };
  return {
    id: proposalDocId(version),
    tenantId,
    type: 'proposal',
    schemaVersion: SCHEMA_VERSION,
    workKey: workKeyOf(AT, caseId, proposalDocId(version)),
    ...content,
    status: 'pending_approval',
    digest: proposalDigest(content),
    createdAt: AT,
    approvalExpiresAt: '2026-03-04T10:00:00.000Z',
    decision: null,
    ...overrides,
  };
}
