import { HttpError } from '../http/problem.ts';

const TRANSIENT_STATUS = new Set([408, 429, 449, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Duck-typed so the HTTP layer needs no dependency on the Cosmos DB SDK. */
export function isTransientDependencyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown; statusCode?: unknown };
  if (candidate.name === 'TimeoutError' || candidate.name === 'AbortError') return true;
  for (const status of [candidate.code, candidate.statusCode]) {
    if (typeof status === 'number' && TRANSIENT_STATUS.has(status)) return true;
    if (typeof status === 'string' && TRANSIENT_NETWORK_CODES.has(status)) return true;
  }
  return false;
}

export const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

export const dependencyUnavailable = (cause?: unknown): HttpError =>
  new HttpError(503, 'dependency_unavailable', 'A dependency is temporarily unavailable', {
    retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS,
    headers: { 'Retry-After': String(DEPENDENCY_RETRY_AFTER_SECONDS) },
    ...(cause === undefined ? {} : { cause }),
  });

export function isStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.code === status || candidate.statusCode === status;
}
