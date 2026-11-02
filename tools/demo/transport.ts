import { AzureCliCredential } from '@azure/identity';
import { createResolveClient, type ResolveClient } from '../../contracts/client/index.ts';
import { CliError, validateBaseUrl, validateScope, type ConnectionOptions } from './args.ts';

export interface TransportDependencies {
  readonly credential?: Pick<AzureCliCredential, 'getToken'>;
  readonly fetch?: typeof globalThis.fetch;
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(new CliError('request_timeout', 'Request cancelled or timed out.')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** One credential, in memory only. A deadline covers auth, fetch and response-body reading. */
export function createDemoClient(options: ConnectionOptions, dependencies: TransportDependencies = {}): ResolveClient {
  const baseUrl = validateBaseUrl(options.baseUrl);
  const scope = validateScope(options.scope);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000) {
    throw new CliError('invalid_arguments', 'Request timeout must be 100–60000 milliseconds.');
  }
  const credential = dependencies.credential ?? new AzureCliCredential({ processTimeoutInMs: options.timeoutMs });
  const client = createResolveClient({ baseUrl, ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }) });
  client.use({
    async onRequest({ request }) {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs)]);
      const bounded = new Request(request, { signal, redirect: 'error' });
      signal.throwIfAborted();
      const token = await abortable(credential.getToken(scope, { abortSignal: signal }), signal);
      if (!token.token || token.expiresOnTimestamp <= Date.now()) {
        throw new CliError('authentication_failed', 'Azure CLI did not return a usable access token.');
      }
      bounded.headers.set('Authorization', `Bearer ${token.token}`);
      bounded.headers.set('Accept', 'application/json, application/problem+json');
      if (bounded.body !== null) {
        bounded.headers.set('Content-Length', String(Buffer.byteLength(await bounded.clone().text())));
      }
      signal.throwIfAborted();
      return bounded;
    },
  });
  return client;
}

interface Reply<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

/** Never turn HTTP errors, empty success bodies or redirects into a successful result. */
export async function apiValue<T>(pending: Promise<Reply<T>>): Promise<T> {
  const reply = await pending;
  if (!reply.response.ok) throw new CliError(`http_${String(reply.response.status)}`, `Resolve API returned HTTP ${String(reply.response.status)}.`);
  if (reply.data === undefined || reply.data === null || reply.error !== undefined) {
    throw new CliError('invalid_response', 'Resolve API returned an empty or invalid response.');
  }
  return reply.data;
}
