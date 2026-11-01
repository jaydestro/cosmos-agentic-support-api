import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CASE_DOC_ID, newCreditResultDoc, proposalDigest, proposalDocId, SYSTEM_ACTOR, type Money } from '../../src/cases/documents.ts';
import { OUTBOX_LIMITS } from '../../src/config/limits.ts';
import { createCreditExecutor } from '../../src/credits/execute.ts';
import { creditKeyFor, PROVIDER_NAME, type ProviderCredit } from '../../src/credits/provider.ts';
import type { ReferenceStore } from '../../src/data/reference.ts';
import { formatMinor } from '../../src/domain/money.ts';
import { claimed } from '../../src/outbox/transitions.ts';
import { newOutboxDoc, outboxId, type OutboxDoc, type OutboxPayload } from '../../src/outbox/types.ts';
import { createMemoryLogger } from '../../src/telemetry/log.ts';
import { newCaseId } from '../support/case-fixtures.ts';
import {
  actors,
  allWork,
  approve,
  awaitingApproval,
  caseOf,
  creditWorkId,
  expectProblem,
  kindsOf,
  messagesOf,
  ok,
  proposalOf,
  recover,
  reject,
  tamper,
  TENANT,
  timelineOf,
  worldWithLaterPolicy,
  type Actors,
  type CreditView,
  type DecisionAcceptedView,
  type Harness,
  type OpenOptions,
  type Pending,
  type RecoverAcceptedView,
  type TimelineView,
} from '../support/decision-flow.ts';
import { as, contract, NOW } from '../support/handler-harness.ts';

const HOUR_MS = 3_600_000;
// Plain letters and digits, so JSON escaping cannot hide it from a substring search.
const MARKER = 'zq4471';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const AMOUNT: Money = { amountMinor: 4900, currency: 'USD' };
const OUTBOX_ID = outboxId('credit.execute', 'v1');

/** Approves the pending proposal and leaves its credit work queued, so a test decides what the executor meets. */
async function approvedCase(who: Actors, options: OpenOptions = {}): Promise<Pending> {
  const pending = await awaitingApproval(who, options);
  ok<DecisionAcceptedView>(await approve(who.approver, pending), 202);
  return pending;
}

const creditOutbox = (who: Actors, caseId: string): OutboxDoc => who.world.memory.doc('outbox', TENANT, caseId, OUTBOX_ID);

const creditOf = async (h: Harness, caseId: string): Promise<CreditView> => ok<CreditView>(await h.call('getCreditResult', { params: { caseId } }));

const noCredit = async (h: Harness, caseId: string): Promise<void> => {
  expectProblem(await h.call('getCreditResult', { params: { caseId } }), 404, 'not_found');
};

const creditItems = async (h: Harness, caseId: string): Promise<TimelineView[]> =>
  (await timelineOf(h, caseId)).filter((item) => item.kind === 'credit_executed' || item.kind === 'credit_reconciled');

const executorFor = (who: Actors) =>
  createCreditExecutor({ cases: who.world.memory.store, reference: who.world.reference.store, provider: who.world.provider, clock: who.world.clock });

/** The structured log entries with this message, from every caller of the world. */
const logged = (who: Actors, message: string): Record<string, unknown>[] =>
  who.lines()
    .map((line) => as<Record<string, unknown>>(JSON.parse(line)))
    .filter((entry) => entry['message'] === message);

const held = (caseId: string, overrides: Partial<ProviderCredit> = {}): ProviderCredit => ({
  key: creditKeyFor(caseId, 1),
  tenantId: TENANT,
  caseId,
  amount: AMOUNT,
  reference: 'sim-held',
  createdAt: NOW.toISOString(),
  ...overrides,
});

const transient = (): Error => Object.assign(new Error('throttled'), { code: 429 });

async function drainTimes(who: Actors, times: number): Promise<string[]> {
  const outcomes: string[] = [];
  for (let round = 0; round < times; round += 1) outcomes.push(...(await who.approver.drain()));
  return outcomes;
}

