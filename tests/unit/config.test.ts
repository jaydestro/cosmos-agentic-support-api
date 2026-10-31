import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../../src/config/env.ts';
import { APPROVAL_TTL_SECONDS, BASE_RUN_LIMITS, BASE_TENANT_LIMITS } from '../../src/config/limits.ts';
import { readTriggerTuning } from '../../src/config/trigger.ts';

type Env = Record<string, string | undefined>;

const LOCAL: Env = {
  RESOLVE_ENV: 'local',
  COSMOS_ENDPOINT: 'http://127.0.0.1:8081',
  COSMOS_AUTH: 'emulator-key',
  COSMOS_KEY: 'unit-test-key',
  AUTH_MODE: 'test-idp',
  TEST_IDP_JWKS_URL: 'http://127.0.0.1:9/jwks',
  TEST_IDP_ISSUER: 'http://127.0.0.1:9',
  TEST_IDP_AUDIENCE: 'api://resolve-unit-test',
};

const DIRECTORY = '11111111-2222-4333-8444-555555555555';
const AZURE: Env = {
  RESOLVE_ENV: 'azure',
  WEBSITE_SITE_NAME: 'resolve-unit-test',
  COSMOS_ENDPOINT: 'https://resolve-unit-test.documents.azure.com:443/',
  COSMOS_AUTH: 'managed-identity',
  AUTH_MODE: 'entra',
  ENTRA_TENANT_ID: DIRECTORY,
  ENTRA_AUDIENCE: 'api://resolve-unit-test',
};

function issuesOf(env: Env): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    return error.issues;
  }
  return assert.fail('the configuration should have been rejected');
}

function assertIssue(env: Env, pattern: RegExp): void {
  const issues = issuesOf(env);
  assert.ok(issues.some((issue) => pattern.test(issue)), `no issue matches ${String(pattern)} in: ${issues.join(' | ')}`);
}

const overrideName = (prefix: 'RUN' | 'TENANT', key: string): string =>
  `RESOLVE_LIMIT_${prefix}_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;

describe('loadConfig', () => {
  it('loads a local emulator configuration with the documented defaults', () => {
    const config = loadConfig(LOCAL);
    assert.equal(config.env, 'local');
    assert.deepEqual(config.cosmos, { endpoint: 'http://127.0.0.1:8081', auth: 'emulator-key', key: 'unit-test-key', database: 'resolve' });
    assert.deepEqual(config.auth, {
      mode: 'test-idp',
      issuer: 'http://127.0.0.1:9',
      audiences: ['api://resolve-unit-test'],
      jwksUrl: 'http://127.0.0.1:9/jwks',
      directoryId: undefined,
    });
    assert.deepEqual(config.tenants, ['aurora', 'borealis']);
    assert.deepEqual(config.agent, { mode: 'demo', liveApproved: false });
    assert.equal(config.liveModel, null);
    assert.deepEqual(config.console, { entraClientId: undefined, apiScope: 'api://resolve-unit-test/access_as_user', testIdpMintUrl: undefined });
    assert.deepEqual(config.runLimits, BASE_RUN_LIMITS);
    assert.deepEqual(config.tenantLimits, BASE_TENANT_LIMITS);
    assert.equal(config.approvalTtlMs, APPROVAL_TTL_SECONDS.default * 1000);
    assert.equal(config.responseValidation, 'enforce');
    assert.deepEqual(config.allowedOrigins, []);
    assert.equal(config.providerFaultsEnabled, false);
  });

  it('loads an Azure configuration that uses managed identity and Entra ID', () => {
    const config = loadConfig({ ...AZURE, AZURE_CLIENT_ID: 'client-id-for-test', ALLOWED_ORIGINS: 'https://console.example.test' });
    assert.equal(config.env, 'azure');
    assert.deepEqual(config.cosmos, {
      endpoint: 'https://resolve-unit-test.documents.azure.com',
      auth: 'managed-identity',
      clientId: 'client-id-for-test',
      database: 'resolve',
    });
    assert.equal(config.auth.mode, 'entra');
    assert.equal(config.auth.issuer, `https://login.microsoftonline.com/${DIRECTORY}/v2.0`);
    assert.equal(config.auth.jwksUrl, `https://login.microsoftonline.com/${DIRECTORY}/discovery/v2.0/keys`);
    assert.equal(config.auth.directoryId, DIRECTORY);
    assert.deepEqual(config.auth.audiences, ['api://resolve-unit-test']);
    assert.deepEqual(config.allowedOrigins, ['https://console.example.test']);
  });

  it('only logs response-contract violations on Azure unless told otherwise', () => {
    assert.equal(loadConfig(AZURE).responseValidation, 'log');
    assert.equal(loadConfig({ ...AZURE, RESPONSE_VALIDATION: 'enforce' }).responseValidation, 'enforce');
    assert.equal(loadConfig({ ...LOCAL, RESPONSE_VALIDATION: 'log' }).responseValidation, 'log');
  });

  it('lower-cases the directory id, trims values and treats blanks as unset', () => {
    const config = loadConfig({ ...AZURE, ENTRA_TENANT_ID: `  ${DIRECTORY.toUpperCase()}  `, COSMOS_DATABASE: '   ', AZURE_CLIENT_ID: ' ' });
    assert.equal(config.auth.directoryId, DIRECTORY);
    assert.equal(config.cosmos.database, 'resolve');
    assert.equal(config.cosmos.auth === 'managed-identity' ? config.cosmos.clientId : 'wrong', undefined);
  });

  it('accepts several audiences, tenants and origins as comma-separated lists', () => {
    const config = loadConfig({
      ...AZURE,
      ENTRA_AUDIENCE: 'api://one, api://two',
      RESOLVE_TENANTS: 'aurora, borealis ,cobalt',
      ALLOWED_ORIGINS: 'https://a.example.test,https://b.example.test',
    });
    assert.deepEqual(config.auth.audiences, ['api://one', 'api://two']);
    assert.deepEqual(config.tenants, ['aurora', 'borealis', 'cobalt']);
    assert.deepEqual(config.allowedOrigins, ['https://a.example.test', 'https://b.example.test']);
  });

  it('reports every missing variable at once, by name', () => {
    const issues = issuesOf({});
    for (const name of ['RESOLVE_ENV', 'COSMOS_ENDPOINT', 'COSMOS_AUTH', 'AUTH_MODE']) {
      assert.ok(issues.some((issue) => issue.startsWith(`${name} is required`)), `${name} in ${issues.join(' | ')}`);
    }
  });

  it('puts the problems in the message and in the issues array', () => {
    try {
      loadConfig({});
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.name, 'ConfigError');
      assert.ok(error.issues.length >= 4);
      assert.ok(error.message.startsWith('Invalid configuration: '));
      assert.ok(error.message.includes(error.issues[0] ?? 'missing'));
    }
  });

  it('never echoes a supplied value, so a secret in the wrong place stays out of the message', () => {
    const secret = 'hunter2-secret-value';
    const problems: Env[] = [
      { ...LOCAL, COSMOS_KEY: secret, AUTH_MODE: 'bogus' },
      { ...LOCAL, COSMOS_ENDPOINT: `not a url ${secret}` },
      { ...LOCAL, ALLOWED_ORIGINS: `nonsense ${secret}` },
      { ...LOCAL, RESOLVE_TENANTS: `${secret}!` },
      { ...LOCAL, APPROVAL_TTL_SECONDS: secret },
      { ...AZURE, ENTRA_TENANT_ID: secret },
      { ...LOCAL, COSMOS_AUTH: secret },
    ];
    for (const env of problems) {
      assert.equal(issuesOf(env).join('\n').includes(secret), false, JSON.stringify(env));
    }
  });
});

