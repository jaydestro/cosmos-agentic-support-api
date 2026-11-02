// Azure proof driver. Runs inside the virtual network (Azure Container Instance) with the application's
// managed identity and calls the real handlers, services and Cosmos DB data plane in-process. It exposes no
// endpoint. The deployed Functions host's change-feed trigger does the investigation and the credit execution.
// The principals are synthetic; real Entra token checks are recorded separately by the caller.
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { CosmosClient } from '@azure/cosmos';
import { ManagedIdentityCredential } from '@azure/identity';
import type { Authenticator } from '../../src/auth/verify.ts';
import type { Principal } from '../../src/auth/principal.ts';
import { loadConfig } from '../../src/config/env.ts';
import { handlers } from '../../src/handlers/index.ts';
import { createPipeline, type RawRequest } from '../../src/http/pipeline.ts';
import { createServices } from '../../src/services.ts';
import { createLogger } from '../../src/telemetry/log.ts';

const principals: Record<string, Principal> = {
  rep: { principalId: randomUUID(), tenantId: 'aurora', roles: ['Representative'] },
  approver: { principalId: randomUUID(), tenantId: 'aurora', roles: ['Approver'] },
  approver2: { principalId: randomUUID(), tenantId: 'aurora', roles: ['Approver'] },
  operator: { principalId: randomUUID(), tenantId: 'aurora', roles: ['Operator'] },
  borealisRep: { principalId: randomUUID(), tenantId: 'borealis', roles: ['Representative'] },
};

const authenticator: Authenticator = {
  authenticate(authorization) {
    const principal = principals[authorization?.replace(/^Bearer /, '') ?? ''];
    return principal === undefined ? Promise.reject(new Error('no such synthetic principal')) : Promise.resolve(principal);
  },
};

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const ru = (value: number | undefined): string => (value === undefined ? 'not reported' : value.toFixed(2));
const strip = (doc: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(doc).filter(([name]) => !name.startsWith('_')));
const codeOf = (error: unknown): number => {
  const { statusCode, code } = error as { statusCode?: number; code?: number | string };
  return statusCode ?? (typeof code === 'number' ? code : 0);
};

const config = loadConfig(process.env);
const services = createServices(config, createLogger(() => undefined, {}), { authenticator });
const pipeline = createPipeline(services);

interface Reply {
  status: number;
  body: Record<string, unknown> | undefined;
}