/** What every refused execution has in common: parked for the operator, nothing credited, the case flagged. */
async function assertParked(who: Actors, caseId: string, code: string, attempts = 1): Promise<void> {
  const outbox = creditOutbox(who, caseId);
  assert.equal(outbox.state, 'poison');
  assert.equal(outbox.attempts, attempts);
  assert.equal(outbox.lastError?.code, code);
  assert.equal((await caseOf(who.representative, caseId)).status, 'needs_attention');

  const parked = (await timelineOf(who.representative, caseId)).at(-1);
  assert.equal(parked?.kind, 'work_poisoned');
  assert.equal(parked.data?.['errorCode'], code);
  await noCredit(who.representative, caseId);

  const [item, ...rest] = await allWork(who.operator, 'poison');
  assert.deepEqual(rest, []);
  assert.equal(item?.workId, creditWorkId(caseId));
  assert.equal(item.lastError?.code, code);
  assert.deepEqual(item.actions, ['requeue']);
}

describe('executing an approved credit', () => {
  it('records one simulated credit in a single batch with the case, the proposal and the outbox item', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    await noCredit(who.representative, caseId);
    assert.equal((await caseOf(who.representative, caseId)).status, 'approved');
    const before = who.world.memory.batches.length;

    assert.deepEqual(await who.approver.drain(), ['completed']);

    const written = who.world.memory.batches.slice(before);
    assert.equal(written.length, 1, 'every local effect commits together');
    assert.deepEqual(
      written[0]?.ops.map((op) => `${op.op}:${op.type}`),
      ['create:credit_result', 'replace:proposal', 'replace:case', 'create:timeline', 'replace:outbox'],
    );

    const [credit, ...others] = who.world.provider.credits();
    assert.ok(credit);
    assert.deepEqual(others, []);
    assert.equal(credit.key, creditKeyFor(caseId, 1));
    assert.equal(credit.tenantId, TENANT);
    assert.equal(credit.caseId, caseId);
    assert.deepEqual(credit.amount, AMOUNT);

    const result = await creditOf(who.representative, caseId);
    assert.deepEqual(contract.validateComponent('CreditResult', result), []);
    assert.deepEqual(result, {
      resultId: `result-${caseId}-v1`,
      caseId,
      proposalVersion: 1,
      amount: AMOUNT,
      simulated: true,
      provider: { name: PROVIDER_NAME, reference: credit.reference, idempotencyKey: creditKeyFor(caseId, 1), reconciled: false },
      recordedAt: who.world.clock.now().toISOString(),
    });

    const detail = await caseOf(who.representative, caseId);
    assert.equal(detail.status, 'credited');
    assert.deepEqual(detail.creditResult, result);
    assert.equal(detail.latestProposal?.status, 'executed');
    const proposal = await proposalOf(who.representative, caseId, 1);
    assert.equal(proposal.status, 'executed');
    assert.equal(proposal.decision?.outcome, 'approved', 'execution does not rewrite the decision');

    const outbox = creditOutbox(who, caseId);
    assert.equal(outbox.state, 'completed');
    assert.equal(outbox.attempts, 1);
    assert.ok(outbox.completedAt);

    const timeline = await timelineOf(who.representative, caseId);
    assert.deepEqual(kindsOf(timeline).slice(-3), ['decision_approved', 'execution_queued', 'credit_executed']);
    const last = timeline.at(-1);
    assert.ok(last);
    assert.deepEqual(last.actor, SYSTEM_ACTOR);
    assert.equal(last.summary, `Simulated credit of ${formatMinor(4900, 'USD')} recorded for proposal v1.`);
    assert.deepEqual(last.data, {
      proposalVersion: 1,
      amountMinor: 4900,
      currency: 'USD',
      resultId: result.resultId,
      provider: PROVIDER_NAME,
      providerReference: credit.reference,
      reconciled: false,
    });
    assert.deepEqual(messagesOf(who.approver.lines).filter((message) => message.startsWith('credit')), ['credit recorded']);
  });

  it('keeps free text out of the logs', async () => {
    const who = actors();
    const pending = await awaitingApproval(who);
    ok<DecisionAcceptedView>(await approve(who.approver, pending, { comment: MARKER }), 202);
    await who.approver.drain();
    const text = who.lines().join('\n');
    assert.ok(!text.includes(MARKER), 'the approver comment is never logged');
    assert.ok(!text.includes('Charged twice'), 'the case description is never logged');
  });

  it('serves the credit to every role of the tenant and to no other tenant', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    await who.approver.drain();
    const expected = await creditOf(who.representative, caseId);
    assert.deepEqual(await creditOf(who.approver, caseId), expected);
    assert.deepEqual(await creditOf(who.operator, caseId), expected);
    await noCredit(who.foreignApprover, caseId);
    await noCredit(who.foreignOperator, caseId);
  });

  it('has no credit to show for a rejected proposal', async () => {
    const who = actors();
    const pending = await awaitingApproval(who);
    ok(await reject(who.approver, pending), 200);
    assert.deepEqual(await who.approver.drain(), []);
    await noCredit(who.representative, pending.caseId);
    assert.equal(who.world.provider.credits().length, 0);
  });

  it('executes an approval whose approval window has long passed, since only waiting proposals expire', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    who.world.clock.advance(100 * HOUR_MS);
    assert.deepEqual(await who.approver.drain(), ['completed']);
    assert.equal((await caseOf(who.representative, caseId)).status, 'credited');
    assert.equal(who.world.provider.credits().length, 1);
  });

  it('honours the policy version the approver saw when a newer one has become effective since', async () => {
    const who = actors({ world: worldWithLaterPolicy('2026-10-30T00:00:00.000Z') });
    const { caseId } = await approvedCase(who);
    who.world.clock.advance(13 * HOUR_MS);
    assert.deepEqual(await who.approver.drain(), ['completed']);
    assert.equal((await proposalOf(who.representative, caseId, 1)).policyRef?.version, 2);
    assert.equal((await caseOf(who.representative, caseId)).status, 'credited');
  });

  it('records the credit for a case that a poison notification had parked as needing attention', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    await tamper(who, caseId, 'case', CASE_DOC_ID, (doc) => {
      doc.status = 'needs_attention';
    });
    assert.deepEqual(await who.approver.drain(), ['completed']);
    assert.equal((await caseOf(who.representative, caseId)).status, 'credited');
  });
});

