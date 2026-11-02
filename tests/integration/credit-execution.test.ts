import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import { createCreditProvider, creditKeyFor, ProviderKeyConflictError } from '../../src/credits/provider.ts';
import type { Api } from '../support/api.ts';
import { approver, docsOfType, operator, representative, TENANT, usd, type DocOfType } from '../support/case-flow.ts';
import { creditFlow, creditOutboxId, expectOk, expectProblem } from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';

/**
 * Executing an approved credit against the simulated provider, with the faults the provider can be told to
 * produce on a local or CI stack, and recovering by hand when the work stops. What counts is the provider's
 * own ledger: one stored credit per approved proposal, however the attempts went.
 */

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;

before(() => {
  stack = readStackConnection();
  api = connectApi(stack);
  cosmos = openEmulator(stack);
});

after(() => {
  cosmos.dispose();
});

const flow = creditFlow(() => ({ stack, api, cosmos }));
const {
  amend,
  approve,
  armFault,
  awaitCase,
  awaitingApproval,
  awaitOutbox,
  awaitWork,
  credited,
  creditOf,
  creditsOf,
  dropFromProvider,
  faultPlanOf,
  holdCredit,
  kindsOf,
  provider,
  readStored,
  recover,
  statusOf,
  storedDocs,
  workIdOf,
} = flow;

const countOf = (kinds: readonly string[], kind: string): number => kinds.filter((candidate) => candidate === kind).length;

describe('reconciling with what the provider already holds', () => {
  it('adopts a credit the provider issued earlier instead of issuing another', { timeout: 240_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId } = pending;
    // As if an earlier attempt had reached the provider and the case never heard back.
    const held = await holdCredit(caseId, 1, usd(4900));

    expectOk(await approve(approver, pending), 202);
    await awaitCase(representative, caseId, 'credited');

    const result = expectOk(await creditOf(representative, caseId), 200);
    assert.equal(result.provider.reconciled, true, 'the result says the credit was found, not issued');
    assert.equal(result.provider.idempotencyKey, held.id);
    assert.equal(result.provider.reference, held.reference);
    assert.deepEqual(result.amount, usd(4900));

    const ledger = await creditsOf(caseId);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.createdAt, held.createdAt, 'the provider record is the one that was already there');

    const kinds = await kindsOf(representative, caseId);
    assert.equal(countOf(kinds, 'credit_reconciled'), 1);
    assert.equal(countOf(kinds, 'credit_executed'), 0);
    assert.equal(docsOfType(await storedDocs(TENANT, caseId), 'credit_result').length, 1);
  });

  it('stops on a credit that does not match, until an operator fixes the ledger and requeues it', { timeout: 300_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId } = pending;
    const wrong = await holdCredit(caseId, 1, usd(100));
    const workId = workIdOf(caseId, creditOutboxId());

    expectOk(await approve(approver, pending), 202);
    const stopped = await awaitWork(operator, 'poison', workId);
    assert.equal(stopped.kind, 'outbox');
    assert.equal(stopped.lastError?.code, 'provider_key_conflict');
    assert.deepEqual(stopped.actions, ['requeue']);
    await awaitCase(representative, caseId, 'needs_attention');
    expectProblem(await creditOf(representative, caseId), 404, 'not_found');
    assert.deepEqual((await creditsOf(caseId)).map((entry) => entry.amount), [usd(100)], 'nothing was added to the ledger');

    const first = expectOk(await recover(operator, workId, { action: 'requeue', reason: 'Trying again before anyone looked.' }), 202);
    assert.equal(first.action, 'requeue');
    assert.equal(first.workId, workId);
    const again = await awaitOutbox(caseId, creditOutboxId(), 'poison');
    assert.equal(again.attempts, 1, 'the requeued item had a fresh attempt, and the same conflict ended it');
    assert.equal(again.lastError?.code, 'provider_key_conflict');
    await awaitCase(representative, caseId, 'needs_attention');

    // An operator removes the record that does not belong to this approval, then requeues.
    await dropFromProvider(wrong.id);
    expectOk(await recover(operator, workId, { action: 'requeue', reason: 'The wrong ledger entry was removed.' }), 202);
    await awaitCase(representative, caseId, 'credited');

    const result = expectOk(await creditOf(representative, caseId), 200);
    assert.deepEqual(result.amount, usd(4900));
    assert.equal(result.provider.reconciled, false);
    assert.deepEqual((await creditsOf(caseId)).map((entry) => entry.amount), [usd(4900)]);

    const kinds = await kindsOf(representative, caseId);
    assert.equal(countOf(kinds, 'work_poisoned'), 2);
    assert.equal(countOf(kinds, 'work_requeued'), 2);
    assert.equal(countOf(kinds, 'credit_executed'), 1);
    assert.equal(docsOfType(await storedDocs(TENANT, caseId), 'credit_result').length, 1);
  });
});

