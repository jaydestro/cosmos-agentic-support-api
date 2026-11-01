import { CosmosClient, type Container, type Database } from '@azure/cosmos';
import { ManagedIdentityCredential } from '@azure/identity';
import type { CosmosConfig } from '../config/env.ts';

export const CONTAINER_NAMES = Object.freeze({
  reference: 'reference',
  cases: 'cases',
  provider: 'provider',
  leases: 'leases',
});

export interface CosmosHandles {
  readonly client: CosmosClient;
  readonly database: Database;
  readonly reference: Container;
  readonly cases: Container;
  readonly provider: Container;
}

/** Requests never wait longer than this in total for 429 retries; callers see 503 afterwards. */
const MAX_THROTTLE_WAIT_SECONDS = 10;
const MAX_THROTTLE_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Builds the single process-wide client. Create it once and reuse it; callers must not
 * construct a client per request. The emulator key path exists only for loopback targets
 * and is rejected by configuration validation when running in Azure.
 */
export function createCosmosHandles(config: CosmosConfig): CosmosHandles {
  const connectionPolicy = {
    requestTimeout: REQUEST_TIMEOUT_MS,
    retryOptions: { maxRetryAttemptCount: MAX_THROTTLE_RETRIES, maxWaitTimeInSeconds: MAX_THROTTLE_WAIT_SECONDS },
    useMultipleWriteLocations: false,
  };
  const client =
    config.auth === 'emulator-key'
      ? new CosmosClient({
          endpoint: config.endpoint,
          key: config.key,
          userAgentSuffix: 'resolve-sample',
          connectionPolicy: { ...connectionPolicy, enableEndpointDiscovery: false },
        })
      : new CosmosClient({
          endpoint: config.endpoint,
          aadCredentials: new ManagedIdentityCredential(
            config.clientId === undefined ? undefined : { clientId: config.clientId },
          ),
          userAgentSuffix: 'resolve-sample',
          connectionPolicy,
        });
  const database = client.database(config.database);
  return {
    client,
    database,
    reference: database.container(CONTAINER_NAMES.reference),
    cases: database.container(CONTAINER_NAMES.cases),
    provider: database.container(CONTAINER_NAMES.provider),
  };
}
