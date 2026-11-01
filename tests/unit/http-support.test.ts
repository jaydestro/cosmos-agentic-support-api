import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadContract } from '../../src/contract/load.ts';
import type { Clock } from '../../src/domain/time.ts';
import { decodeCursor, encodeCursor, MAX_CURSOR_CHARS } from '../../src/http/cursor.ts';
import {
  HttpError,
  badRequest,
  conflict,
  credentialsMissing,
  forbidden,
  notFound,
  toProblem,
  tooMany,
  unauthenticated,
} from '../../src/http/problem.ts';
import { createReadiness } from '../../src/http/readiness.ts';
import { compileRouteMatcher } from '../../src/http/routes.ts';
import { createStaticServer, resolveAssetPath } from '../../src/http/static.ts';
import { createMemoryLogger } from '../../src/telemetry/log.ts';

const SCHEME = ['Bear', 'er'].join('');
const KEY = /^[a-z0-9~:-]+$/;
const tokenOf = (payload: unknown): string => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

function assertInvalidToken(token: unknown): void {
  assert.throws(
    () => decodeCursor(token, KEY),
    (error: unknown) =>
      error instanceof HttpError && error.status === 400 && error.code === 'invalid_continuation_token',
    `token ${JSON.stringify(token)} should be rejected`,
  );
}

describe('continuation cursors', () => {
  it('round-trips a key', () => {
    const key = '2026-01-02x03:04:05000z~inv-0001';
    assert.equal(decodeCursor(encodeCursor(key), KEY), key);
  });

  it('treats an absent token as the first page', () => {
    assert.equal(decodeCursor(undefined, KEY), null);
    assert.equal(decodeCursor(null, KEY), null);
  });

  it('is base64url with no padding, so it is safe in a query string', () => {
    const token = encodeCursor('abc~def');
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(token.length < MAX_CURSOR_CHARS);
  });

  it('rejects every malformed or foreign token with the same error', () => {
    const rejected: unknown[] = [
      42,
      {},
      '',
      'x'.repeat(MAX_CURSOR_CHARS + 1),
      'not base64url!',
      'a+b/c=',
      tokenOf('just a string'),
      tokenOf(null),
      tokenOf([1, 2]),
      tokenOf({ v: 2, k: 'abc' }),
      tokenOf({ k: 'abc' }),
      tokenOf({ v: 1 }),
      tokenOf({ v: 1, k: 5 }),
      tokenOf({ v: 1, k: 'UPPER' }),
      tokenOf({ v: 1, k: '' }),
      Buffer.from('{not json', 'utf8').toString('base64url'),
      Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'),
    ];
    for (const token of rejected) assertInvalidToken(token);
  });

  it('applies the key pattern of the list being paged, so a cursor from one list fails on another', () => {
    const token = encodeCursor('abc~def');
    assert.equal(decodeCursor(token, /^[a-z~]+$/), 'abc~def');
    assert.throws(() => decodeCursor(token, /^\d+$/), HttpError);
  });

  it('does not leak the reason in the error', () => {
    try {
      decodeCursor(tokenOf({ v: 9, k: 'secret-key-name' }), KEY);
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.title, 'The continuation token is not valid');
      assert.equal(error.options.detail, undefined);
      assert.equal(JSON.stringify(toProblem(error, 'corr-0001')).includes('secret-key-name'), false);
    }
  });
});

