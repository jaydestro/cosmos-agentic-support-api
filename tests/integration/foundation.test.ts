import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CosmosClient } from '@azure/cosmos';
import { DIAGNOSTICS_PARTITION, newOutboxDoc, type OutboxDoc } from '../../src/outbox/types.ts';
import { SEED_TENANTS } from '../../tools/seed/data/index.ts';
import { EXIT, runSeedCommand } from '../../tools/seed/command.ts';
import type { SeedResult } from '../../tools/seed/seeder.ts';
import { buildSeedDocs } from '../../tools/seed/validate.ts';
import { parseConsoleSettings } from '../../web/src/config.ts';
import { identity, identityWithRoles, objectIdFor, type Api } from '../support/api.ts';
import { assertApiHeaders, assertProblem } from '../support/assertions.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';
import { containerDifferences, loadManifest, provisionDatabase } from '../support/provision.ts';
import { sleep, waitFor } from '../support/wait.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BEARER = ['Bear', 'er'].join('');
const IDEMPOTENCY_KEY = 'it-key-0123456789abcdef';

const aurora = identity('aurora', 'Representative');
const auroraApprover = identity('aurora', 'Approver');
const auroraOperator = identity('aurora', 'Operator');
const borealis = identity('borealis', 'Representative');

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;
const throwawayDatabases: string[] = [];

before(() => {
  stack = readStackConnection();
  api = connectApi(stack);
  cosmos = openEmulator(stack);
});

after(async () => {
  try {
    for (const name of throwawayDatabases) {
      try {
        await cosmos.database(name).delete();
      } catch (error) {
        if ((error as { code?: unknown }).code !== 404) throw error;
      }
    }
  } finally {
    cosmos.dispose();
  }
});

describe('liveness and readiness', () => {
  for (const path of ['/api/health', '/api/ready']) {
    it(`GET ${path} is anonymous, minimal and uncached`, async () => {
      const result = await api.get(path);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { status: 'ok' });
      assertApiHeaders(result);
    });
  }

  it('echoes a well-formed correlation id and replaces a malformed one', async () => {
    const good = await api.get('/api/health', { headers: { 'X-Correlation-Id': 'it-correlation-0001' } });
    assert.equal(good.headers.get('x-correlation-id'), 'it-correlation-0001');
    const bad = await api.get('/api/health', { headers: { 'X-Correlation-Id': 'not valid!' } });
    assert.match(bad.headers.get('x-correlation-id') ?? '', /^[0-9a-f]{16}$/);
  });
});

