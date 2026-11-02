import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import { CliError, type CommonOptions } from '../../tools/demo/args.ts';
import { inspectCase, runJourney } from '../../tools/demo/journey.ts';
import { identity, type Api } from '../support/api.ts';
import { newKey, TENANT, usd } from '../support/case-flow.ts';
import { creditFlow, creditOutboxId } from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';

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
const maker = identity(TENANT, 'Representative', 'demo-cli-maker');
const checker = identity(TENANT, 'Approver', 'demo-cli-checker');

it('CLI demo journey uses the real HTTP host, durable approval and exactly one simulated provider credit', { timeout: 180_000 }, async () => {
  assert.notEqual(maker.claims.oid, checker.claims.oid);
  // Only authentication comes from the existing test IDP. The host, investigation
  // trigger, Cosmos storage and provider ledger are real services, not fetch fakes.
  // HTTP is confined to the local test stack; production CLI HTTPS validation is unchanged.
  const representativeClient = api.client(maker);
  const approverClient = api.client(checker);
  for (const client of [representativeClient, approverClient]) {
    client.use({
      onRequest({ request }) {
        return new Request(request, {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
          redirect: 'error',
        });
      },
    });
  }
  const common: CommonOptions = {
    baseUrl: `${stack.apiUrl}/api`,
    scope: 'api://resolve-local-test/.default',
    mode: 'demo',
    timeoutMs: 15_000,
    waitMs: 60_000,
    pollMs: 500,
  };
  const idempotencyKey = newKey('demo-cli');
  const output: unknown[] = [];
  const dependencies = { emit: (value: unknown) => { output.push(value); } };

  await assert.rejects(
    runJourney({ ...common, command: 'start', mode: 'live', idempotencyKey }, representativeClient, dependencies),
    (error: unknown) => error instanceof CliError && error.code === 'mode_mismatch',
  );
  assert.equal(output.length, 0, 'demo host is never presented as live inference');
  assert.equal(await runJourney({ ...common, command: 'start', idempotencyKey }, representativeClient, dependencies), 0);
  const accepted = output.find((value): value is { event: 'case_accepted'; caseId: string } =>
    typeof value === 'object' && value !== null && 'event' in value && value.event === 'case_accepted' &&
    'caseId' in value && typeof value.caseId === 'string');
  assert.ok(accepted, 'the CLI reports the actual accepted case ID');
  const { caseId } = accepted;

  assert.equal(await runJourney({ ...common, command: 'inspect', caseId, waitMs: 0 }, representativeClient, dependencies), 0);
  const pending = await inspectCase(representativeClient, caseId);
  assert.equal(pending.case.status, 'awaiting_approval');
  assert.equal(pending.case.createdBy.id, maker.claims.oid);
  assert.equal(pending.case.latestRun?.mode, 'demo');
  assert.equal(pending.runs[0]?.state, 'completed');
  assert.equal(pending.runs[0]?.usage.modelCalls, 0, 'deterministic demo is not live inference');
  assert.equal(pending.runs[0]?.usage.tokenQuality, 'not_applicable');
  assert.equal(pending.credit, null);
  assert.equal((await flow.creditsOf(caseId)).length, 0, 'start and inspect never approve automatically');
  const proposal = pending.proposals[0];
  assert.ok(proposal);
  assert.equal(proposal.version, 1);
  assert.equal(proposal.status, 'pending_approval');
  assert.ok(proposal.policyRef);
  assert.deepEqual(proposal.amount, usd(4900));

  const approval = { ...common, command: 'approve' as const, caseId, version: proposal.version, comment: 'Fictional duplicate invoices checked.' };
  await assert.rejects(
    runJourney(approval, representativeClient, dependencies),
    (error: unknown) => error instanceof CliError && error.code === 'http_403',
  );
  await assert.rejects(
    runJourney({ ...approval, version: proposal.version + 1 }, approverClient, dependencies),
    (error: unknown) => error instanceof CliError && error.code === 'stale_version',
  );
  const refused = await inspectCase(representativeClient, caseId);
  assert.equal(refused.case.status, 'awaiting_approval');
  assert.equal(refused.proposals[0]?.decision, null);
  assert.equal((await flow.creditsOf(caseId)).length, 0, 'unauthorized or stale decisions have no provider effect');

  assert.equal(await runJourney(approval, approverClient, dependencies), 0);
  await flow.awaitOutbox(caseId, creditOutboxId(proposal.version), 'completed');
  const completed = await inspectCase(representativeClient, caseId);
  assert.equal(completed.case.status, 'credited');
  const recorded = completed.proposals[0]?.decision;
  assert.ok(recorded);
  assert.equal(recorded.outcome, 'approved');
  assert.equal(recorded.decidedBy.id, checker.claims.oid);
  assert.equal(recorded.proposalVersion, proposal.version);
  assert.equal(recorded.proposalDigest, proposal.digest);
  assert.equal(recorded.policyVersion, proposal.policyRef.version);
  assert.ok(completed.credit);
  assert.equal(completed.credit.simulated, true);
  assert.equal(completed.credit.proposalVersion, proposal.version);
  assert.deepEqual(completed.credit.amount, usd(4900));
  const ledger = await flow.creditsOf(caseId);
  assert.equal(ledger.length, 1, 'the actual provider container contains exactly one record');
  assert.equal(ledger[0]?.id, completed.credit.provider.idempotencyKey);
  assert.equal(ledger[0]?.reference, completed.credit.provider.reference);
  assert.deepEqual(ledger[0]?.amount, completed.credit.amount);
  const timeline = completed.timeline;
  assert.ok(timeline.every((item, index) => index === 0 || item.seq > (timeline[index - 1]?.seq ?? 0)));
  assert.equal(timeline.filter((item) => item.kind === 'decision_approved').length, 1);
  assert.equal(timeline.filter((item) => item.kind === 'credit_executed').length, 1);
  assert.ok(completed.usage[0]?.events.length);
  const printed = output.map((value) => JSON.stringify(value)).join('\n');
  assert.match(printed, /"mode":"demo"/);
  assert.doesNotMatch(printed, /"mode":"live"/);
  assert.ok(!printed.includes(String(maker.claims.oid)) && !printed.includes(String(checker.claims.oid)));
});