async function call(
  operationId: string,
  as: string,
  options: { path?: Record<string, string>; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const op = services.contract.operations.find((candidate) => candidate.operationId === operationId);
  const handler = handlers[operationId];
  if (op === undefined || handler === undefined) throw new Error(`unknown operation ${operationId}`);
  let path = op.path;
  for (const [name, value] of Object.entries(options.path ?? {})) path = path.replace(`{${name}}`, encodeURIComponent(value));
  const url = new URL(`https://driver.invalid${path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = new Map<string, string>(
    Object.entries({
      authorization: `Bearer ${as}`,
      ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
      ...(options.headers ?? {}),
    }).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const raw: RawRequest = {
    method: op.method.toUpperCase(),
    url: url.toString(),
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    params: options.path ?? {},
    body: payload === null ? null : new Response(payload).body,
  };
  const response = await pipeline(op, handler, raw);
  return { status: response.status, body: response.body === undefined ? undefined : (JSON.parse(response.body) as Record<string, unknown>) };
}

async function until<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs = 240_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitStatus(caseId: string, status: string): Promise<void> {
  await until(`case ${caseId} to be ${status}`, async () => {
    const reply = await call('getCase', 'rep', { path: { caseId } });
    return reply.body?.['status'] === status ? true : undefined;
  });
}

async function denied(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    out(`- ${label}: **NOT DENIED** (unexpected)`);
    process.exitCode = 1;
  } catch (error) {
    out(`- ${label}: denied, HTTP ${String(codeOf(error))}`);
    if (codeOf(error) !== 403) process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const endpoint = new URL(config.cosmos.endpoint);
  out('# Azure proof run (inside the virtual network, application managed identity)');
  out();
  out(`Started ${new Date().toISOString()}. Account host \`${endpoint.hostname}\`.`);
  out();

  out('## Private DNS');
  const addresses = await lookup(endpoint.hostname, { all: true });
  const privateOnly = addresses.every((entry) => entry.address.startsWith('10.'));
  out(`- ${endpoint.hostname} resolves to ${addresses.map((entry) => entry.address).join(', ')} (${privateOnly ? 'private addresses' : 'PUBLIC ADDRESS - unexpected'}).`);
  if (!privateOnly) process.exitCode = 1;
  out();

  out('## Data-plane role denials and positive access (real Cosmos DB RBAC)');
  const appCosmos = new CosmosClient({ endpoint: config.cosmos.endpoint, aadCredentials: new ManagedIdentityCredential({ clientId: process.env['AZURE_CLIENT_ID'] ?? '' }) });
  const seedCosmos = new CosmosClient({ endpoint: config.cosmos.endpoint, aadCredentials: new ManagedIdentityCredential({ clientId: process.env['SEED_CLIENT_ID'] ?? '' }) });
  const database = config.cosmos.database;
  await denied('seed identity reads the `cases` container', () =>
    seedCosmos.database(database).container('cases').items.query('SELECT TOP 1 c.id FROM c', { partitionKey: ['aurora', 'case_x'] }).fetchAll(),
  );
  await denied('seed identity reads the `provider` ledger', () =>
    seedCosmos.database(database).container('provider').items.query('SELECT TOP 1 c.id FROM c', { partitionKey: 'aurora' }).fetchAll(),
  );
  await denied('app identity writes a reference document', () =>
    appCosmos.database(database).container('reference').items.create({ id: 'role-denial-probe', tenantId: 'aurora', type: 'account' }),
  );
  await denied('app identity deletes a provider record', () => appCosmos.database(database).container('provider').item('no-such-credit', 'aurora').delete());
  const reference = await appCosmos.database(database).container('reference').items.query('SELECT VALUE COUNT(1) FROM c', { partitionKey: 'aurora' }).fetchAll();
  out(`- app identity reads reference data (positive): ${String(reference.resources[0])} documents for tenant aurora, ${ru(reference.requestCharge)} RU.`);
  out();

  out('## Hierarchical prefix partition key query variants');
  const prefixQuery = {
    query: "SELECT TOP @n c.caseId, c.status FROM c WHERE c.tenantId = @tenantId AND c.type = 'case' ORDER BY c.sortKey DESC",
    parameters: [
      { name: '@n', value: 5 },
      { name: '@tenantId', value: 'aurora' },
    ],
  };
  const casesProbe = appCosmos.database(database).container('cases');
  const variants: [string, () => Promise<{ resources: unknown[]; requestCharge: number }>][] = [
    ['partitionKey: [tenantId]', () => casesProbe.items.query(prefixQuery, { partitionKey: ['aurora'] }).fetchAll()],
    ['no partitionKey, tenantId equality filter', () => casesProbe.items.query(prefixQuery).fetchAll()],
    ['no partitionKey, tenantId filter, maxItemCount 5', () => casesProbe.items.query(prefixQuery, { maxItemCount: 5 }).fetchAll()],
  ];
  for (const [label, run] of variants) {
    try {
      const result = await run();
      out(`- ${label}: ${String(result.resources.length)} rows, ${ru(result.requestCharge)} RU`);
    } catch (error) {
      out(`- ${label}: FAILED HTTP ${String(codeOf(error))} ${(error as Error).message.split('\n')[0]?.slice(0, 120) ?? ''}`);
    }
  }
  out();
  if (process.env['PROBE_ONLY'] === '1') {
    appCosmos.dispose();
    seedCosmos.dispose();
    return;
  }

  out('## End-to-end credit through the deployed Functions host (change-feed trigger, leases)');
  const key = `azure-proof-${randomUUID()}`;
  const body = {
    accountId: 'acct_aurora_0001',
    invoiceIds: ['inv_aurora_0001_a', 'inv_aurora_0001_b'],
    category: 'duplicate_charge',
    requestedCredit: { amountMinor: 4900, currency: 'USD' },
    description: 'The same invoice appears to have been charged twice this month.',
  };
  const caseIdOf = (reply: Reply): string => String((reply.body?.['case'] as Record<string, unknown> | undefined)?.['caseId']);
  const created = await call('createCase', 'rep', { body, headers: { 'Idempotency-Key': key } });
  const caseId = caseIdOf(created);
  out(`- create case: HTTP ${String(created.status)} -> \`${caseId}\``);
  const replay = await call('createCase', 'rep', { body, headers: { 'Idempotency-Key': key } });
  out(`- identical replay of the idempotency key: HTTP ${String(replay.status)} (same case: ${String(caseIdOf(replay) === caseId)})`);
  const conflict = await call('createCase', 'rep', { body: { ...body, description: 'A different request body.' }, headers: { 'Idempotency-Key': key } });
  out(`- same key, different body: HTTP ${String(conflict.status)}`);
  out(`- another tenant reads the case: HTTP ${String((await call('getCase', 'borealisRep', { path: { caseId } })).status)}`);
  const zeroDigest = `sha256:${'0'.repeat(64)}`;
  const wrongRole = await call('approveProposal', 'rep', { path: { caseId, version: '1' }, body: { policyVersion: 1, proposalDigest: zeroDigest } });
  out(`- a representative tries to approve: HTTP ${String(wrongRole.status)}`);

  await waitStatus(caseId, 'awaiting_approval');
  const proposal = (await call('getProposal', 'rep', { path: { caseId, version: '1' } })).body ?? {};
  out(`- investigated by the trigger on Azure; proposal v1 waits (${JSON.stringify(proposal['amount'])}); no compute is held while it waits.`);
  const decision = { policyVersion: (proposal['policyRef'] as { version: number }).version, proposalDigest: String(proposal['digest']) };

  const stale = await call('approveProposal', 'approver', { path: { caseId, version: '1' }, body: { ...decision, proposalDigest: `sha256:${'f'.repeat(64)}` } });
  out(`- approval bound to a stale digest: HTTP ${String(stale.status)}`);

  const racers = await Promise.all([
    ...Array.from({ length: 6 }, () => call('approveProposal', 'approver', { path: { caseId, version: '1' }, body: decision })),
    ...Array.from({ length: 2 }, () => call('approveProposal', 'approver2', { path: { caseId, version: '1' }, body: decision })),
  ]);
  out(`- eight concurrent approvals returned HTTP ${racers.map((reply) => reply.status).sort().join(', ')}`);
  await waitStatus(caseId, 'credited');
  const credit = (await call('getCreditResult', 'rep', { path: { caseId } })).body ?? {};
  out(`- credited: ${JSON.stringify(credit['amount'])}, provider ${JSON.stringify(credit['provider'])}`);

  const provider = appCosmos.database(database).container('provider');
  const ledger = await provider.items
    .query<Record<string, unknown>>({ query: "SELECT * FROM c WHERE c.type = 'provider_credit' AND c.caseId = @c", parameters: [{ name: '@c', value: caseId }] }, { partitionKey: 'aurora' })
    .fetchAll();
  out(`- **provider ledger records for the case: ${String(ledger.resources.length)}** (${ru(ledger.requestCharge)} RU)`);
  if (ledger.resources.length !== 1) process.exitCode = 1;
  const first = ledger.resources[0];
  if (first !== undefined) {
    let duplicate = 0;
    try {
      await provider.items.create(strip(first));
    } catch (error) {
      duplicate = codeOf(error);
    }
    out(`- second create of the same provider key: HTTP ${String(duplicate)} (create-only deduplication)`);
    if (duplicate !== 409) process.exitCode = 1;
  }

  const cases = appCosmos.database(database).container('cases');
  const partition = ['aurora', caseId];
  const caseRead = await cases.item('case', partition).read<Record<string, unknown>>();
  out(`- point read of the case document: ${ru(caseRead.requestCharge)} RU`);
  const scoped = await cases.items
    .query({ query: 'SELECT c.id, c.type FROM c WHERE c.type != @none', parameters: [{ name: '@none', value: 'none' }] }, { partitionKey: partition })
    .fetchAll();
  out(`- partition-scoped parameterized query: ${String(scoped.resources.length)} documents, ${ru(scoped.requestCharge)} RU`);
  const tenantList = await cases.items
    .query({
      query: "SELECT TOP @n c.caseId, c.status FROM c WHERE c.tenantId = @tenantId AND c.type = 'case' ORDER BY c.sortKey DESC",
      parameters: [
        { name: '@n', value: 5 },
        { name: '@tenantId', value: 'aurora' },
      ],
    })
    .fetchAll();
  out(`- tenant listing (tenantId equality filter, no partition key option): ${String(tenantList.resources.length)} cases, ${ru(tenantList.requestCharge)} RU`);
  const listed = await call('listCases', 'rep', { query: { limit: '5' } });
  out(`- listCases through the API handler: HTTP ${String(listed.status)}, ${String((listed.body?.['items'] as unknown[] | undefined)?.length ?? 'n/a')} items`);
  if (listed.status !== 200) process.exitCode = 1;
  let staleStatus = 0;
  try {
    await cases.item('case', partition).replace(strip(caseRead.resource ?? {}), { accessCondition: { type: 'IfMatch', condition: `${caseRead.etag ?? ''}-stale` } });
  } catch (error) {
    staleStatus = codeOf(error);
  }
  out(`- replace with a stale ETag: HTTP ${String(staleStatus)}`);
  if (staleStatus !== 412) process.exitCode = 1;

  const timeline = await call('getCaseTimeline', 'rep', { path: { caseId }, query: { limit: '5' } });
  out(`- timeline page 1: ${String((timeline.body?.['items'] as unknown[] | undefined)?.length ?? 'n/a')} items, continuation token present: ${String(typeof timeline.body?.['continuationToken'] === 'string')}`);

  const leases = await appCosmos.database(database).container('leases').items.query('SELECT c.id FROM c').fetchAll();
  out(`- lease container read by the app identity: ${String(leases.resources.length)} lease documents`);
  if (leases.resources.length === 0) process.exitCode = 1;

  out();
  out(`Finished ${new Date().toISOString()}. Exit status ${String(process.exitCode ?? 0)}.`);
  appCosmos.dispose();
  seedCosmos.dispose();
}

main().catch((error: unknown) => {
  out(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
