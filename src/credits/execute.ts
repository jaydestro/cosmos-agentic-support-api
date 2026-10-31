import { guardSubmission, type Lookup, type Retrieved, type Submission } from '../agent/guard.ts';
import type { CaseFacts } from '../agent/adjudicate.ts';
import {
  appendTimeline,
  CASE_DOC_ID,
  CREDIT_RESULT_DOC_ID,
  newCreditResultDoc,
  proposalDigest,
  proposalDocId,
  SYSTEM_ACTOR,
  type CaseDoc,
  type Money,
  type ProposalDoc,
} from '../cases/documents.ts';
import { CaseWriteError, type CaseOp, type CaseStore } from '../cases/store.ts';
import { caseAfter, executedProposal } from '../cases/transitions.ts';
import { CASE_LIMITS } from '../config/limits.ts';
import { toAccount, toInvoice, type Invoice, type Policy } from '../data/documents.ts';
import { isTransientDependencyError } from '../data/errors.ts';
import type { ReferenceStore } from '../data/reference.ts';
import { formatMinor } from '../domain/money.ts';
import { derivePolicies } from '../domain/policy.ts';
import type { Clock } from '../domain/time.ts';
import type { OutboxHandler } from '../outbox/processor.ts';
import { completed } from '../outbox/transitions.ts';
import { PermanentOutboxError, RetryableOutboxError, type OutboxDoc } from '../outbox/types.ts';
import type { Logger } from '../telemetry/log.ts';
import {
  creditKeyFor,
  PROVIDER_NAME,
  ProviderKeyConflictError,
  ProviderUnavailableError,
  type CreditProvider,
  type ProviderCredit,
} from './provider.ts';

export interface CreditExecutorDeps {
  readonly cases: CaseStore;
  readonly reference: Pick<ReferenceStore, 'getAccount' | 'getInvoice' | 'getPolicyDoc'>;
  readonly provider: CreditProvider;
  readonly clock: Clock;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

interface Target {
  readonly version: number;
  readonly digest: string;
}

function parseTarget(item: OutboxDoc): Target {
  const { proposalVersion, digest } = item.payload;
  if (typeof proposalVersion !== 'number' || !Number.isInteger(proposalVersion) || proposalVersion < 1 || proposalVersion > CASE_LIMITS.maxRuns) {
    throw new PermanentOutboxError('invalid_payload', 'The credit work item names no valid proposal version.');
  }
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw new PermanentOutboxError('invalid_payload', 'The credit work item names no valid proposal digest.');
  }
  return { version: proposalVersion, digest };
}

/**
 * What the human approved is exactly what is executed: the stored proposal must still carry the digest
 * the decision and the work item were bound to, and the decision must name that digest and the cited
 * policy version. Anything else means the stored state is not what was approved.
 */
function assertApproved(proposal: ProposalDoc, target: Target): Money {
  if (proposal.status !== 'approved') {
    throw new PermanentOutboxError('proposal_not_approved', `Proposal v${String(proposal.version)} is not approved.`);
  }
  if (proposal.digest !== target.digest || proposalDigest(proposal) !== proposal.digest) {
    throw new PermanentOutboxError('proposal_changed', `Proposal v${String(proposal.version)} no longer matches the digest that was approved.`);
  }
  const { decision } = proposal;
  if (
    decision === null ||
    decision.outcome !== 'approved' ||
    decision.proposalDigest !== target.digest ||
    decision.proposalVersion !== proposal.version ||
    proposal.policyRef === null ||
    decision.policyVersion !== proposal.policyRef.version
  ) {
    throw new PermanentOutboxError('decision_mismatch', `The decision on proposal v${String(proposal.version)} does not match the proposal.`);
  }
  if (proposal.kind !== 'credit' || proposal.amount === null) {
    throw new PermanentOutboxError('proposal_not_executable', `Proposal v${String(proposal.version)} proposes no credit.`);
  }
  return { amountMinor: proposal.amount.amountMinor, currency: proposal.amount.currency };
}

/**
 * Re-runs the submission guard on current reference data, for the policy version the approver saw (a newer
 * version that became effective later does not void an approval already given). The guard is the same code that
 * accepted the proposal, so the credit limits and the evidence rules cannot be weaker here than at proposal time.
 */