describe('configuration guards', () => {
  const cases: { name: string; env: Env; issue: RegExp }[] = [
    { name: 'Azure hosting without RESOLVE_ENV=azure', env: { ...LOCAL, WEBSITE_SITE_NAME: 'resolve-unit-test' }, issue: /RESOLVE_ENV must be azure when running on Azure hosting/ },
    { name: 'an unknown environment name', env: { ...LOCAL, RESOLVE_ENV: 'prod' }, issue: /RESOLVE_ENV must be one of local, ci, azure/ },
    { name: 'the emulator key in Azure', env: { ...AZURE, COSMOS_AUTH: 'emulator-key', COSMOS_KEY: 'k' }, issue: /COSMOS_AUTH=emulator-key is not allowed when RESOLVE_ENV=azure/ },
    { name: 'the emulator key against a remote endpoint', env: { ...LOCAL, COSMOS_ENDPOINT: 'http://resolve-unit-test.documents.azure.com' }, issue: /COSMOS_ENDPOINT must be a loopback address/ },
    { name: 'the emulator key without a key', env: { ...LOCAL, COSMOS_KEY: undefined }, issue: /COSMOS_KEY is required/ },
    { name: 'managed identity outside Azure', env: { ...LOCAL, COSMOS_AUTH: 'managed-identity', COSMOS_ENDPOINT: 'https://resolve-unit-test.documents.azure.com' }, issue: /COSMOS_AUTH=managed-identity requires RESOLVE_ENV=azure/ },
    { name: 'managed identity against a host that is not a Cosmos DB account', env: { ...AZURE, COSMOS_ENDPOINT: 'https://example.test' }, issue: /must be an https Azure Cosmos DB account endpoint/ },
    { name: 'managed identity over plain http', env: { ...AZURE, COSMOS_ENDPOINT: 'http://resolve-unit-test.documents.azure.com' }, issue: /COSMOS_ENDPOINT must use https when RESOLVE_ENV=azure/ },
    { name: 'a malformed endpoint', env: { ...LOCAL, COSMOS_ENDPOINT: 'not a url' }, issue: /COSMOS_ENDPOINT must be an absolute URL/ },
    { name: 'an invalid database name', env: { ...LOCAL, COSMOS_DATABASE: '1 bad name' }, issue: /COSMOS_DATABASE is not a valid name/ },
    { name: 'the test identity provider in Azure', env: { ...AZURE, AUTH_MODE: 'test-idp', TEST_IDP_JWKS_URL: 'http://127.0.0.1:9/jwks', TEST_IDP_ISSUER: 'x', TEST_IDP_AUDIENCE: 'y' }, issue: /AUTH_MODE=test-idp is not allowed on Azure hosting/ },
    { name: 'the test identity provider on an Azure host', env: { ...LOCAL, WEBSITE_SITE_NAME: 'resolve-unit-test' }, issue: /AUTH_MODE=test-idp is not allowed on Azure hosting/ },
    { name: 'a test identity provider outside loopback', env: { ...LOCAL, TEST_IDP_JWKS_URL: 'https://example.test/jwks' }, issue: /TEST_IDP_JWKS_URL must be a loopback address/ },
    { name: 'a test identity provider without an issuer', env: { ...LOCAL, TEST_IDP_ISSUER: undefined }, issue: /TEST_IDP_ISSUER is required/ },
    { name: 'a malformed directory id', env: { ...AZURE, ENTRA_TENANT_ID: 'not-a-guid' }, issue: /ENTRA_TENANT_ID must be a directory GUID/ },
    { name: 'Entra ID without an audience', env: { ...AZURE, ENTRA_AUDIENCE: undefined }, issue: /ENTRA_AUDIENCE is required/ },
    { name: 'a tenant id that is not valid', env: { ...LOCAL, RESOLVE_TENANTS: 'Aurora,x' }, issue: /RESOLVE_TENANTS must list valid tenant ids/ },
    { name: 'an empty tenant list', env: { ...LOCAL, RESOLVE_TENANTS: ' , ' }, issue: /RESOLVE_TENANTS must list valid tenant ids/ },
    { name: 'an unknown agent mode', env: { ...LOCAL, AGENT_MODE: 'auto' }, issue: /AGENT_MODE must be one of demo, live/ },
    { name: 'a live-approval flag that is not a boolean', env: { ...LOCAL, LIVE_MODEL_APPROVED: 'yes' }, issue: /LIVE_MODEL_APPROVED must be true or false/ },
    { name: 'an approval expiry below the local floor', env: { ...LOCAL, APPROVAL_TTL_SECONDS: '1' }, issue: /APPROVAL_TTL_SECONDS must be between 2 and 604800/ },
    { name: 'an approval expiry below the Azure floor', env: { ...AZURE, APPROVAL_TTL_SECONDS: '60' }, issue: /APPROVAL_TTL_SECONDS must be between 3600 and 604800/ },
    { name: 'an approval expiry above the cap', env: { ...LOCAL, APPROVAL_TTL_SECONDS: '604801' }, issue: /APPROVAL_TTL_SECONDS must be between 2 and 604800/ },
    { name: 'an approval expiry that is not an integer', env: { ...LOCAL, APPROVAL_TTL_SECONDS: '1.5' }, issue: /APPROVAL_TTL_SECONDS must be an integer/ },
    { name: 'an allowed origin with a path', env: { ...LOCAL, ALLOWED_ORIGINS: 'https://console.example.test/app' }, issue: /ALLOWED_ORIGINS entries must be bare http\(s\) origins/ },
    { name: 'an allowed origin that is not http or https', env: { ...LOCAL, ALLOWED_ORIGINS: 'ftp://console.example.test' }, issue: /ALLOWED_ORIGINS entries must be bare http\(s\) origins/ },
    { name: 'an allowed origin over http in Azure', env: { ...AZURE, ALLOWED_ORIGINS: 'http://console.example.test' }, issue: /ALLOWED_ORIGINS must use https when RESOLVE_ENV=azure/ },
    { name: 'a malformed allowed origin', env: { ...LOCAL, ALLOWED_ORIGINS: 'nonsense' }, issue: /ALLOWED_ORIGINS must be an absolute URL/ },
    { name: 'provider fault injection in Azure', env: { ...AZURE, PROVIDER_FAULTS_ENABLED: 'true' }, issue: /PROVIDER_FAULTS_ENABLED is not allowed when RESOLVE_ENV=azure/ },
    { name: 'a response validation mode that does not exist', env: { ...LOCAL, RESPONSE_VALIDATION: 'maybe' }, issue: /RESPONSE_VALIDATION must be one of enforce, log/ },
  ];

  for (const { name, env, issue } of cases) {
    it(`rejects ${name}`, () => {
      assertIssue(env, issue);
    });
  }

  it('lets local and CI enable fault injection and live approval only by an explicit flag', () => {
    assert.equal(loadConfig({ ...LOCAL, PROVIDER_FAULTS_ENABLED: 'true' }).providerFaultsEnabled, true);
    assert.equal(loadConfig({ ...LOCAL, RESOLVE_ENV: 'ci', AGENT_MODE: 'live', LIVE_MODEL_APPROVED: 'true' }).agent.liveApproved, true);
    assert.equal(loadConfig({ ...LOCAL, AGENT_MODE: 'live' }).agent.liveApproved, false);
  });

  it('applies the approval expiry bounds of the environment', () => {
    assert.equal(loadConfig({ ...LOCAL, APPROVAL_TTL_SECONDS: '2' }).approvalTtlMs, 2_000);
    assert.equal(loadConfig({ ...AZURE, APPROVAL_TTL_SECONDS: '3600' }).approvalTtlMs, 3_600_000);
    assert.equal(loadConfig({ ...AZURE, APPROVAL_TTL_SECONDS: '604800' }).approvalTtlMs, 604_800_000);
  });
});

