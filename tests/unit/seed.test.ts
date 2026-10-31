import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadContract } from '../../src/contract/load.ts';
import type { Invoice } from '../../src/data/documents.ts';
import { EXIT, exitCodeFor, runSeedCommand } from '../../tools/seed/command.ts';
import { SEED_TENANTS, type TenantSeed } from '../../tools/seed/data/index.ts';
import {
  SeedGuardError,
  assertSeedPrincipal,
  parseSeedArgs,
  principalIdFromToken,
} from '../../tools/seed/guards.ts';
import { DEFAULT_RETRY, SeedError, runSeed, withRetry, type RetryOptions } from '../../tools/seed/seeder.ts';
import { MAX_SEED_DOCUMENTS, buildSeedDocs, validateSeedData, type SeedProblem } from '../../tools/seed/validate.ts';
import { createMemorySeedStore, transientError } from '../support/memory-seed-store.ts';

const contract = loadContract();
const docs = buildSeedDocs(SEED_TENANTS);

const tenantById = (id: string): TenantSeed => {
  const found = SEED_TENANTS.find((tenant) => tenant.tenantId === id);
  assert.ok(found, `tenant ${id} is seeded`);
  return found;
};
const invoicesOf = (tenant: TenantSeed, accountId: string): Invoice[] => tenant.invoices.filter((invoice) => invoice.accountId === accountId);
const invoiceById = (tenant: TenantSeed, invoiceId: string): Invoice => {
  const found = tenant.invoices.find((invoice) => invoice.invoiceId === invoiceId);
  assert.ok(found, `invoice ${invoiceId} is seeded`);
  return found;
};

function problemsAfter(change: (tenants: TenantSeed[]) => void): SeedProblem[] {
  const copy = [...structuredClone(SEED_TENANTS)];
  change(copy);
  return validateSeedData(copy, contract);
}
const messages = (problems: SeedProblem[]): string => problems.map((problem) => `${problem.where}: ${problem.message}`).join('\n');

