import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config/env.ts';
import { consoleSettings, ENTRA_AUTHORITY_HOST } from '../../src/http/console-config.ts';
import { ENTRA_AUTHORITY_PREFIX, parseConsoleSettings, type ParsedSettings } from '../../web/src/config.ts';

type Env = Record<string, string | undefined>;

const LOCAL: Env = {
  RESOLVE_ENV: 'local',
  COSMOS_ENDPOINT: 'http://127.0.0.1:8081',
  COSMOS_AUTH: 'emulator-key',
  COSMOS_KEY: 'unit-test-cosmos-key-value',
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

function refusal(input: unknown): string {
  const parsed: ParsedSettings = parseConsoleSettings(input);
  if (parsed.ok) assert.fail(`expected a refusal, got ${JSON.stringify(parsed.settings)}`);
  return parsed.message;
}

function accepted(input: unknown) {
  const parsed = parseConsoleSettings(input);
  if (!parsed.ok) assert.fail(`expected settings, got "${parsed.message}"`);
  return parsed.settings;
}

const testIdp = (mintUrl: unknown): unknown => ({ auth: { mode: 'test-idp', mintUrl } });
const entra = (overrides: Record<string, unknown> = {}): unknown => ({
  auth: {
    mode: 'entra',
    clientId: CLIENT_ID,
    authority: `${ENTRA_AUTHORITY_PREFIX}${DIRECTORY.toLowerCase()}`,
    scopes: ['api://resolve-unit-test/access_as_user'],
    ...overrides,
  },
});

describe('parseConsoleSettings accepts what the service sends', () => {
  it('uses the same public authority host as the service', () => {
    assert.equal(`${ENTRA_AUTHORITY_HOST}/`, ENTRA_AUTHORITY_PREFIX);
  });

  it('round-trips the test identity provider settings', () => {
    const sent = consoleSettings(loadConfig(LOCAL));
    assert.deepEqual(accepted(JSON.parse(JSON.stringify(sent))), sent);
  });

  it('round-trips a test identity provider that is not configured', () => {
    const sent = consoleSettings(loadConfig({ ...LOCAL, TEST_IDP_MINT_URL: undefined }));
    assert.deepEqual(sent, { auth: { mode: 'test-idp', mintUrl: null } });
    assert.deepEqual(accepted(JSON.parse(JSON.stringify(sent))), sent);
  });

  it('round-trips the Entra settings', () => {
    const sent = consoleSettings(loadConfig({ ...AZURE, CONSOLE_ENTRA_CLIENT_ID: CLIENT_ID }));
    assert.deepEqual(accepted(JSON.parse(JSON.stringify(sent))), sent);
  });

  it('round-trips Entra settings that have no single-page-application registration yet', () => {
    const sent = consoleSettings(loadConfig(AZURE));
    const settings = accepted(JSON.parse(JSON.stringify(sent)));
    assert.deepEqual(settings, sent);
    assert.ok(settings.auth.mode === 'entra');
    assert.equal(settings.auth.clientId, null);
  });

  it('accepts a loopback test identity provider by name or address, over http or https', () => {
    for (const url of [
      'http://127.0.0.1:65252/mint',
      'http://localhost:3000/mint',
      'http://LOCALHOST:3000/mint',
      'https://127.0.0.1:8443/mint',
      'http://[::1]:8080/mint',
      'http://127.0.0.1/mint',
    ]) {
      assert.deepEqual(accepted(testIdp(url)), { auth: { mode: 'test-idp', mintUrl: url } }, url);
    }
  });

  it('accepts Entra settings with the scopes in order', () => {
    const settings = accepted(entra({ scopes: ['api://a/one', 'api://a/two'] }));
    assert.ok(settings.auth.mode === 'entra');
    assert.deepEqual(settings.auth.scopes, ['api://a/one', 'api://a/two']);
  });

  it('accepts an Entra sign-in that is not configured', () => {
    const settings = accepted(entra({ clientId: null, authority: null, scopes: [] }));
    assert.deepEqual(settings, { auth: { mode: 'entra', clientId: null, authority: null, scopes: [] } });
  });

  it('copies only the fields it knows, so an unexpected field is not passed on', () => {
    const settings = accepted({ auth: { mode: 'test-idp', mintUrl: 'http://127.0.0.1:9/mint', extra: 'x' }, other: true });
    assert.deepEqual(settings, { auth: { mode: 'test-idp', mintUrl: 'http://127.0.0.1:9/mint' } });
  });
});

describe('parseConsoleSettings refuses everything else', () => {
  for (const [name, input] of [
    ['null', null],
    ['a string', 'text'],
    ['a number', 7],
    ['an array', []],
    ['an empty object', {}],
    ['a null auth', { auth: null }],
    ['an array auth', { auth: [] }],
    ['a string auth', { auth: 'entra' }],
  ] as const) {
    it(`refuses ${name} as not the expected shape`, () => {
      assert.equal(refusal(input), 'The console settings are not in the expected shape.');
    });
  }

  for (const mode of [undefined, null, 'basic', 'ENTRA', 'Test-Idp', '', 7]) {
    it(`refuses the sign-in mode ${JSON.stringify(mode) ?? 'undefined'}`, () => {
      assert.equal(refusal({ auth: { mode } }), 'The console settings name an unknown sign-in mode.');
    });
  }

  for (const mintUrl of [undefined, '', 7, {}, true]) {
    it(`refuses the test identity provider address ${JSON.stringify(mintUrl) ?? 'undefined'} as invalid`, () => {
      assert.equal(refusal(testIdp(mintUrl)), 'The test identity provider address is invalid.');
    });
  }

  for (const url of [
    'https://evil.example/mint',
    'http://localhost.evil.example/mint',
    'http://127.0.0.1.evil.example/mint',
    'http://127.0.0.1@evil.example/mint',
    'http://user:secret@127.0.0.1/mint',
    'http://user@localhost/mint',
    'http://127.0.0.2/mint',
    'http://0.0.0.0/mint',
    'ftp://127.0.0.1/mint',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '/mint',
    '//127.0.0.1/mint',
    'not a url',
  ]) {
    it(`refuses the test identity provider address ${url} as not loopback`, () => {
      assert.equal(refusal(testIdp(url)), 'The test identity provider must be a loopback address.');
    });
  }

  for (const [name, overrides] of [
    ['an empty client id', { clientId: '' }],
    ['a numeric client id', { clientId: 7 }],
    ['a missing client id', { clientId: undefined }],
    ['an empty authority', { authority: '' }],
    ['a numeric authority', { authority: 7 }],
    ['a missing authority', { authority: undefined }],
  ] as const) {
    it(`refuses Entra settings with ${name}`, () => {
      assert.equal(refusal(entra(overrides)), 'The sign-in settings are invalid.');
    });
  }

  for (const authority of [
    'https://evil.example/tenant',
    'http://login.microsoftonline.com/tenant',
    'https://login.microsoftonline.com',
    'https://login.microsoftonline.com.evil.example/tenant',
    'https://login.microsoftonline.com@evil.example/tenant',
    'https://login.microsoftonline.us/tenant',
  ]) {
    it(`refuses the authority ${authority} as not Microsoft Entra ID`, () => {
      assert.equal(refusal(entra({ authority })), 'The sign-in authority must be Microsoft Entra ID.');
    });
  }

  for (const [name, scopes] of [
    ['a missing list', undefined],
    ['a string', 'api://a/one'],
    ['an object', { 0: 'api://a/one' }],
    ['an empty scope', ['']],
    ['a numeric scope', [7]],
    ['a null scope', [null]],
    ['one bad scope among good ones', ['api://a/one', 7]],
  ] as const) {
    it(`refuses Entra scopes given as ${name}`, () => {
      assert.equal(refusal(entra({ scopes })), 'The sign-in scopes are invalid.');
    });
  }
});