const MODEL: Env = {
  LIVE_MODEL_ENDPOINT: 'https://resolve-unit-test.openai.azure.com/',
  LIVE_MODEL_DEPLOYMENT: 'resolve-unit-test',
  LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS: '2.5',
  LIVE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS: '10',
  LIVE_MODEL_PRICING_AS_OF: '2026-10-01',
};

describe('live model configuration', () => {
  it('has no adapter unless one is configured, with or without the approval flag', () => {
    assert.equal(loadConfig(AZURE).liveModel, null);
    assert.equal(loadConfig({ ...AZURE, AGENT_MODE: 'live' }).liveModel, null);
    assert.equal(loadConfig({ ...LOCAL, AGENT_MODE: 'live', LIVE_MODEL_APPROVED: 'true' }).liveModel, null);
  });

  it('reads a configured Azure OpenAI deployment with the documented defaults', () => {
    assert.deepEqual(loadConfig({ ...AZURE, ...MODEL }).liveModel, {
      baseUrl: 'https://resolve-unit-test.openai.azure.com/openai/v1',
      deployment: 'resolve-unit-test',
      auth: 'entra',
      tokenScope: 'https://cognitiveservices.azure.com/.default',
      maxOutputTokens: 1024,
      requestTimeoutMs: 30_000,
      pricing: { inputMicroUsdPerMillionTokens: 2_500_000, outputMicroUsdPerMillionTokens: 10_000_000, asOf: '2026-10-01' },
    });
  });

  it('does not treat the approval flag as model configuration, so approval alone never names an endpoint', () => {
    const config = loadConfig({ ...AZURE, LIVE_MODEL_APPROVED: 'true' });
    assert.equal(config.liveModel, null);
    assert.equal(config.agent.liveApproved, true);
  });

  it('normalises every accepted endpoint form to the resource origin plus /openai/v1', () => {
    const forms = [
      'https://resolve-unit-test.openai.azure.com',
      'https://resolve-unit-test.openai.azure.com/',
      'https://resolve-unit-test.openai.azure.com/openai/v1',
      'https://resolve-unit-test.openai.azure.com/openai/v1/',
      'https://RESOLVE-UNIT-TEST.openai.azure.com/openai/v1/',
    ];
    for (const endpoint of forms) {
      assert.equal(loadConfig({ ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: endpoint }).liveModel?.baseUrl, 'https://resolve-unit-test.openai.azure.com/openai/v1', endpoint);
    }
    assert.equal(loadConfig({ ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'https://resolve-unit-test.services.ai.azure.com/openai/v1/' }).liveModel?.baseUrl, 'https://resolve-unit-test.services.ai.azure.com/openai/v1');
    assert.equal(loadConfig({ ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'https://resolve-unit-test.cognitiveservices.azure.com' }).liveModel?.baseUrl, 'https://resolve-unit-test.cognitiveservices.azure.com/openai/v1');
  });

  it('converts decimal prices to integer micro-USD without floating point', () => {
    const price = (value: string): number | undefined =>
      loadConfig({ ...AZURE, ...MODEL, LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS: value }).liveModel?.pricing.inputMicroUsdPerMillionTokens;
    assert.equal(price('3'), 3_000_000);
    assert.equal(price('0.15'), 150_000);
    assert.equal(price('0.1'), 100_000);
    assert.equal(price('0.000001'), 1);
    assert.equal(price('1234.567891'), 1_234_567_891);
    assert.equal(price('9999.999999'), 9_999_999_999);
  });

  it('accepts bounded output and timeout settings and a different token scope', () => {
    const config = loadConfig({
      ...AZURE,
      ...MODEL,
      LIVE_MODEL_MAX_OUTPUT_TOKENS: '256',
      LIVE_MODEL_TIMEOUT_MS: '5000',
      LIVE_MODEL_TOKEN_SCOPE: 'https://ai.azure.com/.default',
    }).liveModel;
    assert.equal(config?.maxOutputTokens, 256);
    assert.equal(config?.requestTimeoutMs, 5000);
    assert.equal(config?.tokenScope, 'https://ai.azure.com/.default');
    assert.equal(loadConfig({ ...AZURE, ...MODEL, LIVE_MODEL_MAX_OUTPUT_TOKENS: '64' }).liveModel?.maxOutputTokens, 64);
    assert.equal(loadConfig({ ...AZURE, ...MODEL, LIVE_MODEL_MAX_OUTPUT_TOKENS: '4096' }).liveModel?.maxOutputTokens, 4096);
    assert.equal(loadConfig({ ...AZURE, ...MODEL, LIVE_MODEL_TIMEOUT_MS: '60000' }).liveModel?.requestTimeoutMs, 60_000);
  });

  it('allows an unauthenticated loopback model server for local and CI runs only', () => {
    const loopback = { ...MODEL, LIVE_MODEL_ENDPOINT: 'http://127.0.0.1:9', LIVE_MODEL_AUTH: 'none' };
    for (const base of [LOCAL, { ...LOCAL, RESOLVE_ENV: 'ci' }]) {
      const config = loadConfig({ ...base, ...loopback }).liveModel;
      assert.equal(config?.baseUrl, 'http://127.0.0.1:9/openai/v1');
      assert.equal(config?.auth, 'none');
    }
    assertIssue({ ...AZURE, ...loopback }, /LIVE_MODEL_ENDPOINT must be an Azure OpenAI or Foundry resource endpoint/);
    assertIssue({ ...AZURE, ...loopback }, /LIVE_MODEL_AUTH=none is only allowed for a loopback endpoint outside Azure/);
  });

  const rejected: { name: string; env: Env; issue: RegExp }[] = [
    { name: 'a setting without the required ones', env: { ...AZURE, LIVE_MODEL_ENDPOINT: MODEL.LIVE_MODEL_ENDPOINT }, issue: /LIVE_MODEL_DEPLOYMENT is required when any other LIVE_MODEL_\* setting is present/ },
    { name: 'an optional setting on its own', env: { ...AZURE, LIVE_MODEL_AUTH: 'entra' }, issue: /LIVE_MODEL_ENDPOINT is required when any other LIVE_MODEL_\* setting is present/ },
    { name: 'a missing price', env: { ...AZURE, ...MODEL, LIVE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS: undefined }, issue: /LIVE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS is required when any other/ },
    { name: 'a missing pricing date', env: { ...AZURE, ...MODEL, LIVE_MODEL_PRICING_AS_OF: undefined }, issue: /LIVE_MODEL_PRICING_AS_OF is required when any other/ },
    { name: 'an endpoint that is not an Azure OpenAI host', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'https://example.test' }, issue: /LIVE_MODEL_ENDPOINT must be an Azure OpenAI or Foundry resource endpoint/ },
    { name: 'a look-alike host', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'https://resolve-unit-test.openai.azure.com.example.test' }, issue: /must be an Azure OpenAI or Foundry resource endpoint/ },
    { name: 'a bare service domain', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'https://openai.azure.com' }, issue: /must be an Azure OpenAI or Foundry resource endpoint/ },
    { name: 'an endpoint with a port', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'https://resolve-unit-test.openai.azure.com:8443' }, issue: /must be an Azure OpenAI or Foundry resource endpoint/ },
    { name: 'a loopback endpoint in Azure', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'http://127.0.0.1:9' }, issue: /must be an Azure OpenAI or Foundry resource endpoint/ },
    { name: 'an Azure endpoint over http', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'http://resolve-unit-test.openai.azure.com' }, issue: /LIVE_MODEL_ENDPOINT must use https/ },
    { name: 'an endpoint with credentials', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'https://name:value@resolve-unit-test.openai.azure.com' }, issue: /must not carry credentials, a query or a fragment/ },
    { name: 'an endpoint with a query string', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'https://resolve-unit-test.openai.azure.com/?api-version=v1' }, issue: /must not carry credentials, a query or a fragment/ },
    { name: 'an endpoint with a fragment', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'https://resolve-unit-test.openai.azure.com/#x' }, issue: /must not carry credentials, a query or a fragment/ },
    { name: 'an endpoint with another path', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'https://resolve-unit-test.openai.azure.com/openai/deployments/x' }, issue: /must be the resource endpoint, optionally ending in \/openai\/v1/ },
    { name: 'a malformed endpoint', env: { ...AZURE, ...MODEL, LIVE_MODEL_ENDPOINT: 'not a url' }, issue: /LIVE_MODEL_ENDPOINT must be an absolute URL/ },
    { name: 'a deployment name that starts with a dash', env: { ...AZURE, ...MODEL, LIVE_MODEL_DEPLOYMENT: '-model' }, issue: /LIVE_MODEL_DEPLOYMENT is not a valid deployment name/ },
    { name: 'a deployment name with a space', env: { ...AZURE, ...MODEL, LIVE_MODEL_DEPLOYMENT: 'two words' }, issue: /LIVE_MODEL_DEPLOYMENT is not a valid deployment name/ },
    { name: 'a deployment name over 64 characters', env: { ...AZURE, ...MODEL, LIVE_MODEL_DEPLOYMENT: 'a'.repeat(65) }, issue: /LIVE_MODEL_DEPLOYMENT is not a valid deployment name/ },
    { name: 'an unknown authentication mode', env: { ...AZURE, ...MODEL, LIVE_MODEL_AUTH: 'key' }, issue: /LIVE_MODEL_AUTH must be one of entra, none/ },
    { name: 'no authentication for an Azure endpoint', env: { ...LOCAL, ...MODEL, LIVE_MODEL_AUTH: 'none' }, issue: /LIVE_MODEL_AUTH=none is only allowed for a loopback endpoint outside Azure/ },
    { name: 'a token scope that is not an https resource', env: { ...AZURE, ...MODEL, LIVE_MODEL_TOKEN_SCOPE: 'api://resolve-unit-test/.default' }, issue: /LIVE_MODEL_TOKEN_SCOPE must look like/ },
    { name: 'a token scope that does not end in .default', env: { ...AZURE, ...MODEL, LIVE_MODEL_TOKEN_SCOPE: 'https://ai.azure.com/user_impersonation' }, issue: /LIVE_MODEL_TOKEN_SCOPE must look like/ },
    { name: 'an output cap below the floor', env: { ...AZURE, ...MODEL, LIVE_MODEL_MAX_OUTPUT_TOKENS: '63' }, issue: /LIVE_MODEL_MAX_OUTPUT_TOKENS must be between 64 and 4096/ },
    { name: 'an output cap above the ceiling', env: { ...AZURE, ...MODEL, LIVE_MODEL_MAX_OUTPUT_TOKENS: '4097' }, issue: /LIVE_MODEL_MAX_OUTPUT_TOKENS must be between 64 and 4096/ },
    { name: 'an output cap that is not an integer', env: { ...AZURE, ...MODEL, LIVE_MODEL_MAX_OUTPUT_TOKENS: '1k' }, issue: /LIVE_MODEL_MAX_OUTPUT_TOKENS must be an integer/ },
    { name: 'a timeout below the floor', env: { ...AZURE, ...MODEL, LIVE_MODEL_TIMEOUT_MS: '999' }, issue: /LIVE_MODEL_TIMEOUT_MS must be between 1000 and 60000/ },
    { name: 'a timeout above the ceiling', env: { ...AZURE, ...MODEL, LIVE_MODEL_TIMEOUT_MS: '60001' }, issue: /LIVE_MODEL_TIMEOUT_MS must be between 1000 and 60000/ },
    { name: 'a zero price, which would make unknown cost look free', env: { ...AZURE, ...MODEL, LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS: '0' }, issue: /LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS must be greater than zero/ },
    { name: 'a price of zero with decimals', env: { ...AZURE, ...MODEL, LIVE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS: '0.000000' }, issue: /LIVE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS must be greater than zero/ },
    { name: 'a negative price', env: { ...AZURE, ...MODEL, LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS: '-1' }, issue: /LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS must be a decimal USD amount/ },
    { name: 'a price in exponent notation', env: { ...AZURE, ...MODEL, LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS: '1e3' }, issue: /must be a decimal USD amount/ },
    { name: 'a price with a comma', env: { ...AZURE, ...MODEL, LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS: '2,5' }, issue: /must be a decimal USD amount/ },
    { name: 'a price with more than six decimals', env: { ...AZURE, ...MODEL, LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS: '0.1234567' }, issue: /must be a decimal USD amount/ },
    { name: 'a price with five integer digits', env: { ...AZURE, ...MODEL, LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS: '12345' }, issue: /must be a decimal USD amount/ },
    { name: 'a pricing date in the wrong format', env: { ...AZURE, ...MODEL, LIVE_MODEL_PRICING_AS_OF: '10/01/2026' }, issue: /LIVE_MODEL_PRICING_AS_OF must be a calendar date/ },
    { name: 'a pricing date that is not a day', env: { ...AZURE, ...MODEL, LIVE_MODEL_PRICING_AS_OF: '2026-02-30' }, issue: /LIVE_MODEL_PRICING_AS_OF must be a calendar date/ },
    { name: 'a pricing month that does not exist', env: { ...AZURE, ...MODEL, LIVE_MODEL_PRICING_AS_OF: '2026-13-01' }, issue: /LIVE_MODEL_PRICING_AS_OF must be a calendar date/ },
  ];

  for (const { name, env, issue } of rejected) {
    it(`rejects ${name}`, () => {
      assertIssue(env, issue);
    });
  }

  it('reports a rejected value by variable name only', () => {
    const issues = issuesOf({
      ...AZURE,
      ...MODEL,
      LIVE_MODEL_ENDPOINT: 'https://leaked-user:leaked-secret@resolve-unit-test.openai.azure.com/leaked-path?leaked-query=1',
      LIVE_MODEL_DEPLOYMENT: 'leaked deployment',
      LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS: 'leaked-price',
    });
    assert.ok(issues.length >= 3);
    for (const issue of issues) assert.doesNotMatch(issue, /leaked/);
  });
});

