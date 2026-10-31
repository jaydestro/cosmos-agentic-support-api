import type { components } from '../../contracts/generated/openapi.d.ts';

export type Problem = components['schemas']['Problem'];
export type FieldError = components['schemas']['FieldError'];

export interface HttpErrorOptions {
  detail?: string;
  errors?: FieldError[];
  headers?: Record<string, string>;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/** An expected, client-visible failure. Anything else becomes an opaque 500. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly options: HttpErrorOptions;

  constructor(status: number, code: string, title: string, options: HttpErrorOptions = {}) {
    super(`${code}: ${title}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.options = options;
  }
}

export const badRequest = (code: string, title: string, options?: HttpErrorOptions) =>
  new HttpError(400, code, title, options);
export const unauthenticated = (detail?: string) =>
  new HttpError(401, 'unauthenticated', 'Authentication required', {
    ...(detail === undefined ? {} : { detail }),
    headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
  });
/** RFC 6750 section 3.1: a request without credentials gets a bare challenge, with no error code. */
export const credentialsMissing = () =>
  new HttpError(401, 'unauthenticated', 'Authentication required', { headers: { 'WWW-Authenticate': 'Bearer' } });
export const forbidden = (code: string, title = 'Forbidden', options?: HttpErrorOptions) =>
  new HttpError(403, code, title, options);
export const notFound = (detail?: string) =>
  new HttpError(404, 'not_found', 'Not found', detail === undefined ? {} : { detail });
export const conflict = (code: string, title: string, options?: HttpErrorOptions) =>
  new HttpError(409, code, title, options);
export const tooMany = (code: string, title: string, retryAfterSeconds: number) =>
  new HttpError(429, code, title, {
    retryAfterSeconds,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });

export function toProblem(error: HttpError, correlationId: string): Problem {
  return {
    type: 'about:blank',
    title: error.title,
    status: error.status,
    code: error.code,
    correlationId,
    ...(error.options.detail === undefined ? {} : { detail: error.options.detail }),
    ...(error.options.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.options.retryAfterSeconds }),
    ...(error.options.errors === undefined ? {} : { errors: error.options.errors }),
  };
}
