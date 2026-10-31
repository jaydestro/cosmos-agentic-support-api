import assert from 'node:assert/strict';
import type { RoleName } from '../../src/auth/principal.ts';
import type { DocKinds } from '../../src/cases/store.ts';
import { workIdOf } from '../../src/cases/work.ts';
import type { Config } from '../../src/config/env.ts';
import { outboxId } from '../../src/outbox/types.ts';
import { SEED_TENANTS } from '../../tools/seed/data/index.ts';
import { as, BASE_CONFIG, harness, newWorld, PRINCIPAL_ID, type CallOptions, type Reply, type World } from './handler-harness.ts';
import { createMemoryReference } from './memory-reference.ts';

/** Shared setup for the unit tests of decisions, credit execution and operator recovery. */

export type Harness = ReturnType<typeof harness>;

export const TENANT = 'aurora';
export const REPRESENTATIVE_ID = PRINCIPAL_ID;
export const APPROVER_ID = '00000000-0000-4000-8000-0000000000b1';
export const SECOND_APPROVER_ID = '00000000-0000-4000-8000-0000000000b2';
export const OPERATOR_ID = '00000000-0000-4000-8000-0000000000c1';
export const FOREIGN_APPROVER_ID = '00000000-0000-4000-8000-0000000000d1';
export const FOREIGN_OPERATOR_ID = '00000000-0000-4000-8000-0000000000d2';

export const DUPLICATE = {
  accountId: 'acct_aurora_0001',
  category: 'duplicate_charge',
  description: 'Charged twice in September.',
  invoiceIds: ['inv_aurora_0001_a', 'inv_aurora_0001_b'],
  requestedCredit: { amountMinor: 4900, currency: 'USD' },
};

/** Account 0003 has no September invoice, so the investigation reports a finding and proposes no credit. */
export const MISSING_EVIDENCE = {
  accountId: 'acct_aurora_0003',
  category: 'duplicate_charge',
  description: 'Charged twice.',
  invoiceIds: ['inv_aurora_0003_a'],
  requestedCredit: { amountMinor: 5000, currency: 'USD' },
};

export interface Money {
  amountMinor: number;
  currency: string;
}
export interface ActorView {
  type: string;
  id: string;
}
export interface DecisionView {
  decisionId: string;
  caseId: string;
  proposalVersion: number;
  policyVersion: number;
  proposalDigest: string;
  outcome: string;
  reason: string | null;
  decidedBy: ActorView;
  decidedAt: string;
}
export interface PolicyRefView {
  policyId: string;
  version: number;
  clauseId: string;
}
export interface ProposalView {
  caseId: string;
  version: number;
  runId: string;
  kind: string;
  status: string;
  amount: Money | null;
  explanation: string;
  invoiceRefs: { invoiceId: string }[];
  policyRef: PolicyRefView | null;
  findingCode: string | null;
  digest: string;
  createdAt: string;
  approvalExpiresAt: string | null;
  decision: DecisionView | null;
}
export interface UsageView {
  steps: number;
  toolCalls: number;
  modelCalls: number;
  retries: number;
  failedCalls: number;
  activeMs: number;
}
export interface RunView {
  runId: string;
  caseId: string;
  revision: number;
  mode: string;
  state: string;
  stopReason: string | null;
  usage: UsageView;
  limits: Record<string, number>;
  allowanceGrants: number;
}
export interface CreditView {
  resultId: string;
  caseId: string;
  proposalVersion: number;
  amount: Money;
  simulated: boolean;
  provider: { name: string; reference: string; idempotencyKey: string; reconciled: boolean };
  recordedAt: string;
}
export interface CaseDetailView {
  caseId: string;
  tenantId: string;
  status: string;
  revision: number;
  createdBy: ActorView;
  latestProposal: { version: number; kind: string; status: string; amount: Money | null; approvalExpiresAt: string | null } | null;
  latestRun: RunView | null;
  creditResult: CreditView | null;
}
export interface TimelineView {
  seq: number;
  at: string;
  kind: string;
  actor: ActorView;
  summary: string;
  data?: Record<string, unknown>;
}
export interface WorkView {
  workId: string;
  caseId: string;
  kind: string;
  state: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  lastError: { code: string; message: string } | null;
  claimedUntil: string | null;
  usage: UsageView | null;
  actions: string[];
}
export interface DecisionAcceptedView {
  decision: DecisionView;
  caseStatus: string;
}
export interface RecoverAcceptedView {
  workId: string;
  action: string;
  state: string;
  grantNumber: number | null;
}
export interface Page<T> {
  items: T[];
  continuationToken: string | null;
}
export interface Problem {
  status: number;
  code: string;
  title?: string;
  detail?: string;
  errors?: { pointer: string; code: string }[];
}