describe('authentication and roles', () => {
  it('answers an anonymous call with a bare bearer challenge', async () => {
    const result = await api.get('/api/session');
    assertProblem(result, 401, 'unauthenticated');
    assert.equal(result.headers.get('www-authenticate'), BEARER);
  });

  it('rejects a token that is not a JWT', async () => {
    assertProblem(await api.get('/api/session', { as: 'not-a-token' }), 401, 'unauthenticated');
  });

  const badTokens: [string, Parameters<Api['token']>[1], number, string][] = [
    ['an expired token', { expiresInSeconds: -600 }, 401, 'unauthenticated'],
    ['another audience', { audience: 'api://someone-else' }, 401, 'unauthenticated'],
    ['another issuer', { issuer: 'https://other-issuer.invalid/' }, 401, 'unauthenticated'],
    ['a v1.0 token', { ver: '1.0' }, 401, 'unauthenticated'],
    ['an application token', { idtyp: 'app' }, 401, 'unauthenticated'],
    ['a token without the delegated scope', { scope: null }, 403, 'insufficient_scope'],
  ];
  for (const [name, claims, status, code] of badTokens) {
    it(`rejects ${name}`, async () => {
      assertProblem(await api.get('/api/session', { as: aurora, claims }), status, code);
    });
  }

  it('rejects a user with no Resolve role', async () => {
    assertProblem(await api.get('/api/session', { as: identityWithRoles('no-role', []) }), 403, 'forbidden_role');
  });

  it('rejects a user whose roles span two tenants', async () => {
    const both = identityWithRoles('two-tenants', ['Resolve.Representative.aurora', 'Resolve.Representative.borealis']);
    assertProblem(await api.get('/api/session', { as: both }), 403, 'forbidden_tenant');
  });

  it('derives the principal and tenant from the token', async () => {
    const { data, response } = await api.client(aurora).GET('/session');
    assert.equal(response.status, 200);
    assert.deepEqual(data?.principal, { principalId: objectIdFor(aurora.label), tenantId: 'aurora', roles: ['Representative'] });
    assert.equal(data?.environment.simulatedCredits, true);
    assert.equal(data?.environment.agentMode, 'demo');
    assert.equal(data?.environment.liveAvailable, false);
    const other = await api.client(borealis).GET('/session');
    assert.equal(other.data?.principal.tenantId, 'borealis');
  });

  it('does not let identity headers, function keys or query codes stand in for a token', async () => {
    const claimed = Buffer.from(JSON.stringify({ userRoles: ['Resolve.Operator.aurora'], userId: 'someone' })).toString('base64');
    const result = await api.get('/api/session?code=anything', {
      headers: {
        'X-MS-CLIENT-PRINCIPAL': claimed,
        'X-MS-CLIENT-PRINCIPAL-ID': 'someone',
        'X-MS-CLIENT-PRINCIPAL-NAME': 'someone@example.invalid',
        'x-functions-key': 'anything',
      },
    });
    assertProblem(result, 401, 'unauthenticated');
  });

  it('does not let identity headers change who a valid token belongs to', async () => {
    const result = await api.get('/api/session', {
      as: aurora,
      headers: { 'X-MS-CLIENT-PRINCIPAL-ID': objectIdFor(auroraOperator.label), 'X-Forwarded-User': 'someone' },
    });
    assert.equal(result.status, 200);
    assert.deepEqual((result.json as { principal: { roles: string[] } }).principal.roles, ['Representative']);
  });

  it('refuses a cross-origin browser call before authenticating it, and sends no CORS grant', async () => {
    const result = await api.get('/api/session', { headers: { Origin: 'https://evil.example.invalid' } });
    assertProblem(result, 403, 'origin_not_allowed');
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  });

  it('accepts a same-origin browser call without CORS headers', async () => {
    const result = await api.get('/api/session', { as: aurora, headers: { Origin: new URL(stack.apiUrl).origin } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  });
});

describe('tenant scoping of reference reads', () => {
  it('returns an account to its own tenant only', async () => {
    const own = await api.client(aurora).GET('/accounts/{accountId}', { params: { path: { accountId: 'acct_aurora_0001' } } });
    assert.equal(own.response.status, 200);
    assert.equal(own.data?.accountId, 'acct_aurora_0001');
    assert.equal(own.data?.currency, 'USD');
    assert.equal('tenantId' in (own.data ?? {}), false, 'storage partition field must not leak');

    const foreign = await api.get('/api/accounts/acct_aurora_0001', { as: borealis });
    assertProblem(foreign, 404, 'not_found');
  });

  it('answers an unknown account with the same 404', async () => {
    assertProblem(await api.get('/api/accounts/acct_aurora_9999', { as: aurora }), 404, 'not_found');
  });

  it('does not list another tenant invoices or reveal that the account exists', async () => {
    assertProblem(await api.get('/api/accounts/acct_aurora_0006/invoices', { as: borealis }), 404, 'not_found');
    assertProblem(await api.get('/api/invoices/inv_aurora_0006_26', { as: borealis }), 404, 'not_found');
    const own = await api.client(aurora).GET('/invoices/{invoiceId}', { params: { path: { invoiceId: 'inv_aurora_0006_26' } } });
    assert.equal(own.response.status, 200);
    assert.equal(own.data?.accountId, 'acct_aurora_0006');
  });

  it('serves each tenant its own policy versions', async () => {
    const auroraPolicies = await api.client(aurora).GET('/policies');
    const items = auroraPolicies.data?.items ?? [];
    assert.deepEqual(items.map((policy) => policy.version).sort(), [1, 2]);
    assert.deepEqual(
      Object.fromEntries(items.map((policy) => [policy.version, policy.status])),
      { 1: 'superseded', 2: 'effective' },
    );
    assert.ok(items.every((policy) => policy.currency === 'USD'));

    const borealisPolicies = await api.client(borealis).GET('/policies');
    assert.deepEqual(
      (borealisPolicies.data?.items ?? []).map((policy) => [policy.version, policy.currency, policy.status]),
      [[1, 'EUR', 'effective']],
    );
    const missing = await api.get('/api/policies/credit-policy/versions/2', { as: borealis });
    assertProblem(missing, 404, 'not_found');
  });
});

describe('pagination', () => {
  it('walks every page once, newest first, and ends with a null token', async () => {
    const client = api.client(aurora);
    const ids: string[] = [];
    const issued: string[] = [];
    const sizes: number[] = [];
    let token: string | null | undefined;
    for (let page = 0; page < 10; page += 1) {
      const { data, response } = await client.GET('/accounts/{accountId}/invoices', {
        params: {
          path: { accountId: 'acct_aurora_0006' },
          query: { limit: 10, ...(typeof token === 'string' ? { continuationToken: token } : {}) },
        },
      });
      assert.equal(response.status, 200);
      assert.ok(data, 'page body');
      sizes.push(data.items.length);
      for (const item of data.items) {
        ids.push(item.invoiceId);
        issued.push(item.issuedAt);
      }
      token = data.continuationToken;
      if (token === null) break;
    }
    assert.deepEqual(sizes, [10, 10, 6]);
    assert.equal(token, null);
    assert.equal(new Set(ids).size, 26, 'no invoice repeats or is skipped');
    for (let index = 1; index < issued.length; index += 1) {
      assert.ok((issued[index - 1] ?? '') >= (issued[index] ?? ''), `page order is newest first at ${String(index)}`);
    }
  });

  it('rejects a malformed, foreign or out-of-range paging request', async () => {
    const base = '/api/accounts/acct_aurora_0006/invoices';
    assertProblem(await api.get(`${base}?continuationToken=bm90LWEtY3Vyc29y`, { as: aurora }), 400, 'invalid_continuation_token');
    for (const query of ['limit=0', 'limit=51', 'limit=abc', 'limit=1.5']) {
      assertProblem(await api.get(`${base}?${query}`, { as: aurora }), 400, 'validation_failed');
    }
  });
});

describe('routing and static hosting', () => {
  it('serves the console at the root with a content security policy', async () => {
    const result = await api.get('/');
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type') ?? '', /^text\/html/);
    assert.ok((result.headers.get('content-security-policy') ?? '').includes("default-src 'none'"), 'CSP starts from default-src none');
    assert.equal(result.headers.get('cache-control'), 'no-cache');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  });

  it('tells the console how to sign in, in a form the console accepts, and nothing else', async () => {
    const result = await api.get('/config.json');
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(result.headers.get('content-length'), String(Buffer.byteLength(result.text)));

    const body: unknown = JSON.parse(result.text);
    assert.deepEqual(Object.keys(body as object), ['auth']);
    const parsed = parseConsoleSettings(body);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    assert.deepEqual(parsed.settings, { auth: { mode: 'test-idp', mintUrl: stack.idpMintUrl } });
  });

  it('needs no sign-in, is the same for everyone, and carries no secret', async () => {
    const anonymous = await api.get('/config.json');
    const signedIn = await api.get('/config.json', { as: aurora });
    const otherTenant = await api.get('/config.json', { as: borealis });
    assert.equal(anonymous.status, 200);
    assert.equal(signedIn.text, anonymous.text);
    assert.equal(otherTenant.text, anonymous.text);
    for (const secret of [stack.cosmosKey, stack.cosmosEndpoint, stack.database]) {
      assert.ok(!anonymous.text.includes(secret), 'the settings carry no data-store address, name or key');
    }
  });

  it('answers HEAD with the headers of the settings and no body', async () => {
    const get = await api.get('/config.json');
    const head = await api.send('HEAD', '/config.json');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
    assert.equal(head.headers.get('cache-control'), 'no-store');
  });

  it('refuses to change or send anything to the settings', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const result = await api.send(method, '/config.json', { body: {} });
      assertProblem(result, 405, 'method_not_allowed');
      assert.equal(result.headers.get('allow'), 'GET, HEAD', method);
    }
  });

  it('lets the console page connect to itself, Microsoft sign-in and, in this test setup, the test identity provider only', async () => {
    const policy = (await api.get('/')).headers.get('content-security-policy') ?? '';
    const connect = policy.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('connect-src'));
    assert.equal(connect, `connect-src 'self' https://login.microsoftonline.com ${new URL(stack.idpMintUrl).origin}`);
  });

  it('serves the interactive reference and the exact contract it renders', async () => {
    for (const path of ['/reference/', '/reference']) {
      const page = await api.get(path);
      assert.equal(page.status, 200, path);
      assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(page.headers.get('cache-control'), 'public, max-age=3600');
    }
    const spec = await api.get('/reference/openapi.yaml');
    assert.equal(spec.status, 200);
    assert.match(spec.headers.get('content-type') ?? '', /^application\/yaml/);
    assert.equal(spec.text, await readFile(`${ROOT}contracts/openapi.yaml`, 'utf8'));
  });

  it('does not serve source, configuration or traversal paths', async () => {
    for (const path of ['/openapi.yaml', '/host.json', '/package.json', '/dist/src/index.js', '/assets/', '/..%2f..%2fhost.json', '/reference/..%2fhost.json']) {
      const result = await api.get(path);
      assert.equal(result.status, 404, path);
      assert.doesNotMatch(result.text, /extensionBundle|"main"/, path);
    }
  });

  it('answers unknown API paths with a problem 404', async () => {
    assertProblem(await api.get('/api/nope'), 404, 'not_found');
  });

  it('answers a wrong method with 405 and an Allow header', async () => {
    const api405 = await api.send('PUT', '/api/cases', { as: aurora });
    assertProblem(api405, 405, 'method_not_allowed');
    assert.equal(api405.headers.get('allow'), 'GET, POST');
    const page405 = await api.send('POST', '/', { body: {} });
    assertProblem(page405, 405, 'method_not_allowed');
    assert.equal(page405.headers.get('allow'), 'GET, HEAD');
  });
});