describe('seed fixtures', () => {
  it('pass schema and consistency validation against the real contract', () => {
    assert.deepEqual(validateSeedData(SEED_TENANTS, contract), []);
  });

  it('stay far below the seed document ceiling and never seed approvals, decisions or results', () => {
    assert.ok(docs.length < MAX_SEED_DOCUMENTS / 2);
    assert.deepEqual([...new Set(docs.map((doc) => doc.type))].sort(), ['account', 'invoice', 'policy']);
  });

  it('build documents deterministically in a stable order', () => {
    assert.deepEqual(buildSeedDocs(SEED_TENANTS), docs);
    assert.equal(docs[0]?.type, 'account');
    assert.equal(docs[0]?.tenantId, SEED_TENANTS[0]?.tenantId);
  });

  it('give every document a valid id, a partition key value and a schema version', () => {
    for (const doc of docs) {
      assert.ok(doc.id.length > 0 && doc.id.length <= 255, `${doc.id} length`);
      assert.doesNotMatch(doc.id, /[/\\?#]/, `${doc.id} characters`);
      assert.ok(doc.tenantId.length > 0);
      assert.equal(doc.schemaVersion, 1);
      assert.ok(JSON.stringify(doc).length < 8192, `${doc.id} is a small document`);
    }
  });

  it('use a unique stored id within each tenant partition and unique business ids across tenants', () => {
    const stored = docs.map((doc) => `${doc.tenantId}/${doc.id}`);
    assert.equal(new Set(stored).size, stored.length);
    const business = docs.filter((doc) => doc.type !== 'policy').map((doc) => doc.id);
    assert.equal(new Set(business).size, business.length);
  });

  it('cover two application tenants with their own currency and policy history', () => {
    assert.ok(SEED_TENANTS.length >= 2);
    const aurora = tenantById('aurora');
    const borealis = tenantById('borealis');
    assert.ok(aurora.accounts.every((account) => account.currency === 'USD'));
    assert.ok(borealis.accounts.every((account) => account.currency === 'EUR'));
    assert.deepEqual(aurora.policies.map((policy) => policy.version), [1, 2]);
    assert.deepEqual(borealis.policies.map((policy) => policy.version), [1]);
    assert.ok(aurora.policies.every((policy) => policy.currency === 'USD'));
    assert.ok(borealis.policies.every((policy) => policy.currency === 'EUR'));
  });

  it('include duplicate charges in both tenants', () => {
    for (const [tenantId, accountId] of [
      ['aurora', 'acct_aurora_0001'],
      ['borealis', 'acct_borealis_0001'],
    ] as const) {
      const invoices = invoicesOf(tenantById(tenantId), accountId);
      const keys = invoices.map((invoice) => `${invoice.periodStart}|${String(invoice.total.amountMinor)}`);
      assert.ok(keys.some((key, index) => keys.indexOf(key) !== index), `${accountId} has two invoices for one period and amount`);
    }
  });

  it('include ordinary evidence that is consistent and fully paid', () => {
    for (const [tenantId, accountId] of [
      ['aurora', 'acct_aurora_0002'],
      ['borealis', 'acct_borealis_0002'],
    ] as const) {
      const invoices = invoicesOf(tenantById(tenantId), accountId);
      assert.ok(invoices.length > 0);
      for (const invoice of invoices) {
        assert.equal(invoice.status, 'paid');
        const paid = invoice.payments.filter((payment) => payment.status === 'succeeded').reduce((sum, payment) => sum + payment.amount.amountMinor, 0);
        assert.equal(paid, invoice.total.amountMinor);
      }
    }
  });

  it('include accounts whose disputed September invoice does not exist', () => {
    for (const [tenantId, accountId] of [
      ['aurora', 'acct_aurora_0003'],
      ['borealis', 'acct_borealis_0003'],
    ] as const) {
      const invoices = invoicesOf(tenantById(tenantId), accountId);
      assert.ok(invoices.length > 0, `${accountId} has some history`);
      assert.ok(invoices.every((invoice) => !invoice.periodStart.startsWith('2026-09')), `${accountId} has no September 2026 invoice`);
    }
  });

  it('include contradictory evidence: a void invoice with a succeeded payment and a paid invoice with only failed ones', () => {
    const aurora = tenantById('aurora');
    const voidPaid = invoiceById(aurora, 'inv_aurora_0004_a');
    assert.equal(voidPaid.status, 'void');
    assert.ok(voidPaid.payments.some((payment) => payment.status === 'succeeded'));
    const paidFailed = invoiceById(aurora, 'inv_aurora_0004_b');
    assert.equal(paidFailed.status, 'paid');
    assert.ok(paidFailed.payments.length > 0 && paidFailed.payments.every((payment) => payment.status === 'failed'));
    const borealis = invoiceById(tenantById('borealis'), 'inv_borealis_0004_a');
    assert.equal(borealis.status, 'void');
    assert.ok(borealis.payments.some((payment) => payment.status === 'succeeded'));
  });

  it('include a duplicate that exceeds every policy cap, so code must refuse the full refund', () => {
    const aurora = tenantById('aurora');
    const [a, b] = invoicesOf(aurora, 'acct_aurora_0005');
    assert.ok(a && b);
    assert.equal(a.total.amountMinor, b.total.amountMinor);
    for (const policy of aurora.policies) {
      const clause = policy.clauses.find((candidate) => candidate.appliesTo === 'duplicate_charge');
      assert.ok(clause);
      assert.ok(clause.maxCreditMinor < a.total.amountMinor, `v${String(policy.version)} cap is below the invoice`);
    }
  });

  it('include enough invoices on one account to need pagination at the default page size', () => {
    const invoices = invoicesOf(tenantById('aurora'), 'acct_aurora_0006');
    assert.ok(invoices.length > 20, 'more than one default page');
    assert.ok(invoices.length <= 50);
    assert.equal(new Set(invoices.map((invoice) => invoice.issuedAt)).size, invoices.length);
  });

  it('include untrusted instruction text inside invoice data', () => {
    const invoice = invoiceById(tenantById('aurora'), 'inv_aurora_0007_a');
    assert.match(invoice.lines.map((line) => line.description).join(' '), /ignore the credit policy/i);
  });

  it('give the policy versions different caps so version binding is observable', () => {
    const aurora = tenantById('aurora');
    const cap = (version: number): number | undefined =>
      aurora.policies.find((policy) => policy.version === version)?.clauses.find((clause) => clause.appliesTo === 'duplicate_charge')?.maxCreditMinor;
    assert.notEqual(cap(1), cap(2));
  });
});

describe('seed data validation', () => {
  it('reports an invoice whose account is not seeded', () => {
    const found = messages(problemsAfter((tenants) => { const invoice = tenants[0]?.invoices[0]; if (invoice) invoice.accountId = 'acct_aurora_9999'; }));
    assert.match(found, /is not seeded for this tenant/);
  });

  it('reports line amounts that do not add up to the total', () => {
    const found = messages(problemsAfter((tenants) => { const invoice = tenants[0]?.invoices[0]; if (invoice) invoice.total = { ...invoice.total, amountMinor: invoice.total.amountMinor + 1 }; }));
    assert.match(found, /do not add up/);
  });

  it('reports a stored id used twice in a tenant partition', () => {
    const found = messages(problemsAfter((tenants) => { const account = tenants[0]?.accounts[0]; if (account) tenants[0]?.accounts.push(structuredClone(account)); }));
    assert.match(found, /used twice in the tenant partition/);
  });

  it('reports a business id shared by two tenants', () => {
    const found = messages(problemsAfter((tenants) => { const account = tenants[0]?.accounts[0]; if (account) tenants[1]?.accounts.push(structuredClone(account)); }));
    assert.match(found, /is also used by tenant aurora/);
  });

  it('reports two clauses for one category', () => {
    const found = messages(problemsAfter((tenants) => { const clause = tenants[0]?.policies[0]?.clauses[0]; if (clause) tenants[0]?.policies[0]?.clauses.push({ ...clause, clauseId: 'duplicate-clause' }); }));
    assert.match(found, /more than one clause applies to/);
  });

  it('reports a repeated clause id', () => {
    const found = messages(problemsAfter((tenants) => { const clause = tenants[0]?.policies[0]?.clauses[0]; if (clause) tenants[0]?.policies[0]?.clauses.push({ ...clause, appliesTo: 'service_outage' }); }));
    assert.match(found, /listed twice/);
  });

  it('reports a policy id that collides with the version suffix', () => {
    const found = messages(problemsAfter((tenants) => { const policy = tenants[0]?.policies[0]; if (policy) policy.policyId = 'credit-policy__v2'; }));
    assert.match(found, /must not end with the version suffix/);
  });

  it('reports a schema violation', () => {
    const found = messages(problemsAfter((tenants) => { const account = tenants[0]?.accounts[0]; if (account) account.displayName = 'x'.repeat(101); }));
    assert.match(found, /Account/);
  });

  it('reports a currency that differs from the account', () => {
    const found = messages(problemsAfter((tenants) => {
      const invoice = tenants[0]?.invoices[0];
      if (!invoice) return;
      invoice.total = { ...invoice.total, currency: 'EUR' };
      invoice.lines = invoice.lines.map((line) => ({ ...line, amount: { ...line.amount, currency: 'EUR' } }));
      invoice.payments = invoice.payments.map((payment) => ({ ...payment, amount: { ...payment.amount, currency: 'EUR' } }));
    }));
    assert.match(found, /invoice currency differs from the account/);
  });

  it('reports a billing period that ends before it starts', () => {
    const found = messages(problemsAfter((tenants) => { const invoice = tenants[0]?.invoices[0]; if (invoice) { invoice.periodStart = '2026-12-31'; invoice.periodEnd = '2026-01-01'; } }));
    assert.match(found, /periodStart is after periodEnd/);
  });

  it('refuses a fixture set large enough to be a bulk load', () => {
    const found = messages(problemsAfter((tenants) => {
      const template = tenants[0]?.accounts[0];
      if (!template) return;
      for (let index = 0; index <= MAX_SEED_DOCUMENTS; index += 1) {
        tenants[0]?.accounts.push({ ...structuredClone(template), accountId: `acct_bulk_${String(index).padStart(4, '0')}` });
      }
    }));
    assert.match(found, /exceed the limit/);
  });

  it('reports an invalid tenant id and a tenant listed twice', () => {
    const invalid = messages(problemsAfter((tenants) => { const tenant = tenants[0]; if (tenant) tenant.tenantId = 'Bad Tenant'; }));
    assert.match(invalid, /not a valid identifier/);
    const repeated = messages(problemsAfter((tenants) => { const tenant = tenants[1]; if (tenant) tenant.tenantId = 'aurora'; }));
    assert.match(repeated, /listed twice/);
  });
});

const noSleep = (): Promise<void> => Promise.resolve();

describe('runSeed', () => {
  it('creates every document on a first run and reads each back through the independent verifier', async () => {
    const shared = new Map<string, Record<string, unknown>>();
    const writer = createMemorySeedStore(shared);
    const verifier = createMemorySeedStore(shared);
    const result = await runSeed({ docs, writer, verifier, retry: { sleep: noSleep } });

    assert.equal(result.documents, docs.length);
    assert.equal(result.created, docs.length);
    assert.equal(result.unchanged, 0);
    assert.deepEqual(result.drift, []);
    assert.equal(result.readBackOk, true);
    assert.equal(result.readBack.checked, docs.length);
    assert.equal(shared.size, docs.length);
    assert.equal(writer.counts.create, docs.length);
    assert.equal(writer.counts.read, 0, 'the writer does not verify its own writes');
    assert.equal(verifier.counts.read, docs.length);
    assert.equal(verifier.counts.listIds, SEED_TENANTS.length * 3, 'one listing per tenant and document type');
  });

  it('is non-destructive on repeat: nothing is created, replaced or changed', async () => {
    const shared = new Map<string, Record<string, unknown>>();
    const first = await runSeed({ docs, writer: createMemorySeedStore(shared), verifier: createMemorySeedStore(shared), retry: { sleep: noSleep } });
    assert.equal(first.created, docs.length);
    const snapshot = structuredClone([...shared.entries()]);

    const second = await runSeed({ docs, writer: createMemorySeedStore(shared), verifier: createMemorySeedStore(shared), retry: { sleep: noSleep } });
    assert.equal(second.created, 0);
    assert.equal(second.unchanged, docs.length);
    assert.equal(second.readBackOk, true);
    assert.deepEqual([...shared.entries()], snapshot);
  });

  it('reports drift for a stored document that differs and never overwrites it', async () => {
    const shared = new Map<string, Record<string, unknown>>();
    await runSeed({ docs, writer: createMemorySeedStore(shared), verifier: createMemorySeedStore(shared), retry: { sleep: noSleep } });
    const target = docs.find((doc) => doc.type === 'account');
    assert.ok(target);
    const key = `${target.tenantId}/${target.id}`;
    shared.set(key, { ...shared.get(key), displayName: 'Edited by someone else' });

    const lines: string[] = [];
    const result = await runSeed({ docs, writer: createMemorySeedStore(shared), verifier: createMemorySeedStore(shared), retry: { sleep: noSleep }, log: (line) => lines.push(line) });
    assert.deepEqual(result.drift, [{ tenantId: target.tenantId, id: target.id }]);
    assert.equal(result.created, 0);
    assert.equal(result.unchanged, docs.length - 1);
    assert.equal(shared.get(key)?.['displayName'], 'Edited by someone else');
    assert.equal(result.readBackOk, true, 'drift is reported separately from read-back failure');
    assert.ok(lines.some((line) => line.includes(target.id)));
  });

  it('ignores system properties when comparing, so a stored copy is not drift', async () => {
    const shared = new Map<string, Record<string, unknown>>();
    const result = await runSeed({ docs, writer: createMemorySeedStore(shared), verifier: createMemorySeedStore(shared), retry: { sleep: noSleep } });
    const anyStored = [...shared.values()][0];
    assert.ok(anyStored && '_etag' in anyStored && '_ts' in anyStored);
    assert.deepEqual(result.drift, []);
  });

  it('fails read-back when the verifier cannot find a document', async () => {
    const shared = new Map<string, Record<string, unknown>>();
    const verifier = createMemorySeedStore(shared);
    const victim = docs[3];
    assert.ok(victim);
    const read = verifier.read.bind(verifier);
    verifier.read = async (tenantId, id) => (id === victim.id ? null : await read(tenantId, id));
    const result = await runSeed({ docs, writer: createMemorySeedStore(shared), verifier, retry: { sleep: noSleep } });
    assert.deepEqual(result.readBack.missing, [`${victim.tenantId}/${victim.id}`]);
    assert.equal(result.readBackOk, false);
  });

  it('fails read-back when the verifier sees different content', async () => {
    const shared = new Map<string, Record<string, unknown>>();
    const verifier = createMemorySeedStore(shared);
    const victim = docs.find((doc) => doc.type === 'invoice');
    assert.ok(victim);
    const read = verifier.read.bind(verifier);
    verifier.read = async (tenantId, id) => {
      const found = await read(tenantId, id);
      return found !== null && id === victim.id ? { ...found, status: 'tampered' } : found;
    };
    const result = await runSeed({ docs, writer: createMemorySeedStore(shared), verifier, retry: { sleep: noSleep } });
    assert.deepEqual(result.readBack.mismatched, [`${victim.tenantId}/${victim.id}`]);
    assert.equal(result.readBackOk, false);
  });

  it('fails read-back when a query does not list a document that a point read finds', async () => {
    const shared = new Map<string, Record<string, unknown>>();
    const verifier = createMemorySeedStore(shared);
    const victim = docs.find((doc) => doc.type === 'policy');
    assert.ok(victim);
    const listIds = verifier.listIds.bind(verifier);
    verifier.listIds = async (tenantId, type) =>
      (await listIds(tenantId, type)).filter((id) => !(tenantId === victim.tenantId && id === victim.id));
    const result = await runSeed({ docs, writer: createMemorySeedStore(shared), verifier, retry: { sleep: noSleep } });
    assert.deepEqual(result.readBack.notListed, [`${victim.tenantId}/${victim.id}`]);
    assert.equal(result.readBackOk, false);
  });

  it('retries a transient failure a bounded number of times and then succeeds', async () => {
    const shared = new Map<string, Record<string, unknown>>();
    const writer = createMemorySeedStore(shared);
    const target = docs[1];
    assert.ok(target);
    let failures = 2;
    writer.before = (operation, _tenantId, id) => {
      if (operation === 'create' && id === target.id && failures > 0) {
        failures -= 1;
        throw transientError();
      }
    };
    const sleeps: number[] = [];
    const result = await runSeed({ docs, writer, verifier: createMemorySeedStore(shared), retry: { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } } });
    assert.equal(result.created, docs.length);
    assert.equal(writer.counts.create, docs.length + 2);
    assert.deepEqual(sleeps, [DEFAULT_RETRY.baseDelayMs, DEFAULT_RETRY.baseDelayMs * 2]);
  });

  it('does not retry a failure that is not transient, and stops the run', async () => {
    const shared = new Map<string, Record<string, unknown>>();
    const writer = createMemorySeedStore(shared);
    writer.before = () => {
      throw Object.assign(new Error('forbidden'), { code: 403 });
    };
    await assert.rejects(runSeed({ docs, writer, verifier: createMemorySeedStore(shared), retry: { sleep: noSleep } }), /forbidden/);
    assert.equal(writer.counts.create, 1);
    assert.equal(shared.size, 0);
  });

  it('gives up after the retry bound on a persistent transient failure', async () => {
    const writer = createMemorySeedStore();
    writer.before = () => {
      throw transientError();
    };
    await assert.rejects(runSeed({ docs, writer, verifier: createMemorySeedStore(), retry: { sleep: noSleep } }), /service unavailable/);
    assert.equal(writer.counts.create, DEFAULT_RETRY.attempts);
  });

  it('produces exactly one stored copy of each document when two seed runs race', async () => {
    const shared = new Map<string, Record<string, unknown>>();
    const racer = (): ReturnType<typeof createMemorySeedStore> => {
      const store = createMemorySeedStore(shared);
      store.before = () => new Promise<void>((resolve) => { setImmediate(resolve); });
      return store;
    };
    const [one, two] = await Promise.all([
      runSeed({ docs, writer: racer(), verifier: racer(), retry: { sleep: noSleep } }),
      runSeed({ docs, writer: racer(), verifier: racer(), retry: { sleep: noSleep } }),
    ]);
    assert.equal(one.created + two.created, docs.length, 'each document is created exactly once across both runs');
    assert.equal(one.unchanged + two.unchanged, docs.length);
    assert.equal(shared.size, docs.length);
    assert.equal(one.readBackOk && two.readBackOk, true);
    assert.deepEqual(one.drift.concat(two.drift), []);
  });

  it('refuses a document type outside the allowlist before writing anything', async () => {
    const writer = createMemorySeedStore();
    const approval = { ...docs[0], type: 'approval' } as unknown as (typeof docs)[number];
    await assert.rejects(
      runSeed({ docs: [...docs, approval], writer, verifier: createMemorySeedStore(), retry: { sleep: noSleep } }),
      (error: unknown) => error instanceof SeedError && error.code === 'type_not_allowed',
    );
    assert.equal(writer.counts.create, 0);
  });

  it('fails loudly when a conflicting document cannot be read back', async () => {
    const writer = createMemorySeedStore();
    writer.create = () => Promise.resolve('exists');
    await assert.rejects(
      runSeed({ docs, writer, verifier: createMemorySeedStore(), retry: { sleep: noSleep } }),
      (error: unknown) => error instanceof SeedError && error.code === 'conflict_without_document',
    );
  });
});

describe('withRetry', () => {
  const options = (sleeps: number[], overrides: Partial<RetryOptions> = {}): RetryOptions => ({
    ...DEFAULT_RETRY,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });

  it('doubles the delay on each attempt', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const value = await withRetry(() => {
      calls += 1;
      return calls < 4 ? Promise.reject(transientError()) : Promise.resolve('ok');
    }, options(sleeps));
    assert.equal(value, 'ok');
    assert.deepEqual(sleeps, [500, 1000, 2000]);
  });

  it('honours a server retry hint that is longer than the backoff, up to the cap', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await withRetry(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(transientError(3000));
      if (calls === 2) return Promise.reject(transientError(60_000));
      return Promise.resolve();
    }, options(sleeps));
    assert.deepEqual(sleeps, [3000, DEFAULT_RETRY.maxDelayMs]);
  });

  it('stops after the configured number of attempts', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await assert.rejects(
      withRetry(() => {
        calls += 1;
        return Promise.reject(transientError());
      }, options(sleeps, { attempts: 3 })),
      /service unavailable/,
    );
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2);
  });

  it('does not retry client errors', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await assert.rejects(
      withRetry(() => {
        calls += 1;
        return Promise.reject(Object.assign(new Error('bad request'), { code: 400 }));
      }, options(sleeps)),
      /bad request/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  });
});

