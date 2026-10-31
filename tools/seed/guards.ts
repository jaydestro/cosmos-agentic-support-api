import { parseArgs } from 'node:util';
import { cosmosAccountName, isLoopbackHostname } from '../../src/config/hosts.ts';

export const SEED_CONTAINER = 'reference';
export const SEED_PARTITION_KEY_PATH = '/tenantId';
export const DEFAULT_DATABASE = 'resolve';

export type SeedTarget = 'emulator' | 'cloud';

export class SeedGuardError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SeedGuardError';
    this.code = code;
  }
}

interface PlanBase {
  database: string;
  allowDrift: boolean;
  dryRun: boolean;
  json: boolean;
}

export interface EmulatorPlan extends PlanBase {
  target: 'emulator';
  endpoint: string;
  key: string;
}

export interface CloudPlan extends PlanBase {
  target: 'cloud';
  endpoint: string;
  accountName: string;
  /** Client id of the user-assigned managed identity dedicated to seeding. */
  clientId: string;
  /** Object id the token must carry; stops the run if another identity answers. */
  expectedPrincipalId: string;
}

export type SeedPlan = EmulatorPlan | CloudPlan;

type EnvMap = Readonly<Record<string, string | undefined>>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATABASE_NAME = /^[A-Za-z][A-Za-z0-9_-]{1,62}$/;

export const USAGE = `Usage: node tools/seed/main.ts --target <emulator|cloud> [options]

  --target <emulator|cloud>   Required. There is no default target.
  --endpoint <url>            Cosmos DB endpoint (or COSMOS_ENDPOINT).
  --database <name>           Database name (or COSMOS_DATABASE, default "${DEFAULT_DATABASE}").
  --confirm-account <name>    Cloud only. Must equal the account name in the endpoint.
  --allow-drift               Exit 0 when stored documents differ from the fixtures.
  --dry-run                   Validate fixtures and guards; make no network calls.
  --json                      Print the result as JSON.

Emulator: loopback endpoint and COSMOS_KEY (the emulator key; never an Azure key).
Cloud:    https Azure endpoint, Microsoft Entra ID only, with SEED_CLIENT_ID and SEED_PRINCIPAL_ID
          identifying the dedicated seeding identity. COSMOS_KEY must not be set.
Seeding only creates documents in the "${SEED_CONTAINER}" container and never overwrites one.
`;

function parseEndpoint(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SeedGuardError('endpoint_invalid', 'The endpoint is not a valid URL.');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    throw new SeedGuardError('endpoint_invalid', 'The endpoint must be a bare origin without credentials, path or query.');
  }
  return url;
}

export function parseSeedArgs(argv: readonly string[], env: EnvMap): SeedPlan {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        target: { type: 'string' },
        endpoint: { type: 'string' },
        database: { type: 'string' },
        'confirm-account': { type: 'string' },
        'allow-drift': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new SeedGuardError('usage', error instanceof Error ? error.message : 'Invalid arguments.');
  }

  const target = values.target;
  if (target !== 'emulator' && target !== 'cloud') {
    throw new SeedGuardError('target_required', 'Pass --target emulator or --target cloud; there is no default.');
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new SeedGuardError('tls_verification_disabled', 'NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed; trust the certificate instead.');
  }

  const endpointText = values.endpoint ?? env.COSMOS_ENDPOINT;
  if (endpointText === undefined || endpointText === '') {
    throw new SeedGuardError('endpoint_required', 'Pass --endpoint or set COSMOS_ENDPOINT.');
  }
  const url = parseEndpoint(endpointText);

  const database = values.database ?? env.COSMOS_DATABASE ?? DEFAULT_DATABASE;
  if (!DATABASE_NAME.test(database)) throw new SeedGuardError('database_invalid', 'The database name is not valid.');

  const common = { database, allowDrift: values['allow-drift'], dryRun: values['dry-run'], json: values.json };
  const confirmAccount = values['confirm-account'];

  if (target === 'emulator') {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SeedGuardError('endpoint_invalid', 'The endpoint must use http or https.');
    if (!isLoopbackHostname(url.hostname)) {
      throw new SeedGuardError('endpoint_not_loopback', 'The emulator target only accepts a loopback endpoint.');
    }
    if (confirmAccount !== undefined) throw new SeedGuardError('usage', '--confirm-account applies to the cloud target only.');
    const key = env.COSMOS_KEY;
    if (key === undefined || key === '') throw new SeedGuardError('key_required', 'Set COSMOS_KEY to the emulator key.');
    return { target, endpoint: url.origin, key, ...common };
  }

  if (url.protocol !== 'https:') throw new SeedGuardError('endpoint_not_https', 'The cloud target requires an https endpoint.');
  const accountName = cosmosAccountName(url.hostname);
  if (accountName === null || url.port !== '') {
    throw new SeedGuardError('endpoint_not_cosmos_account', 'The cloud target requires an Azure Cosmos DB account endpoint.');
  }
  if (confirmAccount === undefined) {
    throw new SeedGuardError('confirm_account_required', 'Pass --confirm-account with the exact account name.');
  }
  if (confirmAccount !== accountName) {
    throw new SeedGuardError('confirm_account_mismatch', 'The confirmed account name does not match the endpoint.');
  }
  if (env.COSMOS_KEY !== undefined && env.COSMOS_KEY !== '') {
    throw new SeedGuardError('key_not_allowed', 'COSMOS_KEY must not be set for the cloud target; it uses Microsoft Entra ID only.');
  }
  const clientId = env.SEED_CLIENT_ID;
  if (clientId === undefined || !GUID.test(clientId)) {
    throw new SeedGuardError('seed_identity_required', 'Set SEED_CLIENT_ID to the seeding identity client id.');
  }
  const expectedPrincipalId = env.SEED_PRINCIPAL_ID;
  if (expectedPrincipalId === undefined || !GUID.test(expectedPrincipalId)) {
    throw new SeedGuardError('seed_identity_required', 'Set SEED_PRINCIPAL_ID to the seeding identity object id.');
  }
  return { target, endpoint: url.origin, accountName, clientId, expectedPrincipalId: expectedPrincipalId.toLowerCase(), ...common };
}

/** Reads `oid` from a token we obtained ourselves; the signature is not what is being checked. */
export function principalIdFromToken(token: string): string | null {
  const payloadPart = token.split('.')[1];
  if (payloadPart === undefined) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (typeof payload === 'object' && payload !== null && 'oid' in payload && typeof payload.oid === 'string') {
      return payload.oid.toLowerCase();
    }
  } catch {
    return null;
  }
  return null;
}

export function assertSeedPrincipal(token: string, expectedPrincipalId: string): void {
  if (principalIdFromToken(token) !== expectedPrincipalId.toLowerCase()) {
    throw new SeedGuardError('principal_mismatch', 'The credential does not belong to the expected seeding identity.');
  }
}

export function describePlan(plan: SeedPlan): string {
  const where = plan.target === 'emulator' ? plan.endpoint : `${plan.accountName} (identity ${plan.expectedPrincipalId})`;
  return `${plan.target} ${where}, database ${plan.database}, container ${SEED_CONTAINER}`;
}
