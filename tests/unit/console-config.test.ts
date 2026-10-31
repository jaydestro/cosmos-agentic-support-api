import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config/env.ts';
import { consoleConfigResponse, consoleConnectSources, consoleSettings } from '../../src/http/console-config.ts';
import { buildConsoleCsp, createStaticServer } from '../../src/http/static.ts';

type Env = Record<string, string | undefined>;

const COSMOS_KEY = 'unit-test-cosmos-key-value';
const LOCAL: Env = {
  RESOLVE_ENV: 'local',
  COSMOS_ENDPOINT: 'http://127.0.0.1:8081',
  COSMOS_AUTH: 'emulator-key',
  COSMOS_KEY,
  AUTH_MODE: 'test-idp',
  TEST_IDP_JWKS_URL: 'http://127.0.0.1:9/jwks.json',
  TEST_IDP_ISSUER: 'https://test-idp.resolve.invalid/',
  TEST_IDP_AUDIENCE: 'api://resolve-unit-test',
  TEST_IDP_MINT_URL: 'http://127.0.0.1:9/mint',
};

const DIRECTORY = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const CLIENT_ID = '99999999-8888-4777-8666-555555555555';
const AZURE: Env = {
  RESOLVE_ENV: 'azure',
  WEBSITE_SITE_NAME: 'resolve-unit-test',
  COSMOS_ENDPOINT: 'https://resolve-unit-test.documents.azure.com:443/',
  COSMOS_AUTH: 'managed-identity',
  AUTH_MODE: 'entra',
  ENTRA_TENANT_ID: DIRECTORY,
  ENTRA_AUDIENCE: 'api://resolve-unit-test',
};

