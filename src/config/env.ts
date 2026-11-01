import { isAzureOpenAiHostname, isCosmosAccountHostname, isLoopbackHostname } from './hosts.ts';
import {
  APPROVAL_TTL_SECONDS,
  BASE_RUN_LIMITS,
  BASE_TENANT_LIMITS,
  LIVE_MODEL_LIMITS,
  TEST_STACK_TENANT_LIMIT_CAPS,
  type RunLimits,
  type TenantLimits,
} from './limits.ts';

export type ResolveEnv = 'local' | 'ci' | 'azure';

export type CosmosConfig =
  | { endpoint: string; auth: 'emulator-key'; key: string; database: string }
  | { endpoint: string; auth: 'managed-identity'; clientId: string | undefined; database: string };

export interface AuthConfig {
  mode: 'entra' | 'test-idp';
  issuer: string;
  audiences: readonly string[];
  jwksUrl: string;
  /** Directory GUID the token must come from (`tid`); `undefined` for the loopback test IdP. */
  directoryId: string | undefined;
}

export interface LiveModelPricing {
  /** Integer micro-USD per million tokens, converted from the decimal USD amounts in the configuration. */
  inputMicroUsdPerMillionTokens: number;
  outputMicroUsdPerMillionTokens: number;
  /** The date (YYYY-MM-DD) the prices were read from the published price list. */
  asOf: string;
}

/** Present only when a live-model deployment is fully configured; there are no default prices or endpoints. */
export interface LiveModelConfig {
  /** `<origin>/openai/v1`; the client appends `/chat/completions`. */
  baseUrl: string;
  deployment: string;
  /** `none` sends no credential and is accepted only for a loopback test server outside Azure. */
  auth: 'entra' | 'none';
  tokenScope: string;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  pricing: LiveModelPricing;
}

/** Non-secret values the browser console needs before it can sign anyone in. */
export interface ConsoleConfig {
  /** Public client id of the single-page-application registration; absent when only the API is deployed. */
  entraClientId: string | undefined;
  /** The scope the console requests for the API. */
  apiScope: string;
  /** Where the console mints sign-in tokens in test-idp mode; loopback only. */
  testIdpMintUrl: string | undefined;
}

export interface Config {
  env: ResolveEnv;
  cosmos: CosmosConfig;
  auth: AuthConfig;
  tenants: readonly string[];
  agent: { mode: 'demo' | 'live'; liveApproved: boolean };
  liveModel: LiveModelConfig | null;
  console: ConsoleConfig;
  runLimits: RunLimits;
  tenantLimits: TenantLimits;
  approvalTtlMs: number;
  responseValidation: 'enforce' | 'log';
  allowedOrigins: readonly string[];
  providerFaultsEnabled: boolean;
}

/** Lists problems by variable name only. Values are never echoed because they may be secrets. */
export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type EnvMap = Readonly<Record<string, string | undefined>>;

const TENANT_ID = /^[a-z][a-z0-9_-]{2,63}$/;

class Reader {
  readonly issues: string[] = [];
  readonly #env: EnvMap;

  constructor(env: EnvMap) {
    this.#env = env;
  }

