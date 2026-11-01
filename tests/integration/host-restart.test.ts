import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import type { Api } from '../support/api.ts';
import { DUPLICATE, OUTBOX_ID, TENANT, caseFlow, docsOfType, newKey, representative, usd } from '../support/case-flow.ts';
import { restartHost } from '../support/control.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';

/**
 * The Functions host is killed while a proposal is waiting for a person. Compute is not held during that wait, so
 * the proposal and everything about the case must live in Cosmos DB alone. The lease of the killed host expires
 * before the new host resumes the change feed, which is why the waits below are generous.
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

const { awaitCase, awaitCompletedOutbox, createCase, etagsOf, getCase, storedDocs } = caseFlow(() => ({ stack, api, cosmos }));

describe('a hard restart of the Functions host while a proposal waits for approval', () => {
  it('keeps the exact pending proposal, rewrites nothing, and goes on investigating new cases', { timeout: 420_000 }, async () => {
    const waiting = await createCase(representative, newKey('restart-wait'));
    const waitingId = waiting.accepted.case.caseId;
    await awaitCase(representative, waitingId, 'awaiting_approval');
    await awaitCompletedOutbox(waitingId);

    const proposalPath = `/api/cases/${waitingId}/proposals/1`;
    const before = await api.get(proposalPath, { as: representative });
    assert.equal(before.status, 200);
    const etagsBefore = await etagsOf(TENANT, waitingId);
    for (const id of ['case', 'idem', 'run-1', 'proposal-1', OUTBOX_ID]) assert.ok(id in etagsBefore, `${id} is stored before the restart`);

    await restartHost();

    const log = await readFile(stack.hostLog, 'utf8');
    assert.ok(log.includes('--- Functions host restarted at'), 'the host log shows that the host was restarted');

    const after = await api.get(proposalPath, { as: representative });
    assert.equal(after.status, 200);
    assert.equal(after.text, before.text, 'the pending proposal is byte for byte the one that was stored');
    const detail = await getCase(representative, waitingId);
    assert.equal(detail.status, 'awaiting_approval');
    assert.equal(detail.latestRun?.state, 'completed');

    // The change feed is read again by the new host, so a new case proves the trigger, the leases and the runner work.
    const next = await createCase(representative, newKey('restart-next'), { ...DUPLICATE, description: 'Created after the host restarted.' });
    const nextId = next.accepted.case.caseId;
    const settled = await awaitCase(representative, nextId, 'awaiting_approval', 150_000);
    assert.deepEqual(settled.latestProposal?.amount, usd(4900));
    await awaitCompletedOutbox(nextId);

    assert.deepEqual(await etagsOf(TENANT, waitingId), etagsBefore, 'no document of the waiting case was written again');
    const docs = await storedDocs(TENANT, waitingId);
    assert.equal(docsOfType(docs, 'outbox')[0]?.attempts, 1, 'the finished investigation was not run a second time');
    assert.equal(docsOfType(docs, 'usage').length, 5);
    assert.equal(docsOfType(docs, 'proposal').length, 1);
  });
});