describe('delivering the same work again', () => {
  it('skips a change that the feed redelivers after the item completed', async () => {
    const who = actors();
    await approvedCase(who);
    const delivered = who.world.memory.outboxDocs().filter((doc) => doc.kind === 'credit.execute');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.state, 'pending');

    assert.deepEqual(await who.approver.drain(), ['completed']);
    assert.deepEqual(await who.approver.processor.processBatch(delivered), ['skipped']);
    assert.equal(who.world.provider.credits().length, 1);
    assert.equal(who.world.provider.calls.issues, 1);
  });

  it('acknowledges a repeated execution without touching the provider or the case again', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    await who.approver.drain();
    const { logger, lines } = createMemoryLogger();
    const calls = { ...who.world.provider.calls };
    const batches = who.world.memory.batches.length;

    await executorFor(who)({ item: creditOutbox(who, caseId), logger, clock: who.world.clock });

    assert.deepEqual(messagesOf(lines), ['credit already recorded']);
    assert.deepEqual(who.world.provider.calls, calls);
    assert.equal(who.world.memory.batches.length, batches);
  });

  it('completes work whose credit is already recorded for the same proposal without calling the provider', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    const stored = newCreditResultDoc({
      tenantId: TENANT,
      caseId,
      proposalVersion: 1,
      amount: AMOUNT,
      provider: { name: PROVIDER_NAME, reference: 'sim-earlier', idempotencyKey: creditKeyFor(caseId, 1), reconciled: false },
      now: NOW,
    });
    await who.world.memory.store.commit(TENANT, caseId, [{ op: 'create', doc: stored }]);

    assert.deepEqual(await who.approver.drain(), ['completed']);
    assert.deepEqual(who.world.provider.calls, { lookups: 0, issues: 0 });
    assert.equal(creditOutbox(who, caseId).state, 'completed');
  });

  it('parks work whose case already holds a credit for another proposal', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    const other = newCreditResultDoc({
      tenantId: TENANT,
      caseId,
      proposalVersion: 2,
      amount: AMOUNT,
      provider: { name: PROVIDER_NAME, reference: 'sim-other', idempotencyKey: creditKeyFor(caseId, 2), reconciled: false },
      now: NOW,
    });
    await who.world.memory.store.commit(TENANT, caseId, [{ op: 'create', doc: other }]);

    assert.deepEqual(await who.approver.drain(), ['poisoned']);
    assert.equal(creditOutbox(who, caseId).lastError?.code, 'credit_conflict');
    assert.deepEqual(who.world.provider.calls, { lookups: 0, issues: 0 });
  });
});