describe('console configuration', () => {
  const CLIENT_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

  it('derives the API scope from the first audience', () => {
    assert.equal(loadConfig({ ...AZURE, ENTRA_AUDIENCE: 'api://resolve-first,api://resolve-second' }).console.apiScope, 'api://resolve-first/access_as_user');
    assert.equal(loadConfig({ ...LOCAL, CONSOLE_API_SCOPE: 'api://other/access_as_user' }).console.apiScope, 'api://other/access_as_user');
  });

  it('carries the single-page application client id for Entra ID only', () => {
    assert.equal(loadConfig(AZURE).console.entraClientId, undefined);
    assert.equal(loadConfig({ ...AZURE, CONSOLE_ENTRA_CLIENT_ID: CLIENT_ID }).console.entraClientId, CLIENT_ID);
    assertIssue({ ...AZURE, CONSOLE_ENTRA_CLIENT_ID: 'not-a-guid' }, /CONSOLE_ENTRA_CLIENT_ID must be a client id GUID/);
    assertIssue({ ...LOCAL, CONSOLE_ENTRA_CLIENT_ID: CLIENT_ID }, /CONSOLE_ENTRA_CLIENT_ID is only allowed when AUTH_MODE=entra/);
  });

  it('carries the test identity provider mint address for the test identity provider only', () => {
    assert.equal(loadConfig({ ...LOCAL, TEST_IDP_MINT_URL: 'http://127.0.0.1:9/mint' }).console.testIdpMintUrl, 'http://127.0.0.1:9/mint');
    assertIssue({ ...LOCAL, TEST_IDP_MINT_URL: 'https://example.test/mint' }, /TEST_IDP_MINT_URL must be a loopback address/);
    assertIssue({ ...LOCAL, TEST_IDP_MINT_URL: 'ftp://127.0.0.1/mint' }, /TEST_IDP_MINT_URL must be a loopback address/);
    assertIssue({ ...LOCAL, TEST_IDP_MINT_URL: 'nonsense' }, /TEST_IDP_MINT_URL must be an absolute URL/);
    assertIssue({ ...AZURE, TEST_IDP_MINT_URL: 'http://127.0.0.1:9/mint' }, /TEST_IDP_MINT_URL is only allowed when AUTH_MODE=test-idp/);
  });

  it('refuses a scope override that is not a plain scope', () => {
    assertIssue({ ...LOCAL, CONSOLE_API_SCOPE: 'two words' }, /CONSOLE_API_SCOPE is not a valid scope/);
    assertIssue({ ...LOCAL, CONSOLE_API_SCOPE: 'a' }, /CONSOLE_API_SCOPE is not a valid scope/);
  });
});