describe('a provider that does not answer', () => {
  it('is retried with backoff and issues one credit once it answers', { timeout: 240_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId } = pending;
    await armFault(caseId, 'unavailable', 2);

    expectOk(await approve(approver, pending), 202);
    await awaitCase(representative, caseId, 'credited');

    const plan = await faultPlanOf(caseId);
    assert.deepEqual({ remaining: plan?.remaining, fired: plan?.fired }, { remaining: 0, fired: 2 }, 'both planned faults happened');
    assert.equal((await creditsOf(caseId)).length, 1);
    const outbox = await readStored<DocOfType<'outbox'>>(TENANT, caseId, creditOutboxId());
    assert.equal(outbox?.state, 'completed');
    assert.equal(outbox?.attempts, 3, 'two failed attempts and the one that worked');
    const result = expectOk(await creditOf(representative, caseId), 200);
    assert.equal(result.provider.reconciled, false);
  });

  it('is given up on after five attempts, and an operator can requeue it for exactly one credit', { timeout: 300_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId } = pending;
    const workId = workIdOf(caseId, creditOutboxId());
    await armFault(caseId, 'unavailable', 5);

    expectOk(await approve(approver, pending), 202);
    const stopped = await awaitWork(operator, 'poison', workId, 120_000);
    assert.equal(stopped.attempts, 5);
    assert.equal(stopped.lastError?.code, 'provider_unavailable');
    await awaitCase(representative, caseId, 'needs_attention');
    assert.equal((await creditsOf(caseId)).length, 0, 'the provider never answered, so nothing was issued');
    const plan = await faultPlanOf(caseId);
    assert.deepEqual({ remaining: plan?.remaining, fired: plan?.fired }, { remaining: 0, fired: 5 });

    expectOk(await recover(operator, workId, { action: 'requeue', reason: 'The provider is reachable again.' }), 202);
    await awaitCase(representative, caseId, 'credited');
    assert.equal((await creditsOf(caseId)).length, 1);
    const outbox = await readStored<DocOfType<'outbox'>>(TENANT, caseId, creditOutboxId());
    assert.equal(outbox?.state, 'completed');
    assert.equal(outbox?.attempts, 1, 'the requeue gave the item a fresh budget of attempts');
    assert.equal(countOf(await kindsOf(representative, caseId), 'credit_executed'), 1);
  });

  it('finds the credit it issued when the answer was lost, instead of issuing another', { timeout: 240_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId } = pending;
    await armFault(caseId, 'lose_response', 1);

    expectOk(await approve(approver, pending), 202);
    await awaitCase(representative, caseId, 'credited');

    const plan = await faultPlanOf(caseId);
    assert.deepEqual({ remaining: plan?.remaining, fired: plan?.fired }, { remaining: 0, fired: 1 });
    const result = expectOk(await creditOf(representative, caseId), 200);
    assert.equal(result.provider.reconciled, true, 'the retry found the credit the first attempt created');
    const ledger = await creditsOf(caseId);
    assert.equal(ledger.length, 1, 'the lost answer did not lead to a second credit');
    assert.equal(ledger[0]?.reference, result.provider.reference);
    const kinds = await kindsOf(representative, caseId);
    assert.equal(countOf(kinds, 'credit_reconciled'), 1);
    assert.equal(countOf(kinds, 'credit_executed'), 0);
    assert.equal((await readStored<DocOfType<'outbox'>>(TENANT, caseId, creditOutboxId()))?.attempts, 2);
  });
});