  optional(name: string): string | undefined {
    const value = this.#env[name];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  }

  required(name: string): string {
    const value = this.optional(name);
    if (value === undefined) {
      this.issues.push(`${name} is required`);
      return '';
    }
    return value;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback?: T): T {
    const value = this.optional(name);
    if (value === undefined) {
      if (fallback !== undefined) return fallback;
      this.issues.push(`${name} is required (one of ${allowed.join(', ')})`);
      return allowed[0] as T;
    }
    if (!(allowed as readonly string[]).includes(value)) {
      this.issues.push(`${name} must be one of ${allowed.join(', ')}`);
      return allowed[0] as T;
    }
    return value as T;
  }

  bool(name: string, fallback: boolean): boolean {
    const value = this.optional(name);
    if (value === undefined) return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    this.issues.push(`${name} must be true or false`);
    return fallback;
  }

  int(name: string, fallback: number, min: number, max: number): number {
    const value = this.optional(name);
    if (value === undefined) return fallback;
    if (!/^\d{1,12}$/.test(value)) {
      this.issues.push(`${name} must be an integer`);
      return fallback;
    }
    const parsed = Number(value);
    if (parsed < min || parsed > max) {
      this.issues.push(`${name} must be between ${min} and ${max}`);
      return fallback;
    }
    return parsed;
  }

  list(name: string, fallback: readonly string[]): string[] {
    const value = this.optional(name);
    if (value === undefined) return [...fallback];
    return value.split(',').map((part) => part.trim()).filter((part) => part !== '');
  }
}

function parseUrl(reader: Reader, name: string, value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    reader.issues.push(`${name} must be an absolute URL`);
    return undefined;
  }
}

function readLimits<T extends object>(
  reader: Reader,
  prefix: string,
  base: Readonly<T>,
  env: ResolveEnv,
  raisable?: Readonly<Partial<Record<keyof T, number>>>,
): T {
  const result = { ...base } as Record<string, number>;
  for (const key of Object.keys(base)) {
    const name = `RESOLVE_LIMIT_${prefix}_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    if (reader.optional(name) === undefined) continue;
    if (env === 'azure') {
      reader.issues.push(`${name} is not allowed when RESOLVE_ENV=azure`);
      continue;
    }
    const agreed = (base as Record<string, number>)[key] as number;
    const cap = Math.max(agreed, (raisable as Record<string, number | undefined> | undefined)?.[key] ?? agreed);
    result[key] = reader.int(name, agreed, 0, cap);
  }
  return result as T;
}

const LIVE_MODEL_REQUIRED = [
  'LIVE_MODEL_ENDPOINT',
  'LIVE_MODEL_DEPLOYMENT',
  'LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS',
  'LIVE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS',
  'LIVE_MODEL_PRICING_AS_OF',
] as const;

const LIVE_MODEL_OPTIONAL = ['LIVE_MODEL_AUTH', 'LIVE_MODEL_TOKEN_SCOPE', 'LIVE_MODEL_MAX_OUTPUT_TOKENS', 'LIVE_MODEL_TIMEOUT_MS'] as const;

/** The scope Azure OpenAI documents for Entra tokens in its generated REST reference; the Foundry how-tos show `https://ai.azure.com/.default`. */
export const DEFAULT_LIVE_MODEL_TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';

const DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_SCOPE = /^https:\/\/[a-z0-9.-]+\/\.default$/;
const USD_AMOUNT = /^(\d{1,4})(?:\.(\d{1,6}))?$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Decimal USD per million tokens to integer micro-USD, without floating point. Zero is refused: unknown must never look free. */
function readPrice(reader: Reader, name: string): number {
  const text = reader.required(name);
  if (text === '') return 0;
  const match = USD_AMOUNT.exec(text);
  if (match === null) {
    reader.issues.push(`${name} must be a decimal USD amount per million tokens, such as 2.5`);
    return 0;
  }
  const value = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'));
  if (value <= 0) reader.issues.push(`${name} must be greater than zero`);
  return value;
}

function readPricingDate(reader: Reader, name: string): string {
  const text = reader.required(name);
  if (text === '') return '';
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!CALENDAR_DATE.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    reader.issues.push(`${name} must be a calendar date (YYYY-MM-DD)`);
  }
  return text;
}

function readModelEndpoint(reader: Reader, name: string, env: ResolveEnv): { baseUrl: string; loopback: boolean } {
  const text = reader.required(name);
  const url = text === '' ? undefined : parseUrl(reader, name, text);
  if (url === undefined) return { baseUrl: '', loopback: false };
  const loopback = isLoopbackHostname(url.hostname);
  const acceptable = loopback ? env !== 'azure' : isAzureOpenAiHostname(url.hostname) && url.port === '';
  if (!acceptable) {
    reader.issues.push(`${name} must be an Azure OpenAI or Foundry resource endpoint`);
  }
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) reader.issues.push(`${name} must use https`);
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    reader.issues.push(`${name} must not carry credentials, a query or a fragment`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== '/openai/v1') reader.issues.push(`${name} must be the resource endpoint, optionally ending in /openai/v1`);
  return { baseUrl: `${url.origin}/openai/v1`, loopback };
}