describe('problem details', () => {
  it('builds a minimal problem without optional members', () => {
    const problem = toProblem(new HttpError(418, 'teapot', 'Short and stout'), 'corr-0001');
    assert.deepEqual(problem, { type: 'about:blank', title: 'Short and stout', status: 418, code: 'teapot', correlationId: 'corr-0001' });
    assert.equal('detail' in problem, false);
    assert.equal('errors' in problem, false);
    assert.equal('retryAfterSeconds' in problem, false);
  });

  it('carries detail, field errors and the retry hint when present', () => {
    const errors = [{ pointer: '/limit', code: 'out_of_range', message: 'Must be at most 50' }];
    const problem = toProblem(
      new HttpError(400, 'validation_failed', 'Invalid', { detail: 'one problem', errors, retryAfterSeconds: 7 }),
      'corr-0002',
    );
    assert.equal(problem.detail, 'one problem');
    assert.deepEqual(problem.errors, errors);
    assert.equal(problem.retryAfterSeconds, 7);
  });

  it('keeps the response headers out of the problem body', () => {
    const problem = toProblem(tooMany('rate_limited', 'Too many requests', 3), 'corr-0003');
    assert.equal(JSON.stringify(problem).includes('Retry-After'), false);
  });

  it('names the helper statuses and codes', () => {
    assert.deepEqual([badRequest('bad', 'Bad').status, badRequest('bad', 'Bad').code], [400, 'bad']);
    assert.deepEqual([forbidden('nope').status, forbidden('nope').title], [403, 'Forbidden']);
    assert.equal(forbidden('nope', 'Custom').title, 'Custom');
    assert.deepEqual([notFound().status, notFound().code, notFound().title], [404, 'not_found', 'Not found']);
    assert.equal(notFound('no such invoice').options.detail, 'no such invoice');
    assert.equal(notFound().options.detail, undefined);
    assert.deepEqual([conflict('clash', 'Clash').status, conflict('clash', 'Clash').code], [409, 'clash']);
  });

  it('challenges a missing credential with a bare scheme and an invalid one with an error code', () => {
    assert.equal(credentialsMissing().status, 401);
    assert.equal(credentialsMissing().options.headers?.['WWW-Authenticate'], SCHEME);
    const rejected = unauthenticated('token expired');
    assert.equal(rejected.status, 401);
    assert.equal(rejected.code, 'unauthenticated');
    assert.equal(rejected.options.detail, 'token expired');
    assert.match(rejected.options.headers?.['WWW-Authenticate'] ?? '', new RegExp(`^${SCHEME} .*error="invalid_token"`));
    assert.equal(unauthenticated().options.detail, undefined);
  });

  it('sets Retry-After as text and the hint as a number for a rate limit', () => {
    const error = tooMany('rate_limited', 'Too many requests', 9);
    assert.equal(error.status, 429);
    assert.equal(error.options.headers?.['Retry-After'], '9');
    assert.equal(error.options.retryAfterSeconds, 9);
  });

  it('is an Error whose message names the code and which can carry a cause', () => {
    const cause = new Error('root');
    const error = new HttpError(500, 'broken', 'Broken', { cause });
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'HttpError');
    assert.equal(error.message, 'broken: Broken');
    assert.equal(error.cause, cause);
    assert.equal(new HttpError(500, 'broken', 'Broken').cause, undefined);
  });
});

describe('readiness probe', () => {
  const setup = (options: { okTtlMs?: number; failTtlMs?: number } = {}) => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const clock: Clock = { now: () => new Date(now) };
    const state = { pings: 0, failing: false, gate: null as Promise<void> | null };
    const { logger, lines } = createMemoryLogger();
    const readiness = createReadiness({
      ping: async () => {
        state.pings += 1;
        if (state.gate !== null) await state.gate;
        if (state.failing) throw new Error('database unreachable');
      },
      clock,
      logger,
      ...options,
    });
    return { readiness, state, lines, advance: (ms: number) => { now += ms; } };
  };

  it('probes once and caches a success for 15 seconds by default', async () => {
    const { readiness, state, advance } = setup();
    assert.equal(await readiness.isReady(), true);
    assert.equal(await readiness.isReady(), true);
    advance(14_999);
    assert.equal(await readiness.isReady(), true);
    assert.equal(state.pings, 1);
    advance(1);
    assert.equal(await readiness.isReady(), true);
    assert.equal(state.pings, 2);
  });

  it('caches a failure for only 3 seconds and logs it as a warning', async () => {
    const { readiness, state, lines, advance } = setup();
    state.failing = true;
    assert.equal(await readiness.isReady(), false);
    assert.equal(await readiness.isReady(), false);
    assert.equal(state.pings, 1);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0] ?? '{}') as { level: string; message: string };
    assert.equal(record.level, 'warn');
    assert.equal(record.message, 'readiness probe failed');
    advance(3_000);
    state.failing = false;
    assert.equal(await readiness.isReady(), true);
    assert.equal(state.pings, 2);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    const { readiness, state } = setup();
    let open: () => void = () => undefined;
    state.gate = new Promise<void>((resolveGate) => {
      open = resolveGate;
    });
    const callers = Array.from({ length: 8 }, () => readiness.isReady());
    open();
    assert.deepEqual(await Promise.all(callers), Array.from({ length: 8 }, () => true));
    assert.equal(state.pings, 1);
  });

  it('can probe again after an in-flight probe settles', async () => {
    const { readiness, state, advance } = setup({ okTtlMs: 10 });
    assert.equal(await readiness.isReady(), true);
    advance(10);
    assert.equal(await readiness.isReady(), true);
    assert.equal(state.pings, 2);
  });

  it('honours custom lifetimes', async () => {
    const { readiness, state, advance } = setup({ okTtlMs: 100, failTtlMs: 50 });
    state.failing = true;
    await readiness.isReady();
    advance(49);
    await readiness.isReady();
    assert.equal(state.pings, 1);
    advance(1);
    await readiness.isReady();
    assert.equal(state.pings, 2);
  });
});

