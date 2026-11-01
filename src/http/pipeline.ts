import { createHash, randomBytes } from 'node:crypto';
import { hasAnyRole, type Principal } from '../auth/principal.ts';
import type { Authenticator } from '../auth/verify.ts';
import type { Config } from '../config/env.ts';
import { HTTP_LIMITS } from '../config/limits.ts';
import type { Contract, OperationSpec, ParamValues } from '../contract/load.ts';
import type { Clock } from '../domain/time.ts';
import type { Logger } from '../telemetry/log.ts';
import { newRuTotals, runWithRuMeter } from '../telemetry/ru.ts';
import { dependencyUnavailable, isTransientDependencyError } from '../data/errors.ts';
import { HttpError, badRequest, forbidden, toProblem } from './problem.ts';

/** The slice of an HTTP request the pipeline needs; satisfied by the Functions `HttpRequest`. */
export interface RawRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

export interface PipelineServices {
  readonly config: Config;
  readonly contract: Contract;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly authenticator: Authenticator;
}

export interface HandlerContext<S extends PipelineServices> {
  readonly op: OperationSpec;
  readonly services: S;
  /** `null` only for anonymous operations. */
  readonly principal: Principal | null;
  readonly correlationId: string;
  readonly logger: Logger;
  readonly now: Date;
  readonly path: ParamValues['path'];
  readonly query: ParamValues['query'];
  readonly headers: ParamValues['header'];
  /** Parsed and schema-validated JSON body; `undefined` when the operation has none. */
  readonly body: unknown;
  readonly url: URL;
}

export interface HandlerResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler<S extends PipelineServices> = (ctx: HandlerContext<S>) => Promise<HandlerResult>;

const CORRELATION_ID = /^[A-Za-z0-9._-]{8,64}$/;
const JSON_CONTENT_TYPE = /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i;

export function pickCorrelationId(inbound: string | null): string {
  return inbound !== null && CORRELATION_ID.test(inbound) ? inbound : randomBytes(8).toString('hex');
}

export function principalOf<S extends PipelineServices>(ctx: HandlerContext<S>): Principal {
  if (ctx.principal === null) throw new Error(`Operation ${ctx.op.operationId} has no principal`);
  return ctx.principal;
}

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, 'payload_too_large', 'Request body is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

async function readJsonBody<S extends PipelineServices>(services: S, op: OperationSpec, raw: RawRequest): Promise<unknown> {
  const contentType = raw.headers.get('content-type');
  if (contentType === null || !JSON_CONTENT_TYPE.test(contentType.trim())) {
    throw new HttpError(415, 'unsupported_media_type', 'Only application/json is accepted');
  }
  const declared = raw.headers.get('content-length');
  // The Functions host only forwards a body that has a Content-Length, so a chunked upload would arrive as empty.
  if (declared === null) throw new HttpError(411, 'length_required', 'A Content-Length header is required');
  if (Number(declared) > HTTP_LIMITS.bodyBytes) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  const bytes = await readBoundedBody(raw.body, HTTP_LIMITS.bodyBytes);
  if (bytes.byteLength === 0) throw badRequest('invalid_json', 'A JSON body is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(bytes));
  } catch {
    throw badRequest('invalid_json', 'The body is not valid UTF-8 JSON');
  }
  const errors = services.contract.validateBody(op, parsed);
  if (errors.length > 0) throw badRequest('validation_failed', 'Request validation failed', { errors });
  return parsed;
}