describe('executing concurrently', () => {
  it('records one credit when two executors run the same claimed item at once', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    const { memory, clock, provider } = who.world;
    const queued = await memory.outbox.read(TENANT, caseId, OUTBOX_ID);
    assert.ok(queued?._etag);
    const item = await memory.outbox.replace(claimed(queued, 'worker-a', clock.now(), OUTBOX_LIMITS.claimLeaseMs), queued._etag);
    assert.ok(item);
    const executor = executorFor(who);
    const first = createMemoryLogger();
    const second = createMemoryLogger();

    await Promise.all([executor({ item, logger: first.logger, clock }), executor({ item, logger: second.logger, clock })]);

    const messages = [...messagesOf(first.lines), ...messagesOf(second.lines)].filter((message) => message.startsWith('credit'));
    assert.deepEqual(messages.sort(), ['credit recorded', 'credit recorded by a competing executor']);
    assert.equal(memory.docs(TENANT, caseId, 'credit_result').length, 1);
    assert.equal(provider.credits().length, 1);
    assert.deepEqual(provider.calls, { lookups: 2, issues: 2 });
    assert.equal((await creditItems(who.representative, caseId)).length, 1);
    assert.equal(creditOutbox(who, caseId).state, 'completed');
    assert.equal((await caseOf(who.representative, caseId)).status, 'credited');
  });

  it('lets one worker claim the item while the other leaves it alone', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    const delivered = who.world.memory.outboxDocs().filter((doc) => doc.kind === 'credit.execute');

    const outcomes = await Promise.all([
      who.approver.processorFor('worker-a').processBatch(delivered),
      who.approver.processorFor('worker-b').processBatch(delivered),
    ]);

    assert.deepEqual(outcomes.flat().sort(), ['busy', 'completed']);
    assert.equal(who.world.provider.credits().length, 1);
    assert.equal(who.world.provider.calls.issues, 1);
    assert.equal((await creditItems(who.representative, caseId)).length, 1);
  });
});