/** Asserts the status and returns the body, so a failure prints what the API actually said. */
export function ok<T>(reply: Reply, status = 200): T {
  assert.equal(reply.status, status, JSON.stringify(reply.json));
  return as<T>(reply.json);
}

export function expectProblem(reply: Reply, status: number, code: string): Problem {
  assert.equal(reply.status, status, JSON.stringify(reply.json));
  const found = as<Problem>(reply.json);
  assert.equal(found.code, code, JSON.stringify(reply.json));
  return found;
}

export async function readAll<T>(h: Harness, operationId: string, params: Record<string, string>, query: Record<string, string> = {}): Promise<T[]> {
  const items: T[] = [];
  let token: string | null = null;
  do {
    const next: Record<string, string> = token === null ? { ...query } : { ...query, continuationToken: token };
    const page = ok<Page<T>>(await h.call(operationId, { params, query: next }));
    items.push(...page.items);
    token = page.continuationToken;
  } while (token !== null);
  return items;
}

/** One world, one clock and one provider ledger, shared by a caller of every role of the aurora tenant and two of borealis. */
export interface Actors {
  readonly world: World;
  readonly representative: Harness;
  readonly approver: Harness;
  readonly secondApprover: Harness;
  readonly operator: Harness;
  /** The representative's own principal, also holding the Approver role, to prove nobody decides a case they opened. */
  readonly dual: Harness;
  readonly foreignApprover: Harness;
  readonly foreignOperator: Harness;
  nextKey(): string;
  /** Every log line any caller produced, for proving what is never logged. */
  lines(): string[];
}

export interface ActorOptions {
  world?: World;
  now?: Date;
  config?: Partial<Config>;
}

export function actors(options: ActorOptions = {}): Actors {
  const world = options.world ?? newWorld(options.now);
  const config: Partial<Config> = { tenantLimits: { ...BASE_CONFIG.tenantLimits, concurrentRuns: 10 }, ...options.config };
  const make = (tenant: string, principalId: string, roles: RoleName[]): Harness => harness({ world, tenant, principalId, roles, config });
  const representative = make(TENANT, REPRESENTATIVE_ID, ['Representative']);
  const approver = make(TENANT, APPROVER_ID, ['Approver']);
  const secondApprover = make(TENANT, SECOND_APPROVER_ID, ['Approver']);
  const operator = make(TENANT, OPERATOR_ID, ['Operator']);
  const dual = make(TENANT, REPRESENTATIVE_ID, ['Representative', 'Approver']);
  const foreignApprover = make('borealis', FOREIGN_APPROVER_ID, ['Approver']);
  const foreignOperator = make('borealis', FOREIGN_OPERATOR_ID, ['Operator']);
  const everyone = [representative, approver, secondApprover, operator, dual, foreignApprover, foreignOperator];
  let counter = 0;
  return {
    world,
    representative,
    approver,
    secondApprover,
    operator,
    dual,
    foreignApprover,
    foreignOperator,
    nextKey() {
      counter += 1;
      return `key-${counter.toString(16).padStart(16, '0')}`;
    },
    lines: () => everyone.flatMap((member) => member.lines),
  };
}

export const caseOf = async (h: Harness, caseId: string): Promise<CaseDetailView> => ok<CaseDetailView>(await h.call('getCase', { params: { caseId } }));

export const proposalOf = async (h: Harness, caseId: string, version: number): Promise<ProposalView> =>
  ok<ProposalView>(await h.call('getProposal', { params: { caseId, version: String(version) } }));

export const timelineOf = (h: Harness, caseId: string): Promise<TimelineView[]> => readAll<TimelineView>(h, 'getCaseTimeline', { caseId });

export const kindsOf = (items: readonly TimelineView[]): string[] => items.map((item) => item.kind);

export interface Pending {
  caseId: string;
  proposal: ProposalView;
}

export interface OpenOptions {
  key?: string;
  body?: unknown;
}

export async function openCase(who: Actors, options: OpenOptions = {}): Promise<string> {
  const reply = await who.representative.call('createCase', {
    headers: { 'Idempotency-Key': options.key ?? who.nextKey() },
    body: options.body ?? DUPLICATE,
  });
  return ok<{ case: { caseId: string } }>(reply, 202).case.caseId;
}