/**
 * The live-model adapter is configured only when every required variable is present: there is no default
 * endpoint, deployment or price. Nothing set means no adapter, and a live run is then blocked. A partial
 * or invalid set is an error that names variables only.
 */
function readLiveModel(reader: Reader, env: ResolveEnv): LiveModelConfig | null {
  const present = [...LIVE_MODEL_REQUIRED, ...LIVE_MODEL_OPTIONAL].filter((name) => reader.optional(name) !== undefined);
  if (present.length === 0) return null;
  const missing = LIVE_MODEL_REQUIRED.filter((name) => reader.optional(name) === undefined);
  if (missing.length > 0) {
    for (const name of missing) reader.issues.push(`${name} is required when any other LIVE_MODEL_* setting is present`);
    return null;
  }

  const endpoint = readModelEndpoint(reader, 'LIVE_MODEL_ENDPOINT', env);
  const deployment = reader.required('LIVE_MODEL_DEPLOYMENT');
  if (deployment !== '' && !DEPLOYMENT_NAME.test(deployment)) reader.issues.push('LIVE_MODEL_DEPLOYMENT is not a valid deployment name');
  const auth = reader.oneOf('LIVE_MODEL_AUTH', ['entra', 'none'] as const, 'entra');
  if (auth === 'none' && !(endpoint.loopback && env !== 'azure')) {
    reader.issues.push('LIVE_MODEL_AUTH=none is only allowed for a loopback endpoint outside Azure');
  }
  const tokenScope = reader.optional('LIVE_MODEL_TOKEN_SCOPE') ?? DEFAULT_LIVE_MODEL_TOKEN_SCOPE;
  if (!TOKEN_SCOPE.test(tokenScope)) reader.issues.push('LIVE_MODEL_TOKEN_SCOPE must look like https://<host>/.default');

  const { maxOutputTokens, requestTimeoutMs } = LIVE_MODEL_LIMITS;
  return {
    baseUrl: endpoint.baseUrl,
    deployment,
    auth,
    tokenScope,
    maxOutputTokens: reader.int('LIVE_MODEL_MAX_OUTPUT_TOKENS', maxOutputTokens.default, maxOutputTokens.min, maxOutputTokens.max),
    requestTimeoutMs: reader.int('LIVE_MODEL_TIMEOUT_MS', requestTimeoutMs.default, requestTimeoutMs.min, requestTimeoutMs.max),
    pricing: {
      inputMicroUsdPerMillionTokens: readPrice(reader, 'LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS'),
      outputMicroUsdPerMillionTokens: readPrice(reader, 'LIVE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS'),
      asOf: readPricingDate(reader, 'LIVE_MODEL_PRICING_AS_OF'),
    },
  };
}

const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CONSOLE_SCOPE = /^[A-Za-z0-9:/._-]{3,200}$/;