describe('work that is delivered more than once', () => {
  it('records nothing new when a finished credit is delivered again', { timeout: 240_000 }, async () => {
    const pending = await awaitingApproval();
    const { caseId } = pending;
    const result = await credited(pending);
    const resultDocBefore = await readStored<DocOfType<'credit_result'>>(TENANT, caseId, 'credit-result');
    assert.ok(resultDocBefore);

    // Test-only: marking the finished item pending again stands in for a change feed that delivers it a second time.
    const now = new Date().toISOString();
    await amend<DocOfType<'outbox'>>(caseId, creditOutboxId(), (doc) => ({
      ...doc,
      state: 'pending',
      attempts: 0,
      notBefore: now,
      claimedUntil: null,
      claimedBy: null,
      completedAt: null,
    }));
    const finished = await awaitOutbox(caseId, creditOutboxId(), 'completed');
    assert.equal(finished.attempts, 1, 'the item was claimed and run again');

    assert.equal((await creditsOf(caseId)).length, 1);
    const docs = await storedDocs(TENANT, caseId);
    assert.equal(docsOfType(docs, 'credit_result').length, 1);
    assert.deepEqual(await readStored<DocOfType<'credit_result'>>(TENANT, caseId, 'credit-result'), resultDocBefore, 'the recorded result was not written again');
    assert.equal(countOf(await kindsOf(representative, caseId), 'credit_executed'), 1);
    const again = expectOk(await creditOf(representative, caseId), 200);
    assert.deepEqual(again, result);
    assert.equal(await statusOf(caseId), 'credited');
  });
});

describe('the simulated provider on a real container', () => {
  it('holds one credit however many callers use the same key at once', { timeout: 120_000 }, async () => {
    const credits = createCreditProvider(provider(), { faultsEnabled: false });
    const caseId = `case_${randomBytes(16).toString('hex')}`;
    const key = creditKeyFor(caseId, 1);
    const request = { tenantId: TENANT, caseId, key, amount: usd(1234), now: new Date() };

    assert.equal(await credits.lookup(TENANT, key), null);
    const outcomes = await Promise.all(Array.from({ length: 24 }, () => credits.issue(request)));
    assert.equal(outcomes.filter((outcome) => outcome.created).length, 1, 'exactly one caller created the credit');
    assert.equal(new Set(outcomes.map((outcome) => outcome.credit.reference)).size, 1);
    assert.equal(new Set(outcomes.map((outcome) => outcome.credit.createdAt)).size, 1);
    assert.equal((await creditsOf(caseId)).length, 1);
    assert.deepEqual(await credits.lookup(TENANT, key), outcomes[0]?.credit);

    await assert.rejects(credits.issue({ ...request, amount: usd(1235) }), ProviderKeyConflictError, 'a different amount under the key is a conflict');
    assert.equal((await creditsOf(caseId)).length, 1);
    assert.deepEqual(await credits.lookup(TENANT, key), outcomes[0]?.credit, 'and the conflict changed nothing');
  });

  it('keeps one tenant\'s ledger out of another tenant\'s lookups', { timeout: 120_000 }, async () => {
    const credits = createCreditProvider(provider(), { faultsEnabled: false });
    const caseId = `case_${randomBytes(16).toString('hex')}`;
    const key = creditKeyFor(caseId, 1);
    await credits.issue({ tenantId: TENANT, caseId, key, amount: usd(500), now: new Date() });
    assert.equal(await credits.lookup('borealis', key), null);
    assert.equal((await creditsOf(caseId, 'borealis')).length, 0);
  });
});