/** Opens a case and runs its investigation until the proposal waits for a human. */
export async function awaitingApproval(who: Actors, options: OpenOptions = {}): Promise<Pending> {
  const caseId = await openCase(who, options);
  await who.representative.drain();
  const detail = await caseOf(who.representative, caseId);
  assert.equal(detail.status, 'awaiting_approval');
  const proposal = await proposalOf(who.representative, caseId, detail.revision);
  assert.equal(proposal.status, 'pending_approval');
  return { caseId, proposal };
}

export interface DecisionOverrides {
  version?: number;
  policyVersion?: number;
  proposalDigest?: string;
}

function cited(proposal: ProposalView): number {
  assert.ok(proposal.policyRef, 'the proposal cites a policy');
  return proposal.policyRef.version;
}

export function approve(h: Harness, pending: Pending, overrides: DecisionOverrides & { comment?: string } = {}): Promise<Reply> {
  const { version = pending.proposal.version, ...rest } = overrides;
  return h.call('approveProposal', {
    params: { caseId: pending.caseId, version: String(version) },
    body: { policyVersion: cited(pending.proposal), proposalDigest: pending.proposal.digest, ...rest },
  });
}

export function reject(h: Harness, pending: Pending, reason = 'The two charges are for different seats.', overrides: DecisionOverrides = {}): Promise<Reply> {
  const { version = pending.proposal.version, ...rest } = overrides;
  return h.call('rejectProposal', {
    params: { caseId: pending.caseId, version: String(version) },
    body: { policyVersion: cited(pending.proposal), proposalDigest: pending.proposal.digest, reason, ...rest },
  });
}

export function revise(h: Harness, caseId: string, reason = 'Please look at the second invoice again.'): Promise<Reply> {
  return h.call('requestRevision', { params: { caseId }, body: { reason } });
}

/** Approves the pending proposal and delivers its outbox work, which issues the credit. */
export async function creditedCase(who: Actors, options: OpenOptions = {}): Promise<Pending> {
  const pending = await awaitingApproval(who, options);
  ok<DecisionAcceptedView>(await approve(who.approver, pending), 202);
  await who.approver.drain();
  return pending;
}

export const creditWorkId = (caseId: string, version = 1): string => workIdOf(caseId, outboxId('credit.execute', `v${String(version)}`));
export const investigationWorkId = (caseId: string, runId = 'run-1'): string => workIdOf(caseId, outboxId('investigation.start', runId));
export const proposalWorkId = (caseId: string, version = 1): string => workIdOf(caseId, `proposal-${String(version)}`);
export const runWorkId = (caseId: string, runId = 'run-1'): string => workIdOf(caseId, runId);

export const listWork = (h: Harness, state: string, query: Record<string, string> = {}): Promise<Reply> => h.call('listOperatorWork', { query: { state, ...query } });
export const allWork = (h: Harness, state: string): Promise<WorkView[]> => readAll<WorkView>(h, 'listOperatorWork', {}, { state });
export const inspectWork = (h: Harness, workId: string): Promise<Reply> => h.call('getOperatorWorkItem', { params: { workId } });
export const recover = (h: Harness, workId: string, body: CallOptions['body']): Promise<Reply> => h.call('recoverWorkItem', { params: { workId }, body });

/** The message of every log line, so a test can count events without matching free text. */
export const messagesOf = (lines: readonly string[]): string[] => lines.map((line) => as<{ message: string }>(JSON.parse(line)).message);

/**
 * Rewrites one stored document as a repair, a fault or an attacker with data access would. It proves what the
 * code does when stored state is not what it expects; the API itself offers no way to produce such a state.
 */
export async function tamper<K extends keyof DocKinds>(
  who: Actors,
  caseId: string,
  kind: K,
  id: string,
  change: (doc: DocKinds[K]) => void,
): Promise<void> {
  const row = await who.world.memory.store.get(kind, TENANT, caseId, id);
  assert.ok(row, `${kind} ${id} exists`);
  change(row.doc);
  await who.world.memory.store.commit(TENANT, caseId, [{ op: 'replace', doc: row.doc, etag: row.etag }]);
}

/** A world whose aurora policy gains version 3, a copy of version 2 that only takes effect at `effectiveFrom`. */
export function worldWithLaterPolicy(effectiveFrom: string): World {
  const aurora = SEED_TENANTS.find((tenant) => tenant.tenantId === TENANT);
  assert.ok(aurora);
  const cited = aurora.policies.find((policy) => policy.policyId === 'credit-policy' && policy.version === 2);
  assert.ok(cited);
  const seeds = SEED_TENANTS.map((tenant) =>
    tenant.tenantId === TENANT ? { ...tenant, policies: [...tenant.policies, { ...cited, version: 3, effectiveFrom }] } : tenant,
  );
  return { ...newWorld(), reference: createMemoryReference(seeds) };
}
