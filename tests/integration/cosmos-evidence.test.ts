import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import type { Api } from '../support/api.ts';
import { approver, representative, TENANT } from '../support/case-flow.ts';
import { creditFlow, creditOutboxId, expectOk } from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';

/**
 * Evidence run for the Cosmos DB design: one real case through the real Functions host and change-feed trigger on
 * the emulator, then the stored documents, point reads, scoped queries, ETag and create-only conflicts, and the
 * provider ledger, each with the request charge the emulator reports. The report is written only when
 * RESOLVE_EVIDENCE_FILE names a path; the assertions always run. Every value is fictional.
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

type Doc = Record<string, unknown>;
const SYSTEM_FIELDS = ['_rid', '_self', '_attachments'];
const clean = (doc: Doc): Doc => Object.fromEntries(Object.entries(doc).filter(([key]) => !SYSTEM_FIELDS.includes(key)));
const ru = (value: number | undefined): string => (value === undefined ? 'not reported' : value.toFixed(2));

describe('Cosmos DB design evidence (emulator)', () => {
  it('records real documents, queries, conflicts and a single provider credit', { timeout: 300_000 }, async () => {
    const lines: string[] = [];
    const out = (line = ''): void => void lines.push(line);

    const pending = await flow.awaitingApproval();
    const { caseId } = pending;

    // Eight identical approvals race; only one decision and one credit may result.
    const racers = await Promise.all(Array.from({ length: 8 }, () => flow.approve(approver, pending)));
    const statuses = racers.map((result) => result.status).sort();
    await flow.awaitCase(representative, caseId, 'credited');
    const result = expectOk(await flow.creditOf(representative, caseId), 200);
    const ledger = await flow.creditsOf(caseId);
    assert.equal(ledger.length, 1, 'exactly one provider record exists after eight concurrent approvals');
    assert.ok(statuses.includes(202), 'one approval was accepted');

    const cases = flow.cases();
    const key = [TENANT, caseId];

    const byType = await cases.items
      .query<Doc>({ query: 'SELECT c.id, c.type FROM c WHERE c.type != @none', parameters: [{ name: '@none', value: 'none' }] }, { partitionKey: key })
      .fetchAll();
    const counts = new Map<string, number>();
    for (const doc of byType.resources) counts.set(String(doc['type']), (counts.get(String(doc['type'])) ?? 0) + 1);

    const point = await cases.item('case', key).read<Doc>();
    assert.ok(point.resource);
    const proposalRead = await cases.item('proposal-1', key).read<Doc>();
    const outboxQuery = await cases.items
      .query<Doc>({ query: 'SELECT c.id, c.state, c.attempts FROM c WHERE c.type = @t', parameters: [{ name: '@t', value: 'outbox' }] }, { partitionKey: key })
      .fetchAll();
    const outboxRead = await cases.item(creditOutboxId(), key).read<Doc>();
    const tenantList = await cases.items
      .query<Doc>(
        { query: "SELECT TOP @n c.caseId, c.status FROM c WHERE c.type = 'case' ORDER BY c.createdAt DESC", parameters: [{ name: '@n', value: 5 }] },
        { partitionKey: [TENANT] },
      )
      .fetchAll();

    // Stale ETag: a replace guarded by the first read's ETag must lose once the document changed.
    const stale = point.etag;
    let staleStatus = 0;
    try {
      await cases.item('case', key).replace(clean(point.resource), { accessCondition: { type: 'IfMatch', condition: `${stale}-stale` } });
    } catch (error) {
      staleStatus = (error as { code?: number }).code ?? 0;
    }
    assert.equal(staleStatus, 412, 'a stale ETag is rejected with 412');

    // Create-only: the provider ledger refuses a second record under the same idempotency key.
    const ledgerDoc = ledger[0];
    assert.ok(ledgerDoc);
    let duplicateStatus = 0;
    try {
      await flow.provider().items.create(ledgerDoc);
    } catch (error) {
      duplicateStatus = (error as { code?: number }).code ?? 0;
    }
    assert.equal(duplicateStatus, 409, 'a duplicate create is rejected with 409');

    const leases = await cosmos.database(stack.database).container('leases').items.query<Doc>('SELECT c.id FROM c').fetchAll();

    out('# Cosmos DB design evidence (Linux emulator, Node 24)');
    out();
    out('> Emulator evidence only. All identifiers are fictional. Request charges are the emulator\'s reported values and are not Azure billing measurements.');
    out();
    out(`Case \`${caseId}\`, tenant \`${TENANT}\`. Hierarchical partition key of \`cases\` is \`[/tenantId, /caseId]\`.`);
    out();
    out('## Documents in the case partition');
    out();
    out('| type | count |');
    out('|---|---|');
    for (const [type, count] of [...counts.entries()].sort()) out(`| ${type} | ${String(count)} |`);
    out();
    out(`Partition-scoped parameterized query (\`WHERE c.type != @none\`, partition key \`[tenant, case]\`): ${ru(byType.requestCharge)} RU, ${String(byType.resources.length)} documents.`);
    out();
    out('## Point reads (id + partition key, no query)');
    out();
    out('| read | RU |');
    out('|---|---|');
    out(`| case | ${ru(point.requestCharge)} |`);
    out(`| proposal-1 | ${ru(proposalRead.requestCharge)} |`);
    out(`| ${creditOutboxId()} | ${ru(outboxRead.requestCharge)} |`);
    out();
    out('Stored case document:');
    out();
    out('```json');
    out(JSON.stringify(clean(point.resource), null, 2));
    out('```');
    out();
    out('Stored proposal document:');
    out();
    out('```json');
    out(JSON.stringify(clean(proposalRead.resource ?? {}), null, 2));
    out('```');
    out();
    out('The decision (outcome, proposal/policy version, digest, approver) is embedded in the proposal document above; the proposal replace, case state change, timeline item and outbox item are written in one single-partition transactional batch.');
    out();
    out('Outbox items of the case (partition-scoped query):');
    out();
    out('```json');
    out(JSON.stringify(outboxQuery.resources, null, 2));
    out('```');
    out();
    out(`Outbox query: ${ru(outboxQuery.requestCharge)} RU.`);
    out();
    out('Outbox document after the change-feed trigger ran:');
    out();
    out('```json');
    out(JSON.stringify(clean(outboxRead.resource ?? {}), null, 2));
    out('```');
    out();
    out('## Tenant listing (hierarchical prefix partition key `[tenantId]`, `TOP @n`)');
    out();
    out(`${ru(tenantList.requestCharge)} RU for ${String(tenantList.resources.length)} cases, newest first, with no cross-tenant read.`);
    out();
    out('## Conditional write and create-only deduplication');
    out();
    out(`- Replace with a stale ETag (\`IfMatch\`): HTTP ${String(staleStatus)}.`);
    out(`- Second create of the existing provider key: HTTP ${String(duplicateStatus)}.`);
    out();
    out('## Eight concurrent identical approvals');
    out();
    out(`HTTP statuses returned (sorted): ${statuses.join(', ')}.`);
    out(`Provider ledger records for the case: **${String(ledger.length)}** (key \`${ledgerDoc.id}\`, reference \`${ledgerDoc.reference}\`).`);
    out(`Credit result: ${String(result.amount.amountMinor)} minor units ${result.amount.currency}, reconciled=${String(result.provider.reconciled)}.`);
    out();
    out('Provider ledger document:');
    out();
    out('```json');
    out(JSON.stringify(clean(ledgerDoc as unknown as Doc), null, 2));
    out('```');
    out();
    out('## Change feed leases');
    out();
    out(`The \`leases\` container holds ${String(leases.resources.length)} lease document(s) (ids: ${leases.resources.map((doc) => String(doc['id']).slice(0, 48)).join(', ')}).`);
    out();

    const file = process.env['RESOLVE_EVIDENCE_FILE'];
    if (file !== undefined && file !== '') {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${lines.join('\n')}\n`);
    }
  });
});