describe('limit overrides', () => {
  it('names each override after its limit', () => {
    assert.equal(overrideName('RUN', 'costMicroUsd'), 'RESOLVE_LIMIT_RUN_COST_MICRO_USD');
    assert.equal(overrideName('TENANT', 'liveCostMicroUsdPerUtcDay'), 'RESOLVE_LIMIT_TENANT_LIVE_COST_MICRO_USD_PER_UTC_DAY');
  });

  it('lets every run and tenant limit be lowered through its generated variable', () => {
    for (const key of Object.keys(BASE_RUN_LIMITS) as (keyof typeof BASE_RUN_LIMITS)[]) {
      const config = loadConfig({ ...LOCAL, [overrideName('RUN', key)]: '1' });
      assert.equal(config.runLimits[key], 1, key);
      assert.deepEqual({ ...config.runLimits, [key]: BASE_RUN_LIMITS[key] }, BASE_RUN_LIMITS, `${key} must change alone`);
    }
    for (const key of Object.keys(BASE_TENANT_LIMITS) as (keyof typeof BASE_TENANT_LIMITS)[]) {
      const config = loadConfig({ ...LOCAL, [overrideName('TENANT', key)]: '1' });
      assert.equal(config.tenantLimits[key], 1, key);
      assert.deepEqual({ ...config.tenantLimits, [key]: BASE_TENANT_LIMITS[key] }, BASE_TENANT_LIMITS, `${key} must change alone`);
    }
  });

  it('accepts zero, which stops that kind of work, and the ceiling itself', () => {
    assert.equal(loadConfig({ ...LOCAL, RESOLVE_LIMIT_RUN_MODEL_CALLS: '0' }).runLimits.modelCalls, 0);
    assert.equal(loadConfig({ ...LOCAL, RESOLVE_LIMIT_RUN_STEPS: String(BASE_RUN_LIMITS.steps) }).runLimits.steps, BASE_RUN_LIMITS.steps);
  });

  it('refuses to raise a run budget or the live spending limit above the agreed ceiling', () => {
    assertIssue({ ...LOCAL, RESOLVE_LIMIT_RUN_STEPS: String(BASE_RUN_LIMITS.steps + 1) }, /RESOLVE_LIMIT_RUN_STEPS must be between 0 and 8/);
    assertIssue(
      { ...LOCAL, RESOLVE_LIMIT_TENANT_LIVE_COST_MICRO_USD_PER_UTC_DAY: String(BASE_TENANT_LIMITS.liveCostMicroUsdPerUtcDay + 1) },
      /RESOLVE_LIMIT_TENANT_LIVE_COST_MICRO_USD_PER_UTC_DAY must be between 0 and 2000000/,
    );
    for (const key of Object.keys(BASE_RUN_LIMITS) as (keyof typeof BASE_RUN_LIMITS)[]) {
      assertIssue({ ...LOCAL, [overrideName('RUN', key)]: String(BASE_RUN_LIMITS[key] + 1) }, /must be between 0 and/);
    }
  });

  it('lets local and CI raise only the two tenant admission counts, up to a hard cap', () => {
    for (const resolveEnv of ['local', 'ci']) {
      const config = loadConfig({
        ...LOCAL,
        RESOLVE_ENV: resolveEnv,
        RESOLVE_LIMIT_TENANT_CASES_PER_UTC_DAY: '1000',
        RESOLVE_LIMIT_TENANT_CONCURRENT_RUNS: '100',
      });
      assert.deepEqual(config.tenantLimits, { ...BASE_TENANT_LIMITS, casesPerUtcDay: 1000, concurrentRuns: 100 }, resolveEnv);
    }
    assertIssue({ ...LOCAL, RESOLVE_LIMIT_TENANT_CASES_PER_UTC_DAY: '1001' }, /RESOLVE_LIMIT_TENANT_CASES_PER_UTC_DAY must be between 0 and 1000/);
    assertIssue({ ...LOCAL, RESOLVE_LIMIT_TENANT_CONCURRENT_RUNS: '101' }, /RESOLVE_LIMIT_TENANT_CONCURRENT_RUNS must be between 0 and 100/);
  });

  it('refuses values that are not whole numbers', () => {
    for (const value of ['abc', '1.5', '-1', '1e3']) {
      assertIssue({ ...LOCAL, RESOLVE_LIMIT_RUN_STEPS: value }, /RESOLVE_LIMIT_RUN_STEPS must be an integer/);
    }
  });

  it('refuses any override in Azure, so a deployment cannot change its own budget silently', () => {
    assertIssue({ ...AZURE, RESOLVE_LIMIT_RUN_STEPS: '1' }, /RESOLVE_LIMIT_RUN_STEPS is not allowed when RESOLVE_ENV=azure/);
    assertIssue({ ...AZURE, RESOLVE_LIMIT_TENANT_CONCURRENT_RUNS: '1' }, /RESOLVE_LIMIT_TENANT_CONCURRENT_RUNS is not allowed when RESOLVE_ENV=azure/);
    assertIssue({ ...AZURE, RESOLVE_LIMIT_TENANT_CASES_PER_UTC_DAY: '1000' }, /RESOLVE_LIMIT_TENANT_CASES_PER_UTC_DAY is not allowed when RESOLVE_ENV=azure/);
    assertIssue({ ...AZURE, RESOLVE_LIMIT_TENANT_CONCURRENT_RUNS: '100' }, /RESOLVE_LIMIT_TENANT_CONCURRENT_RUNS is not allowed when RESOLVE_ENV=azure/);
  });

  it('ignores a blank override', () => {
    assert.deepEqual(loadConfig({ ...LOCAL, RESOLVE_LIMIT_RUN_STEPS: '  ' }).runLimits, BASE_RUN_LIMITS);
  });
});