describe('route matcher', () => {
  const matcher = compileRouteMatcher([
    { route: 'api/cases', method: 'POST' },
    { route: 'api/cases', method: 'GET' },
    { route: 'api/cases/{caseId}', method: 'GET' },
    { route: 'api/cases/{caseId}', method: 'DELETE' },
    { route: 'api/cases/{caseId}', method: 'GET' },
    { route: 'api/cases/{caseId}/timeline', method: 'GET' },
    { route: 'api/v1.0/items', method: 'GET' },
  ]);

  it('lists the methods of a path, sorted and without duplicates', () => {
    assert.deepEqual(matcher('api/cases'), ['GET', 'POST']);
    assert.deepEqual(matcher('api/cases/abc'), ['DELETE', 'GET']);
    assert.deepEqual(matcher('api/cases/abc/timeline'), ['GET']);
  });

  it('matches the whole path only', () => {
    for (const path of ['api/cases/abc/timeline/', 'api/cases//timeline', 'api/cases/a/b/timeline', 'x/api/cases', 'api', '', 'api/other']) {
      assert.deepEqual(matcher(path), [], path);
    }
  });

  it('treats the literal parts of a template literally', () => {
    assert.deepEqual(matcher('api/v1.0/items'), ['GET']);
    assert.deepEqual(matcher('api/v1x0/items'), []);
  });

  it('knows every operation of the contract under its own concrete path', () => {
    const { operations } = loadContract();
    const matches = compileRouteMatcher(operations);
    for (const operation of operations) {
      const concrete = operation.route.replace(/\{[^}]+\}/g, 'sample-value');
      assert.ok(matches(concrete).includes(operation.method), `${operation.method} ${operation.route}`);
    }
  });
});