describe('reconciling with the provider', () => {
  it('acknowledges a credit the provider already holds instead of issuing another', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    who.world.provider.record(held(caseId));

    assert.deepEqual(await who.approver.drain(), ['completed']);

    assert.equal(who.world.provider.credits().length, 1);
    assert.equal(who.world.provider.calls.issues, 0);
    const result = await creditOf(who.representative, caseId);
    assert.equal(result.provider.reconciled, true);
    assert.equal(result.provider.reference, 'sim-held');
    const [item, ...rest] = await creditItems(who.representative, caseId);
    assert.deepEqual(rest, []);
    assert.equal(item?.kind, 'credit_reconciled');
    assert.equal(item.summary, `Simulated credit of ${formatMinor(4900, 'USD')} was already held by the provider and is now acknowledged for proposal v1.`);
    assert.equal(item.data?.['reconciled'], true);
    assert.equal((await caseOf(who.representative, caseId)).status, 'credited');
  });

  it('reconciles instead of issuing again when the first response was lost', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    who.world.provider.loseNextResponses(1);

    assert.deepEqual(await who.approver.drain(), ['retry_scheduled']);
    assert.equal(who.world.provider.credits().length, 1, 'the provider holds the credit although the executor never heard back');
    assert.equal((await caseOf(who.representative, caseId)).status, 'approved');
    await noCredit(who.representative, caseId);

    assert.deepEqual(await who.approver.drain(), ['completed']);
    assert.equal(who.world.provider.credits().length, 1);
    assert.deepEqual(who.world.provider.calls, { lookups: 2, issues: 1 });
    assert.equal((await creditOf(who.representative, caseId)).provider.reconciled, true);
    assert.deepEqual(kindsOf(await creditItems(who.representative, caseId)), ['credit_reconciled']);
  });

  it('reconciles on the next attempt when the local acknowledgment fails after the provider issued the credit', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    who.world.memory.hooks.beforeCommit = (batch) => {
      if (batch.ops.some((op) => op.type === 'credit_result')) throw transient();
    };

    assert.deepEqual(await who.approver.drain(), ['retry_scheduled']);
    who.world.memory.hooks.beforeCommit = undefined;
    assert.equal(who.world.provider.credits().length, 1, 'the provider already holds the credit');
    await noCredit(who.representative, caseId);
    assert.equal(creditOutbox(who, caseId).lastError?.code, 'dependency_unavailable');

    assert.deepEqual(await who.approver.drain(), ['completed']);
    assert.equal(who.world.provider.credits().length, 1);
    assert.deepEqual(who.world.provider.calls, { lookups: 2, issues: 1 });
    assert.equal((await creditOf(who.representative, caseId)).provider.reconciled, true);
    assert.equal(who.world.memory.docs(TENANT, caseId, 'credit_result').length, 1);
  });

  const CONFLICTING: [string, (caseId: string) => Partial<ProviderCredit>][] = [
    ['another case', () => ({ caseId: newCaseId() })],
    ['another amount', () => ({ amount: { amountMinor: 5000, currency: 'USD' } })],
    ['another currency', () => ({ amount: { amountMinor: 4900, currency: 'EUR' } })],
  ];
  for (const [name, conflict] of CONFLICTING) {
    it(`parks the work instead of acknowledging a credit the provider holds for ${name}`, async () => {
      const who = actors();
      const { caseId } = await approvedCase(who);
      who.world.provider.record(held(caseId, conflict(caseId)));

      assert.deepEqual(await who.approver.drain(), ['poisoned']);

      await assertParked(who, caseId, 'provider_key_conflict');
      assert.deepEqual(who.world.provider.calls, { lookups: 1, issues: 0 });
      assert.equal(who.world.provider.credits().length, 1, 'only the credit that was already there');
    });
  }
});

describe('an unavailable provider', () => {
  it('retries with backoff and issues exactly one credit', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    who.world.provider.failNextIssues(2);
    const started = who.world.clock.now().getTime();

    assert.deepEqual(await who.approver.drain(), ['retry_scheduled']);
    const waiting = creditOutbox(who, caseId);
    assert.equal(waiting.state, 'pending');
    assert.equal(waiting.attempts, 1);
    assert.equal(waiting.lastError?.code, 'provider_unavailable');
    assert.equal((await caseOf(who.representative, caseId)).status, 'approved', 'the case still waits for the credit');
    await noCredit(who.representative, caseId);

    assert.deepEqual(await who.approver.drain(), ['retry_scheduled']);
    assert.deepEqual(await who.approver.drain(), ['completed']);

    const [first = 0, second = 0] = OUTBOX_LIMITS.backoffMs;
    assert.equal(who.world.clock.now().getTime() - started, first + second, 'each retry waited for its backoff');
    assert.equal(who.world.provider.calls.issues, 3);
    assert.equal(who.world.provider.credits().length, 1);
    const done = creditOutbox(who, caseId);
    assert.equal(done.state, 'completed');
    assert.equal(done.attempts, 3);
    assert.equal((await creditOf(who.representative, caseId)).provider.reconciled, false);
  });

  it('parks the work once the attempts are used up and lets an operator requeue it', async () => {
    const who = actors();
    const { caseId } = await approvedCase(who);
    who.world.provider.failNextIssues(OUTBOX_LIMITS.maxAttempts);

    const outcomes = await drainTimes(who, OUTBOX_LIMITS.maxAttempts);
    assert.deepEqual(outcomes, ['retry_scheduled', 'retry_scheduled', 'retry_scheduled', 'retry_scheduled', 'poisoned']);
    await assertParked(who, caseId, 'provider_unavailable', OUTBOX_LIMITS.maxAttempts);
    assert.equal(who.world.provider.credits().length, 0);

    const accepted = ok<RecoverAcceptedView>(await recover(who.operator, creditWorkId(caseId), { action: 'requeue', reason: 'The provider is back.' }), 202);
    assert.deepEqual(accepted, { workId: creditWorkId(caseId), action: 'requeue', state: 'poison', grantNumber: null });
    assert.equal((await caseOf(who.representative, caseId)).status, 'approved', 'the case is restored so the credit can still land');
    assert.equal(creditOutbox(who, caseId).attempts, 0);

    assert.deepEqual(await who.approver.drain(), ['completed']);
    assert.equal(who.world.provider.credits().length, 1);
    assert.equal(who.world.provider.calls.issues, OUTBOX_LIMITS.maxAttempts + 1);
    assert.equal((await caseOf(who.representative, caseId)).status, 'credited');
    const kinds = kindsOf(await timelineOf(who.representative, caseId));
    assert.deepEqual(kinds.slice(-3), ['work_poisoned', 'work_requeued', 'credit_executed']);
  });
});