const GUID_A = '11111111-2222-4333-8444-555555555555';
const GUID_B = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const EMULATOR = ['--target', 'emulator', '--endpoint', 'http://127.0.0.1:18101'];
const CLOUD = ['--target', 'cloud', '--endpoint', 'https://resolve-demo.documents.azure.com', '--confirm-account', 'resolve-demo'];
const EMULATOR_ENV = { COSMOS_KEY: 'unit-test-emulator-key' };
const CLOUD_ENV = { SEED_CLIENT_ID: GUID_A, SEED_PRINCIPAL_ID: GUID_B };

function refusal(argv: readonly string[], env: Record<string, string>): string {
  try {
    parseSeedArgs(argv, env);
  } catch (error) {
    if (error instanceof SeedGuardError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('seed guards', () => {
  const cases: [string, readonly string[], Record<string, string>, string][] = [
    ['no target', ['--endpoint', 'http://127.0.0.1:1'], EMULATOR_ENV, 'target_required'],
    ['unknown target', ['--target', 'prod', '--endpoint', 'http://127.0.0.1:1'], EMULATOR_ENV, 'target_required'],
    ['unknown flag', [...EMULATOR, '--force'], EMULATOR_ENV, 'usage'],
    ['positional argument', [...EMULATOR, 'reset'], EMULATOR_ENV, 'usage'],
    ['TLS verification disabled', EMULATOR, { ...EMULATOR_ENV, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'tls_verification_disabled'],
    ['TLS verification disabled for cloud', CLOUD, { ...CLOUD_ENV, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'tls_verification_disabled'],
    ['no endpoint', ['--target', 'emulator'], EMULATOR_ENV, 'endpoint_required'],
    ['unparseable endpoint', ['--target', 'emulator', '--endpoint', 'not a url'], EMULATOR_ENV, 'endpoint_invalid'],
    ['endpoint with a path', ['--target', 'emulator', '--endpoint', 'http://127.0.0.1:1/dbs'], EMULATOR_ENV, 'endpoint_invalid'],
    ['endpoint with credentials', ['--target', 'emulator', '--endpoint', 'http://user:secret@127.0.0.1:1'], EMULATOR_ENV, 'endpoint_invalid'],
    ['endpoint with a query', ['--target', 'emulator', '--endpoint', 'http://127.0.0.1:1/?x=1'], EMULATOR_ENV, 'endpoint_invalid'],
    ['endpoint with a fragment', ['--target', 'emulator', '--endpoint', 'http://127.0.0.1:1/#x'], EMULATOR_ENV, 'endpoint_invalid'],
    ['non-http emulator endpoint', ['--target', 'emulator', '--endpoint', 'ftp://127.0.0.1'], EMULATOR_ENV, 'endpoint_invalid'],
    ['emulator target with a remote host', ['--target', 'emulator', '--endpoint', 'http://example.com'], EMULATOR_ENV, 'endpoint_not_loopback'],
    ['emulator target with an Azure account', ['--target', 'emulator', '--endpoint', 'https://resolve-demo.documents.azure.com'], EMULATOR_ENV, 'endpoint_not_loopback'],
    ['emulator target with a private address', ['--target', 'emulator', '--endpoint', 'http://10.0.0.4:8081'], EMULATOR_ENV, 'endpoint_not_loopback'],
    ['emulator without a key', EMULATOR, {}, 'key_required'],
    ['emulator with an empty key', EMULATOR, { COSMOS_KEY: '' }, 'key_required'],
    ['emulator with --confirm-account', [...EMULATOR, '--confirm-account', 'resolve-demo'], EMULATOR_ENV, 'usage'],
    ['invalid database name', [...EMULATOR, '--database', '1bad'], EMULATOR_ENV, 'database_invalid'],
    ['cloud over http', ['--target', 'cloud', '--endpoint', 'http://resolve-demo.documents.azure.com', '--confirm-account', 'resolve-demo'], CLOUD_ENV, 'endpoint_not_https'],
    ['cloud with a non-Cosmos host', ['--target', 'cloud', '--endpoint', 'https://example.com', '--confirm-account', 'example'], CLOUD_ENV, 'endpoint_not_cosmos_account'],
    ['cloud with an explicit port', ['--target', 'cloud', '--endpoint', 'https://resolve-demo.documents.azure.com:8081', '--confirm-account', 'resolve-demo'], CLOUD_ENV, 'endpoint_not_cosmos_account'],
    ['cloud against loopback', ['--target', 'cloud', '--endpoint', 'https://127.0.0.1:8081', '--confirm-account', 'resolve-demo'], CLOUD_ENV, 'endpoint_not_cosmos_account'],
    ['cloud without --confirm-account', ['--target', 'cloud', '--endpoint', 'https://resolve-demo.documents.azure.com'], CLOUD_ENV, 'confirm_account_required'],
    ['cloud with the wrong account', ['--target', 'cloud', '--endpoint', 'https://resolve-demo.documents.azure.com', '--confirm-account', 'resolve-other'], CLOUD_ENV, 'confirm_account_mismatch'],
    ['cloud with an account key', CLOUD, { ...CLOUD_ENV, COSMOS_KEY: 'a-key' }, 'key_not_allowed'],
    ['cloud without a client id', CLOUD, { SEED_PRINCIPAL_ID: GUID_B }, 'seed_identity_required'],
    ['cloud with a malformed client id', CLOUD, { ...CLOUD_ENV, SEED_CLIENT_ID: 'not-a-guid' }, 'seed_identity_required'],
    ['cloud without a principal id', CLOUD, { SEED_CLIENT_ID: GUID_A }, 'seed_identity_required'],
    ['cloud with a malformed principal id', CLOUD, { ...CLOUD_ENV, SEED_PRINCIPAL_ID: 'not-a-guid' }, 'seed_identity_required'],
  ];

  for (const [name, argv, env, expected] of cases) {
    it(`refuses ${name} with ${expected}`, () => {
      assert.equal(refusal(argv, env), expected);
    });
  }

  it('accepts a loopback emulator target and normalises the endpoint', () => {
    const plan = parseSeedArgs(['--target', 'emulator', '--endpoint', 'http://localhost:18101/'], EMULATOR_ENV);
    assert.deepEqual(plan, {
      target: 'emulator',
      endpoint: 'http://localhost:18101',
      key: 'unit-test-emulator-key',
      database: 'resolve',
      allowDrift: false,
      dryRun: false,
      json: false,
    });
  });

  it('takes the endpoint and database from the environment, with flags winning', () => {
    const env = { ...EMULATOR_ENV, COSMOS_ENDPOINT: 'http://127.0.0.1:1', COSMOS_DATABASE: 'from_env' };
    assert.equal(parseSeedArgs(['--target', 'emulator'], env).endpoint, 'http://127.0.0.1:1');
    assert.equal(parseSeedArgs(['--target', 'emulator'], env).database, 'from_env');
    const plan = parseSeedArgs(['--target', 'emulator', '--endpoint', 'http://127.0.0.1:2', '--database', 'from_flag'], env);
    assert.equal(plan.endpoint, 'http://127.0.0.1:2');
    assert.equal(plan.database, 'from_flag');
  });

  it('accepts a confirmed cloud target and lowercases the expected principal id', () => {
    const plan = parseSeedArgs([...CLOUD, '--dry-run', '--allow-drift', '--json'], CLOUD_ENV);
    assert.equal(plan.target, 'cloud');
    if (plan.target !== 'cloud') return;
    assert.equal(plan.accountName, 'resolve-demo');
    assert.equal(plan.endpoint, 'https://resolve-demo.documents.azure.com');
    assert.equal(plan.clientId, GUID_A);
    assert.equal(plan.expectedPrincipalId, GUID_B.toLowerCase());
    assert.equal(plan.dryRun && plan.allowDrift && plan.json, true);
  });
});

const jwt = (payload: unknown): string => {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [part({ alg: 'none' }), part(payload), 'signature'].join('.');
};

describe('seed principal check', () => {
  it('reads the object id from a token, lowercased', () => {
    assert.equal(principalIdFromToken(jwt({ oid: GUID_B })), GUID_B.toLowerCase());
  });

  for (const [name, token] of [
    ['an empty token', ''],
    ['a token without a payload', 'header-only'],
    ['a payload that is not JSON', 'a.bm90IGpzb24.c'],
    ['a payload without oid', jwt({ sub: 'x' })],
    ['an oid that is not a string', jwt({ oid: 7 })],
    ['a null payload', jwt(null)],
  ] as const) {
    it(`returns null for ${name}`, () => {
      assert.equal(principalIdFromToken(token), null);
    });
  }

  it('accepts the expected identity regardless of case', () => {
    assert.doesNotThrow(() => { assertSeedPrincipal(jwt({ oid: GUID_B }), GUID_B.toLowerCase()); });
  });

  it('refuses a different identity before any write', () => {
    assert.throws(
      () => { assertSeedPrincipal(jwt({ oid: GUID_A }), GUID_B); },
      (error: unknown) => error instanceof SeedGuardError && error.code === 'principal_mismatch',
    );
    assert.throws(() => { assertSeedPrincipal('garbage', GUID_B); }, SeedGuardError);
  });
});

function capture(): { io: { out(text: string): void; err(text: string): void }; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out: () => out.join(''), err: () => err.join('') };
}

describe('seed command', () => {
  it('prints usage for --help', async () => {
    const run = capture();
    assert.equal(await runSeedCommand(['--help'], {}, run.io), EXIT.ok);
    assert.match(run.out(), /Usage: node tools\/seed\/main\.ts/);
  });

  it('refuses to run without an explicit target', async () => {
    const run = capture();
    assert.equal(await runSeedCommand([], EMULATOR_ENV, run.io), EXIT.failure);
    assert.match(run.err(), /target_required/);
    assert.equal(run.out(), '');
  });

  it('validates fixtures and guards on --dry-run without contacting anything', async () => {
    const run = capture();
    // Nothing listens on this port; success proves no connection was attempted.
    const code = await runSeedCommand([...EMULATOR, '--dry-run'], EMULATOR_ENV, run.io);
    assert.equal(code, EXIT.ok);
    assert.match(run.out(), new RegExp(`dry run: ${String(docs.length)} documents`));
    assert.match(run.out(), /nothing was written/);
  });

  it('applies every cloud guard on --dry-run', async () => {
    const accepted = capture();
    assert.equal(await runSeedCommand([...CLOUD, '--dry-run'], CLOUD_ENV, accepted.io), EXIT.ok);
    assert.match(accepted.err(), /resolve-demo/);
    const refused = capture();
    assert.equal(await runSeedCommand([...CLOUD, '--dry-run'], { ...CLOUD_ENV, COSMOS_KEY: 'a-key' }, refused.io), EXIT.failure);
    assert.match(refused.err(), /key_not_allowed/);
  });

  it('never prints the key or the principal-claim values it was given', async () => {
    const run = capture();
    await runSeedCommand([...EMULATOR, '--dry-run'], EMULATOR_ENV, run.io);
    await runSeedCommand([...EMULATOR, '--dry-run'], { ...EMULATOR_ENV, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, run.io);
    assert.doesNotMatch(run.out() + run.err(), /unit-test-emulator-key/);
  });
});

describe('seed exit codes', () => {
  const clean = { readBackOk: true, drift: [] };
  const drifted = { readBackOk: true, drift: [{ tenantId: 'aurora', id: 'acct_aurora_0001' }] };

  it('succeeds on a clean run', () => {
    assert.equal(exitCodeFor(clean, false), EXIT.ok);
  });

  it('fails on drift unless it was explicitly accepted', () => {
    assert.equal(exitCodeFor(drifted, false), EXIT.drift);
    assert.equal(exitCodeFor(drifted, true), EXIT.ok);
  });

  it('fails a read-back problem even when drift is accepted', () => {
    assert.equal(exitCodeFor({ readBackOk: false, drift: [] }, true), EXIT.failure);
    assert.equal(exitCodeFor({ readBackOk: false, drift: drifted.drift }, true), EXIT.failure);
  });
});