async function revalidate(deps: CreditExecutorDeps, tenantId: string, caseDoc: CaseDoc, proposal: ProposalDoc, now: Date, logger: Logger): Promise<void> {
  const { reference } = deps;
  const { policyRef } = proposal;
  if (policyRef === null) throw new PermanentOutboxError('proposal_not_executable', 'The proposal cites no policy.');

  const accountDoc = await reference.getAccount(tenantId, caseDoc.accountId);
  const account: Retrieved['account'] = accountDoc === null ? { status: 'absent' } : { status: 'present', value: toAccount(accountDoc) };

  const invoices: Invoice[] = [];
  const notFound: string[] = [];
  const ids = new Set([...caseDoc.invoiceIds, ...proposal.invoiceRefs.map((ref) => ref.invoiceId)]);
  for (const invoiceId of ids) {
    const doc = await reference.getInvoice(tenantId, invoiceId);
    // An invoice of another account is treated exactly as one that does not exist.
    if (doc === null || doc.accountId !== caseDoc.accountId) notFound.push(invoiceId);
    else invoices.push(toInvoice(doc));
  }

  const policyDoc = await reference.getPolicyDoc(tenantId, policyRef.policyId, policyRef.version);
  const derived: Policy | undefined = policyDoc === null ? undefined : derivePolicies([policyDoc], now)[0];
  const policy: Lookup<Policy> = derived === undefined ? { status: 'absent' } : { status: 'present', value: derived };

  const facts: CaseFacts = {
    category: caseDoc.category,
    invoiceIds: [...caseDoc.invoiceIds],
    requestedCredit: caseDoc.requestedCredit === null ? null : { ...caseDoc.requestedCredit },
  };
  const submission: Submission = {
    kind: proposal.kind,
    amount: proposal.amount === null ? null : { ...proposal.amount },
    note: null,
    invoiceRefs: proposal.invoiceRefs.map((ref) => ({ ...ref })),
    policyRef: { ...policyRef },
    findingCode: proposal.findingCode,
  };
  const verdict = guardSubmission(facts, { account, policy, invoices, notFound }, submission);
  if (!verdict.ok) {
    logger.warn('credit revalidation refused the approved proposal', { proposalVersion: proposal.version, guardCode: verdict.code });
    throw new PermanentOutboxError('revalidation_failed', `The approved credit no longer passes revalidation (${verdict.code}).`);
  }
}

/** Provider failures keep their meaning: a conflict never heals, an unavailable provider is retried. */
async function viaProvider<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProviderKeyConflictError) throw new PermanentOutboxError('provider_key_conflict', error.message);
    if (error instanceof ProviderUnavailableError || isTransientDependencyError(error)) {
      throw new RetryableOutboxError('provider_unavailable', 'The credit provider did not answer.');
    }
    throw error;
  }
}

const sameAmount = (a: Money, b: Money): boolean => a.amountMinor === b.amountMinor && a.currency === b.currency;

interface Settled {
  readonly credit: ProviderCredit;
  /** The provider already held the credit, so this call only acknowledged it. */
  readonly reconciled: boolean;
}

/**
 * Looks before it issues. A credit the provider already holds under the stable key (issued by an earlier
 * attempt whose acknowledgment was lost, or by a competing executor) is acknowledged, never issued again.
 */
async function settleWithProvider(deps: CreditExecutorDeps, tenantId: string, caseId: string, key: string, amount: Money): Promise<Settled> {
  const { provider, clock } = deps;
  const existing = await viaProvider(() => provider.lookup(tenantId, key));
  if (existing !== null) {
    if (existing.caseId !== caseId || !sameAmount(existing.amount, amount)) {
      throw new PermanentOutboxError('provider_key_conflict', 'The provider holds a different credit under this key.');
    }
    return { credit: existing, reconciled: true };
  }
  const issued = await viaProvider(() => provider.issue({ tenantId, caseId, key, amount, now: clock.now() }));
  return { credit: issued.credit, reconciled: !issued.created };
}

