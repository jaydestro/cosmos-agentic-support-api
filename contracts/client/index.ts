import createClient from 'openapi-fetch';
import type { paths } from '../generated/openapi.d.ts';

export type { components, operations, paths } from '../generated/openapi.d.ts';

export interface ResolveClientOptions {
  /** Origin plus the contract server path, for example `http://127.0.0.1:17101/api`. */
  baseUrl: string;
  /** Returns the bearer token for the call. Omit for the anonymous health probes. */
  getAccessToken?: () => Promise<string> | string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Typed client generated from `contracts/openapi.yaml`. Paths, methods, parameters, bodies and
 * responses are checked at compile time; operation ids are available through `operations`.
 */
export function createResolveClient(options: ResolveClientOptions) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const { getAccessToken } = options;
  if (getAccessToken) {
    client.use({
      async onRequest({ request }) {
        request.headers.set('Authorization', `Bearer ${await getAccessToken()}`);
        return request;
      },
    });
  }
  return client;
}

export type ResolveClient = ReturnType<typeof createResolveClient>;
