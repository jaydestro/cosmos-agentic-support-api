import type { FieldError, Problem } from './types.ts';

export type ApiErrorKind = 'network' | 'auth' | 'problem' | 'unexpected';

/** A failed call. `problem` is the service's structured error when it sent one. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly problem: Problem | null;

  constructor(kind: ApiErrorKind, message: string, status: number | null = null, problem: Problem | null = null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.problem = problem;
  }
}

/** An aborted request is a navigation or a refresh, never something to show the user. */
export const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/** No usable sign-in: the person is signed out, or the identity provider could not be reached. */
export class AuthError extends Error {
  readonly reason: 'signed_out' | 'unavailable';

  constructor(reason: 'signed_out' | 'unavailable', message: string) {
    super(message);
    this.name = 'AuthError';
    this.reason = reason;
  }
}

function isFieldError(value: unknown): value is FieldError {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['pointer'] === 'string' && typeof record['code'] === 'string' && typeof record['message'] === 'string';
}

/** True for the contract's structured error. Anything else, such as a proxy's HTML page, is not trusted as one. */
export function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['type'] !== 'string' || typeof record['title'] !== 'string') return false;
  if (typeof record['status'] !== 'number' || typeof record['code'] !== 'string' || typeof record['correlationId'] !== 'string') return false;
  if (record['detail'] !== undefined && typeof record['detail'] !== 'string') return false;
  if (record['retryAfterSeconds'] !== undefined && typeof record['retryAfterSeconds'] !== 'number') return false;
  const errors = record['errors'];
  return errors === undefined || (Array.isArray(errors) && errors.every(isFieldError));
}

export interface ErrorView {
  readonly kind: ApiErrorKind | 'unknown';
  readonly title: string;
  readonly detail: string | null;
  readonly code: string | null;
  readonly correlationId: string | null;
  readonly fields: readonly FieldError[];
  readonly retryAfterSeconds: number | null;
  readonly status: number | null;
}

const VIEW_BASE: ErrorView = {
  kind: 'unknown',
  title: 'Something went wrong',
  detail: null,
  code: null,
  correlationId: null,
  fields: [],
  retryAfterSeconds: null,
  status: null,
};

/** The text and identifiers shown for a failure. The correlation id is what an operator needs to find the server-side trace. */
export function describeError(error: unknown): ErrorView {
  if (error instanceof AuthError) {
    return {
      ...VIEW_BASE,
      kind: 'auth',
      title: error.reason === 'signed_out' ? 'Sign in to continue' : 'Sign-in is unavailable',
      detail: error.message,
    };
  }
  if (!(error instanceof ApiError)) {
    return { ...VIEW_BASE, detail: error instanceof Error && error.message !== '' ? error.message : null };
  }
  const { problem } = error;
  if (problem !== null) {
    return {
      kind: error.kind,
      title: problem.title,
      detail: problem.detail ?? null,
      code: problem.code,
      correlationId: problem.correlationId,
      fields: problem.errors ?? [],
      retryAfterSeconds: problem.retryAfterSeconds ?? null,
      status: problem.status,
    };
  }
  switch (error.kind) {
    case 'network':
      return {
        ...VIEW_BASE,
        kind: 'network',
        title: 'The service could not be reached',
        detail: 'Check the connection and try again. If a change was being submitted, it may or may not have been applied: reload and check before repeating it.',
      };
    case 'auth':
      return { ...VIEW_BASE, kind: 'auth', title: 'Sign in again', detail: error.message, status: error.status };
    case 'problem':
    case 'unexpected':
      return { ...VIEW_BASE, kind: error.kind, title: 'The service returned an unexpected response', detail: error.message, status: error.status };
  }
}