/**
 * The only code that records a credit. It runs after a human approved the exact proposal and does not trust
 * the approval blindly: it checks the stored decision and digest, revalidates the evidence and limits, and
 * reconciles with the provider before acknowledging locally.
 *
 * The case, proposal, credit result, timeline items and the outbox completion commit in one ETag-guarded
 * batch, so a crash anywhere leaves either nothing recorded locally (and the next attempt reconciles with the
 * provider) or everything. The provider is outside that transaction; its stable idempotency key is what
 * keeps a repeat from becoming a second credit.
 */
export function createCreditExecutor(deps: CreditExecutorDeps): OutboxHandler {
  const { cases, clock } = deps;

  return async ({ item, logger }) => {
    const { tenantId, caseId } = item;
    const target = parseTarget(item);

    const [existing, caseRow, proposalRow] = await Promise.all([
      cases.get('credit_result', tenantId, caseId, CREDIT_RESULT_DOC_ID),
      cases.get('case', tenantId, caseId, CASE_DOC_ID),
      cases.get('proposal', tenantId, caseId, proposalDocId(target.version)),
    ]);
    if (existing !== null) {
      if (existing.doc.proposalVersion !== target.version) {
        throw new PermanentOutboxError('credit_conflict', 'A credit for another proposal is already recorded for this case.');
      }
      logger.info('credit already recorded', { proposalVersion: target.version });
      return;
    }
    if (caseRow === null || proposalRow === null) throw new PermanentOutboxError('aggregate_missing', 'The case or its proposal no longer exists.');

    const amount = assertApproved(proposalRow.doc, target);
    await revalidate(deps, tenantId, caseRow.doc, proposalRow.doc, clock.now(), logger);

    const key = creditKeyFor(caseId, target.version);
    const { credit, reconciled } = await settleWithProvider(deps, tenantId, caseId, key, amount);

    if (item._etag === undefined) throw new Error('outbox document was handed over without an ETag');
    const now = clock.now();
    const result = newCreditResultDoc({
      tenantId,
      caseId,
      proposalVersion: target.version,
      amount,
      provider: { name: PROVIDER_NAME, reference: credit.reference, idempotencyKey: key, reconciled },
      now,
    });
    const executed = executedProposal(proposalRow.doc);
    const money = formatMinor(amount.amountMinor, amount.currency);
    const { caseDoc, docs } = appendTimeline(
      caseAfter(caseRow.doc, executed, 'credited'),
      [
        {
          kind: reconciled ? 'credit_reconciled' : 'credit_executed',
          actor: SYSTEM_ACTOR,
          summary: reconciled
            ? `Simulated credit of ${money} was already held by the provider and is now acknowledged for proposal v${String(target.version)}.`
            : `Simulated credit of ${money} recorded for proposal v${String(target.version)}.`,
          data: {
            proposalVersion: target.version,
            amountMinor: amount.amountMinor,
            currency: amount.currency,
            resultId: result.resultId,
            provider: PROVIDER_NAME,
            providerReference: credit.reference,
            reconciled,
          },
        },
      ],
      now,
    );
    const ops: CaseOp[] = [
      { op: 'create', doc: result },
      { op: 'replace', doc: executed, etag: proposalRow.etag },
      { op: 'replace', doc: caseDoc, etag: caseRow.etag },
      ...docs.map((doc): CaseOp => ({ op: 'create', doc })),
      { op: 'replace', doc: completed(item, now), etag: item._etag },
    ];

    try {
      await cases.commit(tenantId, caseId, ops);
    } catch (error) {
      if (!(error instanceof CaseWriteError)) throw error;
      if (error.reason === 'missing') throw new PermanentOutboxError('aggregate_missing', 'The case or its proposal no longer exists.');
      // The credit result is the first operation: finding it already there means a competing executor finished.
      if (error.reason === 'exists' && error.index === 0) {
        logger.info('credit recorded by a competing executor', { proposalVersion: target.version });
        return;
      }
      throw new RetryableOutboxError('credit_conflict', 'The case changed while the credit was being recorded.');
    }
    logger.info('credit recorded', { proposalVersion: target.version, reconciled });
  };
}