function readConsole(reader: Reader, auth: AuthConfig): ConsoleConfig {
  const clientId = reader.optional('CONSOLE_ENTRA_CLIENT_ID');
  const mintText = reader.optional('TEST_IDP_MINT_URL');
  const scopeOverride = reader.optional('CONSOLE_API_SCOPE');
  if (scopeOverride !== undefined && !CONSOLE_SCOPE.test(scopeOverride)) reader.issues.push('CONSOLE_API_SCOPE is not a valid scope');

  if (auth.mode === 'entra') {
    if (clientId !== undefined && !GUID.test(clientId)) reader.issues.push('CONSOLE_ENTRA_CLIENT_ID must be a client id GUID');
    if (mintText !== undefined) reader.issues.push('TEST_IDP_MINT_URL is only allowed when AUTH_MODE=test-idp');
  } else {
    if (clientId !== undefined) reader.issues.push('CONSOLE_ENTRA_CLIENT_ID is only allowed when AUTH_MODE=entra');
    const mint = mintText === undefined ? undefined : parseUrl(reader, 'TEST_IDP_MINT_URL', mintText);
    if (mint !== undefined && (!isLoopbackHostname(mint.hostname) || !['http:', 'https:'].includes(mint.protocol))) {
      reader.issues.push('TEST_IDP_MINT_URL must be a loopback address');
    }
  }
  const audience = auth.audiences[0] ?? '';
  return {
    entraClientId: auth.mode === 'entra' ? clientId : undefined,
    apiScope: scopeOverride ?? `${audience}/access_as_user`,
    testIdpMintUrl: auth.mode === 'test-idp' ? mintText : undefined,
  };
}