describe('readTriggerTuning', () => {
  const STACK_TUNING = {
    TRIGGER_FEED_POLL_MS: '500',
    TRIGGER_LEASE_ACQUIRE_MS: '2000',
    TRIGGER_LEASE_EXPIRATION_MS: '15000',
    TRIGGER_LEASE_RENEW_MS: '4000',
  };

  const rejection = (env: Env): string => {
    try {
      readTriggerTuning(env);
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      return error.issues.join(' | ');
    }
    return assert.fail('the tuning should have been rejected');
  };

  it('returns nothing when nothing is set, keeping the platform defaults', () => {
    assert.deepEqual(readTriggerTuning({}), {});
    assert.deepEqual(readTriggerTuning({ TRIGGER_FEED_POLL_MS: '', TRIGGER_LEASE_RENEW_MS: undefined }), {});
  });

  it('reads the four timers the local stack sets', () => {
    assert.deepEqual(readTriggerTuning(STACK_TUNING), {
      feedPollDelay: 500,
      leaseAcquireInterval: 2000,
      leaseExpirationInterval: 15000,
      leaseRenewInterval: 4000,
    });
  });

  it('accepts the bounds and rejects anything outside them or not a plain integer', () => {
    assert.deepEqual(readTriggerTuning({ TRIGGER_FEED_POLL_MS: '200' }), { feedPollDelay: 200 });
    assert.deepEqual(readTriggerTuning({ TRIGGER_FEED_POLL_MS: '600000' }), { feedPollDelay: 600000 });
    for (const value of ['199', '600001', '1000000', 'abc', '1.5', '-500', '0x1F4', ' 500']) {
      assert.match(rejection({ TRIGGER_FEED_POLL_MS: value }), /TRIGGER_FEED_POLL_MS must be an integer between 200 and 600000/, value);
    }
  });

  it('requires the renew and acquire intervals to be shorter than the lease expiration', () => {
    assert.match(rejection({ TRIGGER_LEASE_RENEW_MS: '60000' }), /TRIGGER_LEASE_RENEW_MS must be lower than the lease expiration interval/);
    assert.match(rejection({ TRIGGER_LEASE_ACQUIRE_MS: '60000' }), /TRIGGER_LEASE_ACQUIRE_MS must be lower than the lease expiration interval/);
    assert.match(rejection({ TRIGGER_LEASE_RENEW_MS: '5000', TRIGGER_LEASE_EXPIRATION_MS: '5000' }), /TRIGGER_LEASE_RENEW_MS must be lower/);
  });

  it('checks a lowered expiration against the platform defaults of the timers left unset', () => {
    const message = rejection({ TRIGGER_LEASE_EXPIRATION_MS: '12000' });
    assert.match(message, /TRIGGER_LEASE_RENEW_MS must be lower/);
    assert.match(message, /TRIGGER_LEASE_ACQUIRE_MS must be lower/);
  });

  it('reports every problem at once', () => {
    const message = rejection({ TRIGGER_FEED_POLL_MS: '1', TRIGGER_LEASE_ACQUIRE_MS: 'x', TRIGGER_LEASE_RENEW_MS: '70000' });
    assert.match(message, /TRIGGER_FEED_POLL_MS/);
    assert.match(message, /TRIGGER_LEASE_ACQUIRE_MS/);
    assert.match(message, /TRIGGER_LEASE_RENEW_MS must be lower/);
  });
});