describe('static assets', () => {
  let root = '';

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'resolve-static-'));
    await mkdir(join(root, 'assets'));
    await mkdir(join(root, 'reference'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>console</title>');
    await writeFile(join(root, 'assets', 'app.js'), 'export {};');
    await writeFile(join(root, 'assets', 'app.js.map'), '{}');
    await writeFile(join(root, 'reference', 'index.html'), '<!doctype html><title>reference</title>');
    await writeFile(join(root, 'reference', 'openapi.yaml'), 'openapi: 3.1.0\n');
    await writeFile(join(root, 'notes.exe'), 'not served');
    await writeFile(join(root, '.secret.txt'), 'hidden');
    for (let index = 0; index < 70; index += 1) await writeFile(join(root, `many-${String(index)}.txt`), String(index));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('resolveAssetPath', () => {
    it('maps the root and extensionless paths to an index page', () => {
      assert.equal(resolveAssetPath(root, undefined), resolve(root, 'index.html'));
      assert.equal(resolveAssetPath(root, ''), resolve(root, 'index.html'));
      assert.equal(resolveAssetPath(root, '/'), resolve(root, 'index.html'));
      assert.equal(resolveAssetPath(root, 'reference'), resolve(root, 'reference', 'index.html'));
      assert.equal(resolveAssetPath(root, 'reference/'), resolve(root, 'reference', 'index.html'));
      assert.equal(resolveAssetPath(root, 'assets/app.js'), resolve(root, 'assets', 'app.js'));
    });

    it('rejects traversal in every spelling', () => {
      for (const path of ['../etc/passwd', 'assets/../../x', '%2e%2e/secret', '%2e%2e%2fsecret', 'assets/%2E%2E/x', './index.html']) {
        assert.equal(resolveAssetPath(root, path), null, path);
      }
    });

    it('rejects dotfiles, backslashes, NUL bytes, bad encodings and long paths', () => {
      for (const path of ['.secret.txt', 'assets/.hidden', '..', 'a%5Cb.js', 'a\\b.js', 'a%00.js', '%E0%A4%A', `${'a/'.repeat(101)}b.js`]) {
        assert.equal(resolveAssetPath(root, path), null, path);
      }
    });

    it('accepts a path of exactly the limit and rejects one character more', () => {
      const atLimit = `${'a'.repeat(197)}.js`;
      assert.equal(atLimit.length, 200);
      assert.notEqual(resolveAssetPath(root, atLimit), null);
      assert.equal(resolveAssetPath(root, `${'a'.repeat(198)}.js`), null);
    });
  });

  describe('createStaticServer', () => {
    it('serves the console page without caching and with a locked-down CSP', async () => {
      const response = await createStaticServer(root).serve('', 'GET');
      assert.equal(response.status, 200);
      assert.equal(new TextDecoder().decode(response.body), '<!doctype html><title>console</title>');
      assert.equal(response.headers['Content-Type'], 'text/html; charset=utf-8');
      assert.equal(response.headers['Cache-Control'], 'no-cache');
      assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
      assert.equal(response.headers['Permissions-Policy'], 'camera=(), microphone=(), geolocation=()');
      assert.equal(response.headers['Content-Length'], String(response.body?.byteLength));
      const csp = response.headers['Content-Security-Policy'] ?? '';
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /connect-src 'self' https:\/\/login\.microsoftonline\.com/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    });

    it('lets only the reference page use inline styles', async () => {
      const server = createStaticServer(root);
      const reference = await server.serve('reference/', 'GET');
      assert.equal(reference.status, 200);
      assert.match(reference.headers['Content-Security-Policy'] ?? '', /style-src 'self' 'unsafe-inline'/);
      assert.doesNotMatch(reference.headers['Content-Security-Policy'] ?? '', /script-src[^;]*unsafe/);
      assert.equal(reference.headers['Cache-Control'], 'public, max-age=3600');
      const consolePage = await server.serve('index.html', 'GET');
      assert.doesNotMatch(consolePage.headers['Content-Security-Policy'] ?? '', /unsafe-inline/);
    });

    it('caches fingerprinted assets for a year and sends no CSP for scripts', async () => {
      const response = await createStaticServer(root).serve('assets/app.js', 'GET');
      assert.equal(response.status, 200);
      assert.equal(response.headers['Cache-Control'], 'public, max-age=31536000, immutable');
      assert.equal(response.headers['Content-Type'], 'text/javascript; charset=utf-8');
      assert.equal('Content-Security-Policy' in response.headers, false);
    });

    it('serves the contract file as YAML and source maps as JSON', async () => {
      const server = createStaticServer(root);
      assert.equal((await server.serve('reference/openapi.yaml', 'GET')).headers['Content-Type'], 'application/yaml; charset=utf-8');
      assert.equal((await server.serve('assets/app.js.map', 'GET')).headers['Content-Type'], 'application/json; charset=utf-8');
    });

    it('answers HEAD with the headers and no body', async () => {
      const head = await createStaticServer(root).serve('assets/app.js', 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body, undefined);
      assert.equal(head.headers['Content-Length'], String('export {};'.length));
    });

    it('answers 404 without caching for an unsafe, unknown or missing file', async () => {
      const server = createStaticServer(root);
      for (const path of ['../x', '.secret.txt', 'notes.exe', 'missing.js', 'assets/missing.js', 'assets']) {
        const response = await server.serve(path, 'GET');
        assert.equal(response.status, 404, path);
        assert.equal(response.headers['Cache-Control'], 'no-store', path);
        assert.equal(response.body, undefined, path);
      }
    });

    it('keeps serving correctly after its bounded cache is cleared', async () => {
      const server = createStaticServer(root);
      for (let index = 0; index < 70; index += 1) {
        const response = await server.serve(`many-${String(index)}.txt`, 'GET');
        assert.equal(new TextDecoder().decode(response.body), String(index));
      }
      assert.equal(new TextDecoder().decode((await server.serve('many-0.txt', 'GET')).body), '0');
    });
  });
});
