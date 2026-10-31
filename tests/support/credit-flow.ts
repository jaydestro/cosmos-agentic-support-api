import assert from 'node:assert/strict';
import type { Container } from '@azure/cosmos';
import { workIdOf } from '../../src/cases/work.ts';
import type { StoredDoc } from '../../src/cases/documents.ts';
import { creditKeyFor, faultPlanId, type FaultMode } from '../../src/credits/provider.ts';
import { stripSystemFields } from '../../src/data/system.ts';
import { sha256Hex } from '../../src/domain/canonical.ts';
import { identity, identityWithRoles, type Identity } from './api.ts';
import {
  approver,
  caseFlow,
  DUPLICATE,
  newKey,
  pageAll,
  representative,
  TENANT,
  type CaseStatus,
  type CreateCaseRequest,
  type DocOfType,
  type FlowContext,
  type Money,
  type Problem,
  type Proposal,
  type Schemas,
} from './case-flow.ts';
import { waitFor } from './wait.ts';

/**
 * What the decision, execution and recovery tests share on the real stack: the people involved, wrappers over the
 * typed client that keep the status and the problem of a refusal, and direct access to the simulated provider's
 * container and to the stored documents for the few test-only changes (arming a fault, shifting a clock) that
 * no API offers. Fictional data only.
 */

export type Decision = Schemas['Decision'];
export type CreditResult = Schemas['CreditResult'];
export type Run = Schemas['Run'];
export type TimelineItem = Schemas['TimelineItem'];
export type WorkItem = Schemas['WorkItem'];
export type WorkState = Schemas['WorkState'];
export type RecoverRequest = Schemas['RecoverRequest'];

export const approverB = identity('aurora', 'Approver', 'b');
export const approverTwo = identity('aurora', 'Approver', 'c');
export const foreignApprover = identity('borealis', 'Approver');
export const foreignOperator = identity('borealis', 'Operator');
/** Holds the representative and the approver role at once, which is exactly what maker-checker has to refuse. */
export const dual = identityWithRoles('aurora/dual/a', ['Resolve.Representative.aurora', 'Resolve.Approver.aurora'], 'aurora');

export const creditOutboxId = (version = 1): string => `out-credit-execute-v${String(version)}`;
export const REASON = 'Fictional reason zq4471: the credit does not match the contract.';

export interface Pending {
  readonly caseId: string;
  readonly proposal: Proposal;
}

export interface DecisionOverrides {
  version?: number;
  policyVersion?: number;
  proposalDigest?: string;
  comment?: string;
}

export interface Outcome<T> {
  readonly status: number;
  readonly data: T | undefined;
  readonly problem: Problem | undefined;
  readonly headers: Headers;
}

function outcome<T>(result: { data?: T; error?: unknown; response: Response }): Outcome<T> {
  return {
    status: result.response.status,
    data: result.data,
    problem: result.error as Problem | undefined,
    headers: result.response.headers,
  };
}

export function expectProblem(result: Outcome<unknown>, status: number, code: string): void {
  assert.equal(result.status, status, `expected ${String(status)} ${code}, got ${String(result.status)} ${JSON.stringify(result.problem)}`);
  assert.equal(result.problem?.code, code);
}

export function expectOk<T>(result: Outcome<T>, status: number): T {
  assert.equal(result.status, status, `expected ${String(status)}, got ${String(result.status)} ${JSON.stringify(result.problem)}`);
  assert.ok(result.data !== undefined, 'the response carries a body');
  return result.data;
}

export interface ProviderCreditDoc {
  id: string;
  tenantId: string;
  type: 'provider_credit';
  schemaVersion: number;
  caseId: string;
  amount: Money;
  reference: string;
  createdAt: string;
}

export interface FaultPlanDoc {
  id: string;
  tenantId: string;
  type: 'fault_plan';
  mode: FaultMode;
  remaining: number;
  fired: number;
}

const continuation = (token: string | undefined): { continuationToken?: string } => (token === undefined ? {} : { continuationToken: token });