describe('console settings', () => {
  it('names the test identity provider the console may mint sign-in tokens from', () => {
    const config = loadConfig(LOCAL);
    assert.deepEqual(consoleSettings(config), { auth: { mode: 'test-idp', mintUrl: 'http://127.0.0.1:9/mint' } });
    assert.deepEqual(consoleConnectSources(config), ['http://127.0.0.1:9']);
  });

  it('reports an unconfigured test identity provider instead of guessing an address', () => {
    const config = loadConfig({ ...LOCAL, TEST_IDP_MINT_URL: undefined });
    assert.deepEqual(consoleSettings(config), { auth: { mode: 'test-idp', mintUrl: null } });
    assert.deepEqual(consoleConnectSources(config), []);
  });

  it('describes an Entra sign-in with the lower-cased directory and the API scope', () => {
    const config = loadConfig({ ...AZURE, CONSOLE_ENTRA_CLIENT_ID: CLIENT_ID });
    assert.deepEqual(consoleSettings(config), {
      auth: {
        mode: 'entra',
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${DIRECTORY.toLowerCase()}`,
        scopes: ['api://resolve-unit-test/access_as_user'],
      },
    });
  });

  it('honours an explicit API scope', () => {
    const config = loadConfig({ ...AZURE, CONSOLE_ENTRA_CLIENT_ID: CLIENT_ID, CONSOLE_API_SCOPE: 'api://resolve-unit-test/Resolve.Access' });
    const { auth } = consoleSettings(config);
    assert.ok(auth.mode === 'entra');
    assert.deepEqual(auth.scopes, ['api://resolve-unit-test/Resolve.Access']);
  });

  it('says so when no single-page-application registration is configured', () => {
    const { auth } = consoleSettings(loadConfig(AZURE));
    assert.ok(auth.mode === 'entra');
    assert.equal(auth.clientId, null);
    assert.ok(auth.authority?.endsWith(DIRECTORY.toLowerCase()));
  });

  it('never lets an Entra deployment call anywhere but itself and Entra', () => {
    assert.deepEqual(consoleConnectSources(loadConfig({ ...AZURE, CONSOLE_ENTRA_CLIENT_ID: CLIENT_ID })), []);
    assert.deepEqual(consoleConnectSources(loadConfig(AZURE)), []);
  });

  it('does not trust the configuration reader alone: a mint address on an Entra config is ignored', () => {
    const entra = loadConfig({ ...AZURE, CONSOLE_ENTRA_CLIENT_ID: CLIENT_ID });
    const tampered = { ...entra, console: { ...entra.console, testIdpMintUrl: 'http://127.0.0.1:9/mint' } };
    assert.deepEqual(consoleConnectSources(tampered), []);
    assert.equal(JSON.stringify(consoleSettings(tampered)).includes('127.0.0.1'), false);
  });

  it('does not trust the configuration reader alone: an Entra client id on a test-idp config is ignored', () => {
    const local = loadConfig(LOCAL);
    const tampered = { ...local, console: { ...local.console, entraClientId: CLIENT_ID } };
    assert.deepEqual(consoleSettings(tampered), { auth: { mode: 'test-idp', mintUrl: 'http://127.0.0.1:9/mint' } });
  });
});

describe('the /config.json answer', () => {
  it('is JSON, uncached and complete for a GET', () => {
    const response = consoleConfigResponse(loadConfig(LOCAL), 'GET');
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
    assert.ok(response.body);
    assert.equal(response.headers['Content-Length'], String(response.body.byteLength));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(response.body)), { auth: { mode: 'test-idp', mintUrl: 'http://127.0.0.1:9/mint' } });
  });

  it('answers HEAD with the same headers and no body', () => {
    const get = consoleConfigResponse(loadConfig(LOCAL), 'GET');
    const head = consoleConfigResponse(loadConfig(LOCAL), 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, undefined);
    assert.deepEqual(head.headers, get.headers);
  });

  it('exposes only the allow-listed public settings, never a key, endpoint or verification address', () => {
    for (const env of [LOCAL, { ...AZURE, CONSOLE_ENTRA_CLIENT_ID: CLIENT_ID }]) {
      const text = new TextDecoder().decode(consoleConfigResponse(loadConfig(env), 'GET').body);
      for (const secret of [COSMOS_KEY, 'documents.azure.com', '127.0.0.1:8081', 'jwks', 'issuer', 'audience', 'api://resolve-unit-test"']) {
        assert.ok(!text.includes(secret), `the settings must not contain ${secret}`);
      }
    }
  });
});

describe('the console content security policy', () => {
  const DEFAULT_CONNECT = "connect-src 'self' https://login.microsoftonline.com";

  it('keeps the default connect sources to the page itself and Entra', () => {
    const policy = buildConsoleCsp();
    assert.ok(policy.split('; ').includes(DEFAULT_CONNECT));
    assert.deepEqual(buildConsoleCsp([]), policy);
  });

  it('adds only the configured test identity provider origin', () => {
    const policy = buildConsoleCsp(['http://127.0.0.1:41234']);
    assert.ok(policy.split('; ').includes(`${DEFAULT_CONNECT} http://127.0.0.1:41234`));
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|\*/);
    assert.match(policy, /script-src 'self'(;|$)/);
    assert.match(policy, /frame-ancestors 'none'/);
  });

  it('accepts bare http(s) origins, including a bracketed IPv6 loopback', () => {
    for (const origin of ['http://127.0.0.1:1', 'http://localhost:65535', 'https://login.example.test', 'http://[::1]:8080']) {
      assert.doesNotThrow(() => buildConsoleCsp([origin]), origin);
    }
  });

  it('refuses anything that is not a bare origin, so a setting cannot inject a directive', () => {
    for (const bad of [
      '',
      '*',
      "'self'",
      'data:',
      'javascript:alert(1)',
      'ws://127.0.0.1:1',
      'http://127.0.0.1:1/mint',
      'http://127.0.0.1:1 ; script-src *',
      'http://a b',
      'http://127.0.0.1:1;',
      'http://127.0.0.1:123456',
      'http://user@127.0.0.1:1',
      'http://127.0.0.1:1\n',
    ]) {
      assert.throws(() => buildConsoleCsp([bad]), /bare http\(s\) origin/, JSON.stringify(bad));
    }
  });

  describe('as served', () => {
    let root = '';
    before(async () => {
      root = await mkdtemp(join(tmpdir(), 'resolve-csp-'));
      await mkdir(join(root, 'reference'), { recursive: true });
      await writeFile(join(root, 'index.html'), '<!doctype html><title>console</title>');
      await writeFile(join(root, 'reference', 'index.html'), '<!doctype html><title>reference</title>');
    });
    after(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('applies the extra origin to the console page and not to the reference page', async () => {
      const server = createStaticServer(root, { connectSources: ['http://127.0.0.1:41234'] });
      const page = await server.serve('', 'GET');
      assert.match(page.headers['Content-Security-Policy'] ?? '', /connect-src 'self' https:\/\/login\.microsoftonline\.com http:\/\/127\.0\.0\.1:41234(;|$)/);
      const reference = await server.serve('reference/', 'GET');
      assert.doesNotMatch(reference.headers['Content-Security-Policy'] ?? '', /41234/);
    });

    it('serves the default policy when none is configured', async () => {
      const page = await createStaticServer(root).serve('', 'GET');
      assert.equal(page.headers['Content-Security-Policy'], buildConsoleCsp());
    });

    it('refuses to start with a source that is not a bare origin', () => {
      assert.throws(() => createStaticServer(root, { connectSources: ['http://127.0.0.1:1/mint'] }), /bare http\(s\) origin/);
    });
  });
});
