import { CosmosClient } from '@azure/cosmos';
import { createApi, type Api } from './api.ts';

/** What a test process needs to reach a running stack. */
export interface StackConnection {
  readonly id: string;
  readonly apiUrl: string;
  readonly idpMintUrl: string;
  readonly cosmosEndpoint: string;
  readonly cosmosKey: string;
  readonly database: string;
  readonly diagnosticsDir: string;
  /** The Functions host's combined output, for tests that prove what the host never logs. */
  readonly hostLog: string;
}

const VARIABLES = {
  id: 'RESOLVE_STACK_ID',
  apiUrl: 'RESOLVE_STACK_URL',
  idpMintUrl: 'RESOLVE_STACK_IDP_URL',
  cosmosEndpoint: 'RESOLVE_STACK_COSMOS_ENDPOINT',
  cosmosKey: 'RESOLVE_STACK_COSMOS_KEY',
  database: 'RESOLVE_STACK_DATABASE',
  diagnosticsDir: 'RESOLVE_STACK_DIAGNOSTICS',
  hostLog: 'RESOLVE_STACK_HOST_LOG',
} as const satisfies Record<keyof StackConnection, string>;

/** The environment a child process receives from `tests/support/cli.ts run`. */
export function stackEnvironment(stack: StackConnection): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(VARIABLES) as (keyof StackConnection)[]) result[VARIABLES[key]] = stack[key];
  return result;
}

export function readStackConnection(env: NodeJS.ProcessEnv = process.env): StackConnection {
  const missing = Object.values(VARIABLES).filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) {
    throw new Error(
      `No running stack was found (missing ${missing.join(', ')}). Run integration tests through "npm run test:integration" so the stack is started and removed for you.`,
    );
  }
  const read = (key: keyof StackConnection): string => env[VARIABLES[key]] ?? '';
  return {
    id: read('id'),
    apiUrl: read('apiUrl'),
    idpMintUrl: read('idpMintUrl'),
    cosmosEndpoint: read('cosmosEndpoint'),
    cosmosKey: read('cosmosKey'),
    database: read('database'),
    diagnosticsDir: read('diagnosticsDir'),
    hostLog: read('hostLog'),
  };
}

export function connectApi(stack: StackConnection): Api {
  return createApi({ baseUrl: new URL(stack.apiUrl).origin, mintUrl: stack.idpMintUrl });
}

/** A client for the emulator's plain-HTTP gateway. Tests use it for independent inspection only. */
export function openEmulator(stack: Pick<StackConnection, 'cosmosEndpoint' | 'cosmosKey'>): CosmosClient {
  return new CosmosClient({
    endpoint: stack.cosmosEndpoint,
    key: stack.cosmosKey,
    userAgentSuffix: 'resolve-test',
    connectionPolicy: { requestTimeout: 15_000, enableEndpointDiscovery: false },
  });
}
