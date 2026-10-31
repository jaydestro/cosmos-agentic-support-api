import assert from 'node:assert/strict';
import type { ApiResult } from './api.ts';

const CORRELATION_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Headers every API response carries, successful or not. */
export function assertApiHeaders(result: ApiResult): void {
  assert.match(result.headers.get('x-correlation-id') ?? '', CORRELATION_ID, 'x-correlation-id');
  assert.equal(result.headers.get('cache-control'), 'no-store', 'cache-control');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff', 'x-content-type-options');
}

/** The body is typed by the caller; this only guarantees there is a JSON body to look at. */
export function jsonBody<T>(result: ApiResult): T {
  assert.notEqual(result.json, undefined, `expected a JSON body, got ${String(result.status)}: ${result.text.slice(0, 200)}`);
  return result.json as T;
}

/** Checks the RFC 9457 envelope, the stable error code and that the body echoes the correlation header. */
export function assertProblem(result: ApiResult, status: number, code: string): void {
  assert.equal(result.status, status, `expected ${String(status)} ${code}, got ${String(result.status)}: ${result.text.slice(0, 300)}`);
  assert.match(result.headers.get('content-type') ?? '', /^application\/problem\+json/i, 'content-type');
  assertApiHeaders(result);
  const problem = jsonBody<Record<string, unknown>>(result);
  assert.equal(problem['code'], code, 'problem code');
  assert.equal(problem['status'], status, 'problem status');
  assert.equal(problem['correlationId'], result.headers.get('x-correlation-id'), 'problem correlationId');
  assert.equal(typeof problem['title'], 'string', 'problem title');
  assert.equal(typeof problem['type'], 'string', 'problem type');
}