describe('request handling in front of the handlers', () => {
  const validCase = { accountId: 'acct_aurora_0001', category: 'duplicate_charge', description: 'I was charged twice for the August period.' };
  const create = (options: Parameters<Api['post']>[1] = {}) =>
    api.post('/api/cases', { as: aurora, headers: { 'Idempotency-Key': IDEMPOTENCY_KEY }, body: validCase, ...options });

  it('only lets a representative submit a case', async () => {
    assertProblem(await create({ as: null }), 401, 'unauthenticated');
    assertProblem(await create({ as: auroraApprover }), 403, 'forbidden_role');
    assertProblem(await create({ as: auroraOperator }), 403, 'forbidden_role');
  });

  it('requires a well-formed Idempotency-Key header', async () => {
    assertProblem(await create({ headers: {} }), 400, 'validation_failed');
    assertProblem(await create({ headers: { 'Idempotency-Key': 'short' } }), 400, 'validation_failed');
  });

  it('rejects a body that is not JSON, not UTF-8 JSON, empty, or off-contract', async () => {
    assertProblem(await create({ contentType: 'text/plain', body: undefined, rawBody: 'hello' }), 415, 'unsupported_media_type');
    assertProblem(await create({ body: undefined, rawBody: '{"accountId":', contentType: 'application/json' }), 400, 'invalid_json');
    assertProblem(await create({ body: undefined, rawBody: '', contentType: 'application/json' }), 400, 'invalid_json');
    const offContract = await create({ body: { accountId: 'acct_aurora_0001', category: 'refund_everything', description: '', extra: true } });
    assertProblem(offContract, 400, 'validation_failed');
    const errors = (offContract.json as { errors?: unknown[] }).errors;
    assert.ok(Array.isArray(errors) && errors.length > 0, 'field errors are listed');
  });

  it('refuses an oversized body by its declared length', async () => {
    const declared = await create({ body: { ...validCase, description: 'x'.repeat(20_000) } });
    assertProblem(declared, 413, 'payload_too_large');
  });

  // The Functions host forwards a body only when it has a Content-Length, so a chunked upload would otherwise
  // reach the handlers as "empty" and be reported as a missing body.
  it('refuses a chunked upload, small or large, instead of treating it as empty', async () => {
    const origin = new URL(stack.apiUrl).origin;
    const bearer = await api.token(aurora);
    const streamed = async (text: string): Promise<Response> => {
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + 1024));
          offset += 1024;
        },
      });
      return fetch(`${origin}/api/cases`, {
        method: 'POST',
        headers: { Authorization: `${BEARER} ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY },
        body,
        duplex: 'half',
        signal: AbortSignal.timeout(30_000),
      });
    };
    for (const text of [JSON.stringify(validCase), JSON.stringify({ ...validCase, description: 'x'.repeat(64 * 1024) })]) {
      const response = await streamed(text);
      const raw = await response.text();
      assert.equal(response.status, 411, raw);
      assert.equal((JSON.parse(raw) as { code?: string }).code, 'length_required');
    }
  });
});

describe('change feed trigger and outbox', () => {
  const partition = ['diagnostics', DIAGNOSTICS_PARTITION];

  it('delivers an outbox item to the Function once, completes it, and ignores other document types', { timeout: 120_000 }, async () => {
    const cases = cosmos.database(stack.database).container('cases');
    const key = randomBytes(6).toString('hex');
    const noise = await cases.items.create({ id: `noise-${key}`, tenantId: 'diagnostics', caseId: DIAGNOSTICS_PARTITION, type: 'noise', ttl: 3600 });
    const doc = newOutboxDoc({
      tenantId: 'diagnostics',
      caseId: DIAGNOSTICS_PARTITION,
      kind: 'diagnostic.echo',
      key,
      payload: { note: 'integration test' },
      now: new Date(),
    });
    await cases.items.create({ ...doc, ttl: 3600 });

    const read = async (): Promise<OutboxDoc | undefined> => (await cases.item(doc.id, partition).read<OutboxDoc>()).resource;
    const done = await waitFor('the trigger to complete the outbox item', async () => {
      const current = await read();
      return current?.state === 'completed' ? current : undefined;
    }, { timeoutMs: 90_000, intervalMs: 500 });

    assert.equal(done.attempts, 1, 'one claim, one execution');
    assert.equal(done.lastError, null);
    assert.equal(done.claimedBy, null);
    assert.notEqual(done.completedAt, null);

    await sleep(3_000);
    const settled = await read();
    assert.equal(settled?._etag, done._etag, 'a completed item is not written again');
    const untouched = (await cases.item(noise.item.id, partition).read()).resource as { _etag?: string } | undefined;
    assert.equal(untouched?._etag, noise.etag, 'a document of another type is left alone');
  });

  it('create-only enqueue turns a repeated key into a conflict instead of a second item', async () => {
    const cases = cosmos.database(stack.database).container('cases');
    const doc = { ...newOutboxDoc({ tenantId: 'diagnostics', caseId: DIAGNOSTICS_PARTITION, kind: 'diagnostic.echo', key: `dup-${randomBytes(4).toString('hex')}`, payload: {}, now: new Date() }), ttl: 3600 };
    await cases.items.create(doc);
    await assert.rejects(cases.items.create(doc), (error: { code?: number }) => error.code === 409);
  });
});

describe('seeding', () => {
  const expected = buildSeedDocs(SEED_TENANTS).length;
  type SeedReport = SeedResult & { target: string; database: string; container: string };

  async function seed(database: string, extra: readonly string[] = []): Promise<{ code: number; report: SeedReport | undefined; stderr: string }> {
    let out = '';
    let err = '';
    const code = await runSeedCommand(
      ['--target', 'emulator', '--endpoint', stack.cosmosEndpoint, '--database', database, '--json', ...extra],
      { COSMOS_KEY: stack.cosmosKey },
      {
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
      },
    );
    return { code, stderr: err, report: out.trim() === '' ? undefined : (JSON.parse(out) as SeedReport) };
  }

  it('seeded the stack at startup and a repeat changes nothing', async () => {
    const reference = cosmos.database(stack.database).container('reference');
    const before = await reference.item('acct_aurora_0001', 'aurora').read();
    assert.equal(before.statusCode, 200);

    const { code, report, stderr } = await seed(stack.database);
    assert.equal(code, EXIT.ok, stderr);
    assert.ok(report);
    assert.equal(report.documents, expected);
    assert.equal(report.created, 0);
    assert.equal(report.unchanged, expected);
    assert.deepEqual(report.drift, []);
    assert.equal(report.readBackOk, true);

    const unchanged = await reference.item('acct_aurora_0001', 'aurora').read();
    assert.equal(unchanged.etag, before.etag, 'a repeat seed must not write');
    const counted = await reference.items.query<number>('SELECT VALUE COUNT(1) FROM c').fetchAll();
    assert.deepEqual(counted.resources, [expected]);
  });

  it('reports drift without overwriting, and only --allow-drift accepts it', { timeout: 120_000 }, async () => {
    const database = `resolve_seedtest_${randomBytes(4).toString('hex')}`;
    throwawayDatabases.push(database);
    await provisionDatabase({ endpoint: stack.cosmosEndpoint, key: stack.cosmosKey, manifest: await loadManifest(ROOT), database });

    const first = await seed(database);
    assert.equal(first.code, EXIT.ok, first.stderr);
    assert.equal(first.report?.created, expected);
    assert.equal(first.report?.readBackOk, true);

    const item = cosmos.database(database).container('reference').item('acct_aurora_0001', 'aurora');
    const stored = (await item.read<Record<string, unknown>>()).resource;
    assert.ok(stored);
    await item.replace({ ...stored, tampered: true });

    const second = await seed(database);
    assert.equal(second.code, EXIT.drift, second.stderr);
    assert.deepEqual(second.report?.drift, [{ tenantId: 'aurora', id: 'acct_aurora_0001' }]);
    assert.equal(second.report?.created, 0);
    assert.equal(((await item.read<Record<string, unknown>>()).resource)?.['tampered'], true, 'the drifted document was left as found');

    const accepted = await seed(database, ['--allow-drift']);
    assert.equal(accepted.code, EXIT.ok, accepted.stderr);
    assert.equal(accepted.report?.drift.length, 1);
  });
});

describe('provisioning', () => {
  it('matches the manifest and can be repeated', async () => {
    const manifest = await loadManifest(ROOT);
    const database = cosmos.database(stack.database);
    for (const spec of manifest.containers) {
      const { resource } = await database.container(spec.name).read();
      assert.ok(resource, `container ${spec.name} is readable`);
      assert.deepEqual(containerDifferences(spec, resource), [], spec.name);
    }
    const again = await provisionDatabase({ endpoint: stack.cosmosEndpoint, key: stack.cosmosKey, manifest, database: stack.database });
    assert.equal(again.databaseCreated, false);
    assert.deepEqual(again.containers.filter((container) => container.created), []);
  });

  it('set no throughput on the database or any container', async () => {
    const manifest = await loadManifest(ROOT);
    const database = cosmos.database(stack.database);
    const withOffer: string[] = [];
    if ((await database.readOffer()).resource !== undefined) withOffer.push(stack.database);
    for (const spec of manifest.containers) {
      if ((await database.container(spec.name).readOffer()).resource !== undefined) withOffer.push(spec.name);
    }
    assert.deepEqual(withOffer, []);
  });
});