interface Revalidation {
  readonly name: string;
  readonly guardCode: string;
  readonly arrange: (store: ReferenceStore) => void;
}

const REVALIDATIONS: Revalidation[] = [
  {
    name: 'the account no longer exists',
    guardCode: 'account_unavailable',
    arrange: (store) => {
      store.getAccount = () => Promise.resolve(null);
    },
  },
  {
    name: 'the cited policy version can no longer be read',
    guardCode: 'policy_unavailable',
    arrange: (store) => {
      store.getPolicyDoc = () => Promise.resolve(null);
    },
  },
  {
    name: 'one of the cited invoices no longer exists',
    guardCode: 'kind_mismatch',
    arrange: (store) => {
      const getInvoice = store.getInvoice.bind(store);
      store.getInvoice = (tenantId, invoiceId) => (invoiceId === 'inv_aurora_0001_b' ? Promise.resolve(null) : getInvoice(tenantId, invoiceId));
    },
  },
];

describe('revalidating an approved credit', () => {
  for (const { name, guardCode, arrange } of REVALIDATIONS) {
    it(`refuses to issue the credit when ${name}`, async () => {
      const who = actors();
      const { caseId } = await approvedCase(who);
      arrange(who.world.reference.store);

      assert.deepEqual(await who.approver.drain(), ['poisoned']);

      await assertParked(who, caseId, 'revalidation_failed');
      const [refusal, ...rest] = logged(who, 'credit revalidation refused the approved proposal');
      assert.deepEqual(rest, []);
      assert.equal(refusal?.['guardCode'], guardCode);
      assert.deepEqual(who.world.provider.calls, { lookups: 0, issues: 0 }, 'the provider is never asked');
      assert.equal(who.world.provider.credits().length, 0);
    });
  }
});

interface Tampering {
  readonly name: string;
  readonly code: string;
  readonly arrange: (who: Actors, caseId: string) => Promise<void>;
}