export function creditFlow(context: () => FlowContext) {
  const flow = caseFlow(context);
  const client = (who: Identity | null) => context().api.client(who);
  const database = () => context().cosmos.database(context().stack.database);
  const cases = (): Container => database().container('cases');
  const provider = (): Container => database().container('provider');

  /** A submitted case that has been investigated and now waits for a person. Its investigation work item is finished, so nothing is still writing to the case. */
  async function awaitingApproval(who: Identity = representative, body: CreateCaseRequest = DUPLICATE, label = 'decide'): Promise<Pending> {
    assert.notEqual(who.tenant, 'none', 'the investigation work item is read from the tenant of the caller, so the identity must name one');
    const { accepted } = await flow.createCase(who, newKey(label), body);
    const caseId = accepted.case.caseId;
    await flow.awaitCase(who, caseId, 'awaiting_approval');
    await flow.awaitCompletedOutbox(caseId, who.tenant);
    return { caseId, proposal: await flow.getProposal(who, caseId, 1) };
  }

  const policyVersionOf = (proposal: Proposal): number => {
    assert.ok(proposal.policyRef, 'the proposal cites a policy');
    return proposal.policyRef.version;
  };

  async function approve(who: Identity, pending: Pending, overrides: DecisionOverrides = {}) {
    const { proposal } = pending;
    return outcome(
      await client(who).POST('/cases/{caseId}/proposals/{version}/approve', {
        params: { path: { caseId: pending.caseId, version: overrides.version ?? proposal.version } },
        body: {
          policyVersion: overrides.policyVersion ?? policyVersionOf(proposal),
          proposalDigest: overrides.proposalDigest ?? proposal.digest,
          ...(overrides.comment === undefined ? {} : { comment: overrides.comment }),
        },
      }),
    );
  }

  async function reject(who: Identity, pending: Pending, reason: string, overrides: DecisionOverrides = {}) {
    const { proposal } = pending;
    return outcome(
      await client(who).POST('/cases/{caseId}/proposals/{version}/reject', {
        params: { path: { caseId: pending.caseId, version: overrides.version ?? proposal.version } },
        body: {
          policyVersion: overrides.policyVersion ?? policyVersionOf(proposal),
          proposalDigest: overrides.proposalDigest ?? proposal.digest,
          reason,
        },
      }),
    );
  }

  async function revise(who: Identity, caseId: string, reason: string) {
    return outcome(await client(who).POST('/cases/{caseId}/revisions', { params: { path: { caseId } }, body: { reason } }));
  }

  async function creditOf(who: Identity, caseId: string) {
    return outcome(await client(who).GET('/cases/{caseId}/credit', { params: { path: { caseId } } }));
  }

  async function timelineOf(who: Identity, caseId: string): Promise<TimelineItem[]> {
    return (await flow.timelinePages(who, caseId, 100)).flat();
  }

  const kindsOf = async (who: Identity, caseId: string): Promise<string[]> => (await timelineOf(who, caseId)).map((item) => item.kind);

  /** Waits until the case's credit work item has the given state. */
  function awaitOutbox(caseId: string, id: string, state: DocOfType<'outbox'>['state'], timeoutMs = 60_000): Promise<DocOfType<'outbox'>> {
    return waitFor(
      `${id} of ${caseId} to be ${state}`,
      async () => {
        const doc = await flow.readStored<DocOfType<'outbox'>>(TENANT, caseId, id);
        return doc?.state === state ? doc : undefined;
      },
      { timeoutMs, intervalMs: 250 },
    );
  }

  /** A proposal approved through the API, executed by the trigger, and read back as a credited case. */
  async function credited(pending: Pending, who: Identity = approver): Promise<CreditResult> {
    expectOk(await approve(who, pending), 202);
    await flow.awaitCase(representative, pending.caseId, 'credited');
    return expectOk(await creditOf(representative, pending.caseId), 200);
  }

  async function creditsOf(caseId: string, tenantId = TENANT): Promise<ProviderCreditDoc[]> {
    const { resources } = await provider()
      .items.query<ProviderCreditDoc>(
        { query: "SELECT * FROM c WHERE c.type = 'provider_credit' AND c.caseId = @caseId", parameters: [{ name: '@caseId', value: caseId }] },
        { partitionKey: tenantId },
      )
      .fetchAll();
    return resources;
  }

  /** Puts a credit into the provider's ledger as if an earlier attempt had issued it. */
  async function holdCredit(caseId: string, version: number, amount: Money, overrides: Partial<ProviderCreditDoc> = {}): Promise<ProviderCreditDoc> {
    const key = creditKeyFor(caseId, version);
    const doc: ProviderCreditDoc = {
      id: key,
      tenantId: TENANT,
      type: 'provider_credit',
      schemaVersion: 1,
      caseId,
      amount,
      reference: `sim-${sha256Hex(key).slice(0, 16)}`,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    await provider().items.create(doc);
    return doc;
  }

  const dropFromProvider = async (id: string, tenantId = TENANT): Promise<void> => {
    await provider().item(id, tenantId).delete();
  };

  async function armFault(caseId: string, mode: FaultMode, remaining: number): Promise<void> {
    const plan: FaultPlanDoc = { id: faultPlanId(caseId), tenantId: TENANT, type: 'fault_plan', mode, remaining, fired: 0 };
    await provider().items.create(plan);
  }

  async function faultPlanOf(caseId: string): Promise<FaultPlanDoc | undefined> {
    return (await provider().item(faultPlanId(caseId), TENANT).read<FaultPlanDoc>()).resource;
  }

  /** Test-only: rewrites one stored document with an ETag guard. No API offers this, which is the point. */
  async function amend<T extends StoredDoc>(caseId: string, id: string, change: (doc: T) => T, tenantId = TENANT): Promise<T> {
    const item = cases().item(id, [tenantId, caseId]);
    const read = await item.read<T>();
    assert.ok(read.resource, `${id} exists in ${caseId}`);
    const next = change(stripSystemFields(read.resource));
    await item.replace(next, { accessCondition: { type: 'IfMatch', condition: read.etag } });
    return next;
  }

  /** Test-only: moves the approval deadline of a pending proposal, standing in for the passing of 72 hours. */
  async function shiftApprovalDeadline(caseId: string, version: number, deadline: Date): Promise<void> {
    const iso = deadline.toISOString();
    await amend<DocOfType<'proposal'>>(caseId, `proposal-${String(version)}`, (doc) => ({ ...doc, approvalExpiresAt: iso }));
    await amend<DocOfType<'case'>>(caseId, 'case', (doc) => {
      assert.ok(doc.latestProposal, 'the case carries a latest proposal');
      return { ...doc, latestProposal: { ...doc.latestProposal, approvalExpiresAt: iso } };
    });
  }

  function workPages(who: Identity, state: WorkState, limit: number): Promise<WorkItem[][]> {
    return pageAll(async (token) => {
      const result = await client(who).GET('/operator/work', { params: { query: { state, limit, ...continuation(token) } } });
      assert.equal(result.response.status, 200, JSON.stringify(result.error));
      assert.ok(result.data);
      return result.data;
    });
  }

  const allWork = async (who: Identity, state: WorkState, limit = 50): Promise<WorkItem[]> => (await workPages(who, state, limit)).flat();

  async function inspect(who: Identity, workId: string) {
    return outcome(await client(who).GET('/operator/work/{workId}', { params: { path: { workId } } }));
  }

  async function recover(who: Identity, workId: string, body: RecoverRequest) {
    return outcome(await client(who).POST('/operator/work/{workId}/recover', { params: { path: { workId } }, body }));
  }

  /** Waits until the operator's listing of `state` holds the work item. */
  function awaitWork(who: Identity, state: WorkState, workId: string, timeoutMs = 60_000): Promise<WorkItem> {
    return waitFor(
      `work item ${workId} to be listed as ${state}`,
      async () => (await allWork(who, state)).find((item) => item.workId === workId),
      { timeoutMs, intervalMs: 500 },
    );
  }

  async function statusOf(caseId: string): Promise<CaseStatus> {
    return (await flow.getCase(representative, caseId)).status;
  }

  return {
    ...flow,
    awaitingApproval,
    approve,
    reject,
    revise,
    creditOf,
    timelineOf,
    kindsOf,
    awaitOutbox,
    credited,
    creditsOf,
    holdCredit,
    dropFromProvider,
    armFault,
    faultPlanOf,
    amend,
    shiftApprovalDeadline,
    workPages,
    allWork,
    inspect,
    recover,
    awaitWork,
    statusOf,
    provider,
    cases,
    workIdOf,
  };
}
