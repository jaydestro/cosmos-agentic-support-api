import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadContract } from '../../src/contract/load.ts';
import { badRequest, notFound, toProblem, tooMany } from '../../src/http/problem.ts';
import { ApiError, AuthError, describeError, isAbort, isProblem } from '../../web/src/errors.ts';
import type { FieldError, Problem } from '../../web/src/types.ts';

const PROBLEM: Problem = {
  type: 'about:blank',
  title: 'Not found',
  status: 404,
  code: 'not_found',
  correlationId: 'corr-0001',
};

const FIELD: FieldError = { pointer: '/description', code: 'required', message: 'A description is required.' };

describe('ApiError and AuthError', () => {
  it('carry what the failed call knew', () => {
    const error = new ApiError('problem', 'The service refused the request.', 409, PROBLEM);
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ApiError');
    assert.equal(error.message, 'The service refused the request.');
    assert.equal(error.kind, 'problem');
    assert.equal(error.status, 409);
    assert.equal(error.problem, PROBLEM);
  });

  it('default to no status and no problem', () => {
    const error = new ApiError('network', 'Failed to fetch');
    assert.equal(error.status, null);
    assert.equal(error.problem, null);
  });

  it('keep the sign-in failure reason', () => {
    const error = new AuthError('signed_out', 'Sign in to continue.');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AuthError');
    assert.equal(error.reason, 'signed_out');
    assert.equal(error.message, 'Sign in to continue.');
  });
});