function baseHeaders(config: Config, correlationId: string, contentType: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Correlation-Id': correlationId,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (contentType !== null) headers['Content-Type'] = contentType;
  if (config.env === 'azure') headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

function hashPrefix(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Defense in depth only: callers authenticate with bearer tokens, never cookies, so cross-site
 * request forgery does not apply. Compares hosts rather than full origins because the platform
 * front end may present a different scheme to the app than the browser used.
 */
export function originAllowed(origin: string, requestUrl: URL, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === requestUrl.host;
  } catch {
    return false;
  }
}

export function createPipeline<S extends PipelineServices>(services: S) {
  const { config, contract } = services;

  function respond(
    op: OperationSpec,
    result: HandlerResult,
    correlationId: string,
    log: Logger,
    contentType: string,
    skipDeclaredCheck: boolean,
  ): RawResponse {
    if (!skipDeclaredCheck) {
      const problems = contract.validateResponse(op, result.status, result.body);
      if (problems.length > 0) {
        log.error('response violates the contract', { status: result.status, problems });
        if (config.responseValidation === 'enforce') {
          const body = toProblem(new HttpError(500, 'response_contract_violation', 'Internal error'), correlationId);
          return {
            status: 500,
            headers: baseHeaders(config, correlationId, 'application/problem+json; charset=utf-8'),
            body: JSON.stringify(body),
          };
        }
      }
    }
    const headers = { ...baseHeaders(config, correlationId, result.body === undefined ? null : contentType), ...result.headers };
    return {
      status: result.status,
      headers,
      ...(result.body === undefined ? {} : { body: JSON.stringify(result.body) }),
    };
  }

  function problemResponse(op: OperationSpec, error: HttpError, correlationId: string, log: Logger): RawResponse {
    const body = toProblem(error, correlationId);
    if (error.status >= 500) {
      const problems = contract.validateComponent('Problem', body);
      if (problems.length > 0) log.error('problem body violates the contract', { problems });
    }
    const response = respond(
      op,
      { status: error.status, body, headers: error.options.headers ?? {} },
      correlationId,
      log,
      'application/problem+json; charset=utf-8',
      error.status >= 500,
    );
    return response;
  }

  return async function execute(
    op: OperationSpec,
    handler: Handler<S>,
    raw: RawRequest,
    logger: Logger = services.logger,
  ): Promise<RawResponse> {
    const started = performance.now();
    const correlationId = pickCorrelationId(raw.headers.get('x-correlation-id'));
    const log = logger.child({ correlationId, operationId: op.operationId });
    const ru = newRuTotals();
    let principal: Principal | null = null;
    let response: RawResponse;
    try {
      const url = new URL(raw.url);
      if (op.roles !== null) {
        const origin = raw.headers.get('origin');
        if (origin !== null && !originAllowed(origin, url, config.allowedOrigins)) {
          throw forbidden('origin_not_allowed', 'Origin is not allowed');
        }
        principal = await services.authenticator.authenticate(raw.headers.get('authorization'));
        if (!hasAnyRole(principal, op.roles)) throw forbidden('forbidden_role', 'Forbidden');
      }

      const { values, errors } = contract.validateParams(op, {
        path: raw.params,
        query: url.searchParams,
        header: (name) => raw.headers.get(name),
      });
      if (errors.length > 0) throw badRequest('validation_failed', 'Request validation failed', { errors });

      const body = op.bodySchema === null ? undefined : await readJsonBody(services, op, raw);
      const context: HandlerContext<S> = {
        op,
        services,
        principal,
        correlationId,
        logger: principal === null ? log : log.child({ tenantId: principal.tenantId, principal: hashPrefix(principal.principalId) }),
        now: services.clock.now(),
        path: values.path,
        query: values.query,
        headers: values.header,
        body,
        url,
      };
      const result = await runWithRuMeter(ru, () => handler(context));
      response = respond(op, result, correlationId, log, 'application/json; charset=utf-8', false);
    } catch (error) {
      if (error instanceof HttpError) {
        response = problemResponse(op, error, correlationId, log);
      } else if (isTransientDependencyError(error)) {
        log.warn('dependency unavailable', { error });
        response = problemResponse(op, dependencyUnavailable(), correlationId, log);
      } else {
        log.error('unhandled error', { error });
        response = problemResponse(op, new HttpError(500, 'internal_error', 'Internal error'), correlationId, log);
      }
    }
    log.info('request completed', {
      method: op.method,
      route: op.path,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
      ...(principal === null ? {} : { tenantId: principal.tenantId }),
      ...(ru.measuredOperations + ru.unmeasuredOperations === 0
        ? {}
        : {
            cosmosRequestUnits: Math.round(ru.requestUnits * 100) / 100,
            cosmosMeasuredOperations: ru.measuredOperations,
            cosmosUnmeasuredOperations: ru.unmeasuredOperations,
          }),
    });
    return response;
  };
}