export function loadConfig(env: EnvMap = process.env): Config {
  const reader = new Reader(env);
  const resolveEnv = reader.oneOf<ResolveEnv>('RESOLVE_ENV', ['local', 'ci', 'azure']);
  const onAzureHost = reader.optional('WEBSITE_SITE_NAME') !== undefined;
  if (onAzureHost && resolveEnv !== 'azure') {
    reader.issues.push('RESOLVE_ENV must be azure when running on Azure hosting');
  }

  const endpointText = reader.required('COSMOS_ENDPOINT');
  const endpoint = endpointText === '' ? undefined : parseUrl(reader, 'COSMOS_ENDPOINT', endpointText);
  const cosmosAuth = reader.oneOf('COSMOS_AUTH', ['emulator-key', 'managed-identity'] as const);
  const database = reader.optional('COSMOS_DATABASE') ?? 'resolve';
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,62}$/.test(database)) reader.issues.push('COSMOS_DATABASE is not a valid name');

  let cosmos: CosmosConfig;
  if (cosmosAuth === 'emulator-key') {
    const key = reader.required('COSMOS_KEY');
    if (resolveEnv === 'azure') reader.issues.push('COSMOS_AUTH=emulator-key is not allowed when RESOLVE_ENV=azure');
    if (endpoint && !isLoopbackHostname(endpoint.hostname)) {
      reader.issues.push('COSMOS_ENDPOINT must be a loopback address when COSMOS_AUTH=emulator-key');
    }
    cosmos = { endpoint: endpoint?.origin ?? '', auth: 'emulator-key', key, database };
  } else {
    if (resolveEnv !== 'azure') reader.issues.push('COSMOS_AUTH=managed-identity requires RESOLVE_ENV=azure');
    if (endpoint && (endpoint.protocol !== 'https:' || !isCosmosAccountHostname(endpoint.hostname))) {
      reader.issues.push('COSMOS_ENDPOINT must be an https Azure Cosmos DB account endpoint');
    }
    cosmos = {
      endpoint: endpoint?.origin ?? '',
      auth: 'managed-identity',
      clientId: reader.optional('AZURE_CLIENT_ID'),
      database,
    };
  }
  if (endpoint && endpoint.protocol === 'http:' && resolveEnv === 'azure') {
    reader.issues.push('COSMOS_ENDPOINT must use https when RESOLVE_ENV=azure');
  }

  const authMode = reader.oneOf('AUTH_MODE', ['entra', 'test-idp'] as const);
  let auth: AuthConfig;
  if (authMode === 'entra') {
    const tenantId = reader.required('ENTRA_TENANT_ID');
    if (tenantId !== '' && !GUID.test(tenantId)) {
      reader.issues.push('ENTRA_TENANT_ID must be a directory GUID');
    }
    const audiences = reader.list('ENTRA_AUDIENCE', []);
    if (audiences.length === 0) reader.issues.push('ENTRA_AUDIENCE is required');
    auth = {
      mode: 'entra',
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audiences,
      jwksUrl: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      directoryId: tenantId.toLowerCase(),
    };
  } else {
    if (resolveEnv === 'azure' || onAzureHost) {
      reader.issues.push('AUTH_MODE=test-idp is not allowed on Azure hosting');
    }
    const jwksText = reader.required('TEST_IDP_JWKS_URL');
    const jwks = jwksText === '' ? undefined : parseUrl(reader, 'TEST_IDP_JWKS_URL', jwksText);
    if (jwks && !isLoopbackHostname(jwks.hostname)) {
      reader.issues.push('TEST_IDP_JWKS_URL must be a loopback address');
    }
    auth = {
      mode: 'test-idp',
      issuer: reader.required('TEST_IDP_ISSUER'),
      audiences: [reader.required('TEST_IDP_AUDIENCE')],
      jwksUrl: jwks?.href ?? '',
      directoryId: undefined,
    };
  }

  const tenants = reader.list('RESOLVE_TENANTS', ['aurora', 'borealis']);
  if (tenants.length === 0 || tenants.some((tenant) => !TENANT_ID.test(tenant))) {
    reader.issues.push('RESOLVE_TENANTS must list valid tenant ids');
  }

  const agentMode = reader.oneOf('AGENT_MODE', ['demo', 'live'] as const, 'demo');
  const liveApproved = reader.bool('LIVE_MODEL_APPROVED', false);

  const ttlMin = resolveEnv === 'azure' ? APPROVAL_TTL_SECONDS.azureMin : APPROVAL_TTL_SECONDS.localMin;
  const approvalTtlSeconds = reader.int('APPROVAL_TTL_SECONDS', APPROVAL_TTL_SECONDS.default, ttlMin, APPROVAL_TTL_SECONDS.max);

  const responseValidation = reader.oneOf(
    'RESPONSE_VALIDATION',
    ['enforce', 'log'] as const,
    resolveEnv === 'azure' ? 'log' : 'enforce',
  );

  const allowedOrigins = reader.list('ALLOWED_ORIGINS', []).map((origin) => {
    const url = parseUrl(reader, 'ALLOWED_ORIGINS', origin);
    if (url && (url.origin !== origin || !['https:', 'http:'].includes(url.protocol))) {
      reader.issues.push('ALLOWED_ORIGINS entries must be bare http(s) origins');
    }
    if (url && url.protocol === 'http:' && resolveEnv === 'azure') {
      reader.issues.push('ALLOWED_ORIGINS must use https when RESOLVE_ENV=azure');
    }
    return origin;
  });

  const providerFaultsEnabled = reader.bool('PROVIDER_FAULTS_ENABLED', false);
  if (providerFaultsEnabled && resolveEnv === 'azure') {
    reader.issues.push('PROVIDER_FAULTS_ENABLED is not allowed when RESOLVE_ENV=azure');
  }

  const runLimits = readLimits(reader, 'RUN', BASE_RUN_LIMITS, resolveEnv);
  const tenantLimits = readLimits(reader, 'TENANT', BASE_TENANT_LIMITS, resolveEnv, TEST_STACK_TENANT_LIMIT_CAPS);
  const liveModel = readLiveModel(reader, resolveEnv);
  const consoleConfig = readConsole(reader, auth);

  if (reader.issues.length > 0) throw new ConfigError(reader.issues);

  return {
    env: resolveEnv,
    cosmos,
    auth,
    tenants,
    agent: { mode: agentMode, liveApproved },
    liveModel,
    console: consoleConfig,
    runLimits,
    tenantLimits,
    approvalTtlMs: approvalTtlSeconds * 1000,
    responseValidation,
    allowedOrigins,
    providerFaultsEnabled,
  };
}