describe('isAbort', () => {
  it('is true for the error a cancelled request rejects with', () => {
    assert.equal(isAbort(AbortSignal.abort().reason), true);
    assert.equal(isAbort(new DOMException('The operation was aborted.', 'AbortError')), true);
    assert.equal(isAbort(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  });

  it('is false for every other failure, so a real error is never swallowed as a navigation', () => {
    for (const [label, value] of [
      ['a plain error', new Error('aborted')],
      ['a type error', new TypeError('Failed to fetch')],
      ['an API error', new ApiError('network', 'Failed to fetch')],
      ['an auth error', new AuthError('unavailable', 'No identity provider.')],
      ['the text AbortError', 'AbortError'],
      ['an object that is not an error', { name: 'AbortError' }],
      ['null', null],
      ['undefined', undefined],
      ['a number', 0],
    ] as const) {
      assert.equal(isAbort(value), false, label);
    }
  });
});

describe('isProblem', () => {
  it('accepts the contract fields, with or without the optional ones', () => {
    assert.equal(isProblem(PROBLEM), true);
    assert.equal(isProblem({ ...PROBLEM, detail: 'The case does not exist.' }), true);
    assert.equal(isProblem({ ...PROBLEM, retryAfterSeconds: 5 }), true);
    assert.equal(isProblem({ ...PROBLEM, errors: [] }), true);
    assert.equal(isProblem({ ...PROBLEM, errors: [FIELD, { ...FIELD, pointer: '/accountId' }] }), true);
    assert.equal(isProblem({ ...PROBLEM, extra: 'is ignored' }), true);
  });

  for (const key of ['type', 'title', 'status', 'code', 'correlationId'] as const) {
    it(`refuses a problem without ${key}`, () => {
      const copy: Record<string, unknown> = { ...PROBLEM };
      delete copy[key];
      assert.equal(isProblem(copy), false);
    });
  }

  for (const [name, change] of [
    ['a numeric type', { type: 7 }],
    ['a numeric title', { title: 7 }],
    ['a text status', { status: '404' }],
    ['a null code', { code: null }],
    ['a numeric correlation id', { correlationId: 7 }],
    ['a numeric detail', { detail: 7 }],
    ['a text retry delay', { retryAfterSeconds: '5' }],
    ['errors that are not a list', { errors: 'bad' }],
    ['errors that are an object', { errors: { pointer: '/a', code: 'c', message: 'm' } }],
    ['an error entry that is null', { errors: [null] }],
    ['an error entry that is text', { errors: ['bad'] }],
    ['an error entry without a message', { errors: [{ pointer: '/a', code: 'c' }] }],
    ['an error entry with a numeric pointer', { errors: [{ pointer: 1, code: 'c', message: 'm' }] }],
    ['one bad entry among good ones', { errors: [FIELD, { pointer: '/a' }] }],
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.equal(isProblem({ ...PROBLEM, ...change }), false);
    });
  }

  it('refuses a value that is not an object, such as a proxy page or a number', () => {
    for (const value of [null, undefined, '<html>Bad gateway</html>', 404, true, [], [PROBLEM]]) {
      assert.equal(isProblem(value), false, JSON.stringify(value) ?? 'undefined');
    }
    assert.equal(isProblem({}), false);
  });
});

describe('problems the service sends', () => {
  const contract = loadContract();
  const samples: readonly Problem[] = [
    toProblem(notFound('The case does not exist.'), 'corr-1'),
    toProblem(tooMany('tenant_admission_busy', 'Too many active cases', 7), 'corr-2'),
    toProblem(badRequest('invalid_request', 'The request is not valid', { detail: 'Fix the highlighted fields.', errors: [FIELD] }), 'corr-3'),
  ];

  it('are valid in the contract and trusted by the console', () => {
    for (const problem of samples) {
      assert.deepEqual(contract.validateComponent('Problem', problem), [], problem.code);
      assert.equal(isProblem(problem), true, problem.code);
    }
  });

  it('are described with their identifiers, field errors and retry delay', () => {
    const [missing, busy, invalid] = samples;
    assert.ok(missing !== undefined && busy !== undefined && invalid !== undefined);
    assert.deepEqual(describeError(new ApiError('problem', 'x', 404, missing)), {
      kind: 'problem',
      title: 'Not found',
      detail: 'The case does not exist.',
      code: 'not_found',
      correlationId: 'corr-1',
      fields: [],
      retryAfterSeconds: null,
      status: 404,
    });
    assert.deepEqual(describeError(new ApiError('problem', 'x', 429, busy)), {
      kind: 'problem',
      title: 'Too many active cases',
      detail: null,
      code: 'tenant_admission_busy',
      correlationId: 'corr-2',
      fields: [],
      retryAfterSeconds: 7,
      status: 429,
    });
    assert.deepEqual(describeError(new ApiError('problem', 'x', 400, invalid)), {
      kind: 'problem',
      title: 'The request is not valid',
      detail: 'Fix the highlighted fields.',
      code: 'invalid_request',
      correlationId: 'corr-3',
      fields: [FIELD],
      retryAfterSeconds: null,
      status: 400,
    });
  });
});

describe('describeError', () => {
  const NETWORK_DETAIL =
    'Check the connection and try again. If a change was being submitted, it may or may not have been applied: reload and check before repeating it.';

  it('asks a signed-out person to sign in, and says when sign-in itself is unavailable', () => {
    assert.deepEqual(describeError(new AuthError('signed_out', 'Your session ended.')), {
      kind: 'auth',
      title: 'Sign in to continue',
      detail: 'Your session ended.',
      code: null,
      correlationId: null,
      fields: [],
      retryAfterSeconds: null,
      status: null,
    });
    const unavailable = describeError(new AuthError('unavailable', 'The identity provider did not answer.'));
    assert.equal(unavailable.kind, 'auth');
    assert.equal(unavailable.title, 'Sign-in is unavailable');
    assert.equal(unavailable.detail, 'The identity provider did not answer.');
  });

  it('shows a failure it does not recognise with its message when it has one', () => {
    const unknown = {
      kind: 'unknown',
      title: 'Something went wrong',
      code: null,
      correlationId: null,
      fields: [],
      retryAfterSeconds: null,
      status: null,
    };
    assert.deepEqual(describeError(new TypeError('x is not a function')), { ...unknown, detail: 'x is not a function' });
    assert.deepEqual(describeError(new Error('')), { ...unknown, detail: null });
    for (const value of ['text', 42, null, undefined, { message: 'not an error' }]) {
      assert.deepEqual(describeError(value), { ...unknown, detail: null }, JSON.stringify(value) ?? 'undefined');
    }
  });

  it('prefers the structured problem over the error message', () => {
    const view = describeError(new ApiError('problem', 'HTTP 409', 409, { ...PROBLEM, status: 409, code: 'conflict', title: 'Conflict' }));
    assert.equal(view.title, 'Conflict');
    assert.equal(view.code, 'conflict');
    assert.equal(view.status, 409);
    assert.equal(view.correlationId, 'corr-0001');
    assert.equal(view.detail, null);
  });

  it('says a network failure may or may not have changed anything', () => {
    const view = describeError(new ApiError('network', 'Failed to fetch'));
    assert.equal(view.kind, 'network');
    assert.equal(view.title, 'The service could not be reached');
    assert.equal(view.detail, NETWORK_DETAIL);
    assert.equal(view.code, null);
    assert.equal(view.correlationId, null);
    assert.equal(view.status, null);
  });

  it('asks for a new sign-in after an authentication failure without a problem body', () => {
    const view = describeError(new ApiError('auth', 'The token was refused.', 401));
    assert.equal(view.kind, 'auth');
    assert.equal(view.title, 'Sign in again');
    assert.equal(view.detail, 'The token was refused.');
    assert.equal(view.status, 401);
  });

  it('does not trust a response that was not a structured problem', () => {
    for (const kind of ['problem', 'unexpected'] as const) {
      const view = describeError(new ApiError(kind, 'HTTP 502 from a proxy', 502));
      assert.equal(view.kind, kind);
      assert.equal(view.title, 'The service returned an unexpected response');
      assert.equal(view.detail, 'HTTP 502 from a proxy');
      assert.equal(view.status, 502);
      assert.equal(view.code, null);
      assert.equal(view.correlationId, null);
    }
  });

  it('copies field errors from a problem, so the form can place them', () => {
    const fields = [FIELD, { pointer: '/accountId', code: 'unknown_account', message: 'No such account.' }];
    const view = describeError(new ApiError('problem', 'x', 400, { ...PROBLEM, status: 400, errors: fields }));
    assert.deepEqual(view.fields, fields);
  });
});
