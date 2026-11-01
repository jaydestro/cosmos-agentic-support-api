import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { RawRequest, RawResponse } from '../http/pipeline.ts';
import { HttpError, toProblem } from '../http/problem.ts';
import { createLogger, type Logger } from '../telemetry/log.ts';

export function toRawRequest(request: HttpRequest): RawRequest {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    params: request.params,
    body: request.body as ReadableStream<Uint8Array> | null,
  };
}

export function toHttpResponse(raw: RawResponse): HttpResponseInit {
  return { status: raw.status, headers: raw.headers, ...(raw.body === undefined ? {} : { body: raw.body }) };
}

/** Routes structured log lines through the host so they carry the invocation id into Application Insights. */
export function invocationLogger(context: InvocationContext, fields: Record<string, unknown> = {}): Logger {
  return createLogger((level, line) => context[level](line), { invocationId: context.invocationId, ...fields });
}

/** An opaque or expected problem response built outside the validating pipeline. */
export function problemHttpResponse(error: HttpError, correlationId: string, hsts: boolean): HttpResponseInit {
  const problem = toProblem(error, correlationId);
  return {
    status: error.status,
    headers: {
      'Content-Type': 'application/problem+json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Correlation-Id': correlationId,
      ...(hsts ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
      ...(error.options.headers ?? {}),
    },
    body: JSON.stringify(problem),
  };
}

/** Used when the runtime itself could not start; the cause never leaves the process. */
export const runtimeFailureResponse = (correlationId: string): HttpResponseInit =>
  problemHttpResponse(new HttpError(500, 'internal_error', 'Internal error'), correlationId, false);