const TAMPERING: Tampering[] = [
  {
    name: 'a proposal that is no longer approved',
    code: 'proposal_not_approved',
    arrange: (who, caseId) =>
      tamper(who, caseId, 'proposal', proposalDocId(1), (doc) => {
        doc.status = 'pending_approval';
      }),
  },
  {
    name: 'a proposal edited after it was approved',
    code: 'proposal_changed',
    arrange: (who, caseId) =>
      tamper(who, caseId, 'proposal', proposalDocId(1), (doc) => {
        doc.explanation = 'Edited after approval.';
      }),
  },
  {
    name: 'a proposal whose stored digest was replaced',
    code: 'proposal_changed',
    arrange: (who, caseId) =>
      tamper(who, caseId, 'proposal', proposalDocId(1), (doc) => {
        doc.digest = `sha256:${'b'.repeat(64)}`;
      }),
  },
  {
    name: 'work bound to another digest than the one approved',
    code: 'proposal_changed',
    arrange: (who, caseId) =>
      tamper(who, caseId, 'outbox', OUTBOX_ID, (doc) => {
        doc.payload = { ...doc.payload, digest: DIGEST };
      }),
  },
  {
    name: 'a decision that records a rejection',
    code: 'decision_mismatch',
    arrange: (who, caseId) =>
      tamper(who, caseId, 'proposal', proposalDocId(1), (doc) => {
        assert.ok(doc.decision);
        doc.decision.outcome = 'rejected';
      }),
  },
  {
    name: 'a decision taken on another policy version',
    code: 'decision_mismatch',
    arrange: (who, caseId) =>
      tamper(who, caseId, 'proposal', proposalDocId(1), (doc) => {
        assert.ok(doc.decision);
        doc.decision.policyVersion = 1;
      }),
  },
  {
    name: 'a decision bound to another digest',
    code: 'decision_mismatch',
    arrange: (who, caseId) =>
      tamper(who, caseId, 'proposal', proposalDocId(1), (doc) => {
        assert.ok(doc.decision);
        doc.decision.proposalDigest = DIGEST;
      }),
  },
  {
    name: 'a proposal with no decision at all',
    code: 'decision_mismatch',
    arrange: (who, caseId) =>
      tamper(who, caseId, 'proposal', proposalDocId(1), (doc) => {
        doc.decision = null;
      }),
  },
  {
    name: 'a credit rewritten to carry no amount, with every digest rewritten to match',
    code: 'proposal_not_executable',
    async arrange(who, caseId) {
      let digest = '';
      await tamper(who, caseId, 'proposal', proposalDocId(1), (doc) => {
        doc.amount = null;
        digest = proposalDigest(doc);
        doc.digest = digest;
        assert.ok(doc.decision);
        doc.decision.proposalDigest = digest;
      });
      await tamper(who, caseId, 'outbox', OUTBOX_ID, (doc) => {
        doc.payload = { ...doc.payload, digest };
      });
    },
  },
];

describe('executing stored state that is not what was approved', () => {
  for (const { name, code, arrange } of TAMPERING) {
    it(`parks the work for ${name} as ${code}`, async () => {
      const who = actors();
      const { caseId } = await approvedCase(who);
      await arrange(who, caseId);

      assert.deepEqual(await who.approver.drain(), ['poisoned']);

      await assertParked(who, caseId, code);
      assert.deepEqual(who.world.provider.calls, { lookups: 0, issues: 0 }, 'nothing reaches the provider');
      assert.equal(who.world.provider.credits().length, 0);
    });
  }

  it('parks work whose case no longer exists', async () => {
    const who = actors();
    const caseId = newCaseId();
    const item = newOutboxDoc({ tenantId: TENANT, caseId, kind: 'credit.execute', key: 'v1', payload: { proposalVersion: 1, digest: DIGEST }, now: NOW });
    assert.equal(await who.world.memory.outbox.create(item), true);

    assert.deepEqual(await who.approver.drain(), ['poisoned']);
    assert.equal(creditOutbox(who, caseId).lastError?.code, 'aggregate_missing');
    assert.deepEqual(who.world.provider.calls, { lookups: 0, issues: 0 });
  });

  const BAD_PAYLOADS: [string, OutboxPayload][] = [
    ['no version and no digest', {}],
    ['a version beyond the revisions a case can have', { proposalVersion: 9, digest: DIGEST }],
    ['a fractional version', { proposalVersion: 1.5, digest: DIGEST }],
    ['a version that is not a number', { proposalVersion: '1', digest: DIGEST }],
    ['no digest', { proposalVersion: 1 }],
    ['a malformed digest', { proposalVersion: 1, digest: 'sha256:nope' }],
  ];
  for (const [name, payload] of BAD_PAYLOADS) {
    it(`parks work with ${name} as an invalid payload`, async () => {
      const who = actors();
      const caseId = newCaseId();
      const item = newOutboxDoc({ tenantId: TENANT, caseId, kind: 'credit.execute', key: 'v1', payload, now: NOW });
      assert.equal(await who.world.memory.outbox.create(item), true);

      assert.deepEqual(await who.approver.drain(), ['poisoned']);
      assert.equal(creditOutbox(who, caseId).lastError?.code, 'invalid_payload');
      assert.deepEqual(who.world.provider.calls, { lookups: 0, issues: 0 });
    });
  }
});
