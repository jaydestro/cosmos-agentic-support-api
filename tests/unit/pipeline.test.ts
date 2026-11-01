import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Principal, RoleName } from '../../src/auth/principal.ts';
import type { Authenticator } from '../../src/auth/verify.ts';
import { loadConfig, type Config } from '../../src/config/env.ts';
import { HTTP_LIMITS } from '../../src/config/limits.ts';
import { loadContract, type OperationSpec } from '../../src/contract/load.ts';
import {
  createPipeline,
  originAllowed,
  pickCorrelationId,
  readBoundedBody,
  type Handler,
  type HandlerContext,
  type HandlerResult,
  type PipelineServices,
  type RawRequest,
  type RawResponse,
} from '../../src/http/pipeline.ts';
import { HttpError, conflict, credentialsMissing, notFound } from '../../src/http/problem.ts';
import { recordCharge } from '../../src/telemetry/ru.ts';
import { createMemoryLogger } from '../../src/telemetry/log.ts';

const contract = loadContract();
const BASE_CONFIG = loadConfig({
  RESOLVE_ENV: 'local',
  COSMOS_ENDPOINT: 'http://127.0.0.1:8081',
  COSMOS_AUTH: 'emulator-key',
  COSMOS_KEY: 'unit-test-key',
  AUTH_MODE: 'test-idp',
  TEST_IDP_JWKS_URL: 'http://127.0.0.1:9/jwks',
  TEST_IDP_ISSUER: 'http://127.0.0.1:9',
  TEST_IDP_AUDIENCE: 'api://resolve-unit-test',
});

const CASE_ID = `case_${'a'.repeat(32)}`;
const WORK_ID = `${CASE_ID}~out-investigation-start-1`;
const NOW = new Date('2026-10-29T12:00:00.000Z');
const ENCODER = new TextEncoder();

function op(operationId: string): OperationSpec {
  const found = contract.byId.get(operationId);
  assert.ok(found, `unknown operation ${operationId}`);
  return found;
}

function principalWith(...roles: RoleName[]): Principal {
  return { principalId: '00000000-0000-4000-8000-0000000000a1', tenantId: 'aurora', roles };
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

/** Errors as soon as anything reads it (a zero high-water mark keeps it lazy), so a read turns the response into a 500. */
function unreadableBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull() {
        throw new Error('the body must not be read');
      },
    },
    { highWaterMark: 0 },
  );
}

interface RequestOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
}

function request(options: RequestOptions = {}): RawRequest {
  return {
    method: options.method ?? 'GET',
    url: `http://localhost:7071${options.path ?? '/api/health'}`,
    headers: new Headers(options.headers ?? {}),
    params: options.params ?? {},
    body: options.body ?? null,
  };
}

interface JsonRequestOptions extends RequestOptions {
  /** `null` omits the Content-Length header; by default it is the exact byte length. */
  length?: number | null;
  contentType?: string | null;
}

function jsonRequest(payload: string | Uint8Array, options: JsonRequestOptions = {}): RawRequest {
  const bytes = typeof payload === 'string' ? ENCODER.encode(payload) : payload;
  const headers: Record<string, string> = { ...options.headers };
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType !== null) headers['content-type'] = contentType;
  const length = options.length === undefined ? bytes.byteLength : options.length;
  if (length !== null) headers['content-length'] = String(length);
  return request({ method: 'POST', ...options, headers, body: options.body === undefined ? streamOf(bytes) : options.body });
}

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  correlationId: string;
  errors?: { pointer: string; code: string }[];
  retryAfterSeconds?: number;
}

function problemOf(response: RawResponse): Problem {
  assert.equal(response.headers['Content-Type'], 'application/problem+json; charset=utf-8');
  return JSON.parse(response.body ?? '') as Problem;
}

function assertProblem(response: RawResponse, status: number, code: string): Problem {
  const problem = problemOf(response);
  assert.equal(response.status, status, response.body);
  assert.equal(problem.code, code);
  assert.equal(problem.status, status);
  assert.equal(problem.correlationId, response.headers['X-Correlation-Id']);
  return problem;
}

function setup(options: { config?: Partial<Config>; principal?: Principal | HttpError } = {}) {
  const { logger, lines } = createMemoryLogger();
  const authorizations: (string | null)[] = [];
  const outcome = options.principal ?? principalWith('Representative', 'Approver', 'Operator');
  const authenticator: Authenticator = {
    authenticate(authorization) {
      authorizations.push(authorization);
      return outcome instanceof HttpError ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
  const services: PipelineServices = {
    config: { ...BASE_CONFIG, ...options.config },
    contract,
    logger,
    clock: { now: () => NOW },
    authenticator,
  };
  const contexts: HandlerContext<PipelineServices>[] = [];
  const recording = (result: HandlerResult): Handler<PipelineServices> => (ctx) => {
    contexts.push(ctx);
    return Promise.resolve(result);
  };
  return { execute: createPipeline(services), authorizations, lines, contexts, recording };
}

const OK = { status: 200, body: { status: 'ok' } };
const SESSION = {
  status: 200,
  body: {
    principal: { principalId: '00000000-0000-4000-8000-0000000000a1', tenantId: 'aurora', roles: ['Representative'] },
    environment: { agentMode: 'demo', liveAvailable: false, liveBlockedReason: 'live_not_approved', simulatedCredits: true, apiVersion: '1.0.0' },
  },
};
const RECOVERED = { status: 202, body: { workId: WORK_ID, action: 'requeue', state: 'recoverable', grantNumber: null } };

const VALID_CASE = JSON.stringify({
  accountId: 'acct_aurora_0001',
  invoiceIds: ['inv_aurora_0001_a', 'inv_aurora_0001_b'],
  category: 'duplicate_charge',
  requestedCredit: { amountMinor: 4900, currency: 'USD' },
  description: 'I was charged twice for the March plan.',
});
const VALID_RECOVERY = JSON.stringify({ action: 'requeue', reason: 'The provider has recovered.' });

/** One request that satisfies every check except the body, for each operation that takes a body. */
const BODY_OPERATIONS: Record<string, { path: string; params: Record<string, string>; headers: Record<string, string>; body: string }> = {
  createCase: { path: '/api/cases', params: {}, headers: { 'idempotency-key': 'unit-test-key-0001' }, body: VALID_CASE },
  approveProposal: {
    path: `/api/cases/${CASE_ID}/proposals/1/approve`,
    params: { caseId: CASE_ID, version: '1' },
    headers: {},
    body: JSON.stringify({ policyVersion: 2, proposalDigest: `sha256:${'0'.repeat(64)}` }),
  },
  rejectProposal: {
    path: `/api/cases/${CASE_ID}/proposals/1/reject`,
    params: { caseId: CASE_ID, version: '1' },
    headers: {},
    body: JSON.stringify({ policyVersion: 2, proposalDigest: `sha256:${'0'.repeat(64)}`, reason: 'The invoices differ.' }),
  },
  requestRevision: {
    path: `/api/cases/${CASE_ID}/revisions`,
    params: { caseId: CASE_ID },
    headers: {},
    body: JSON.stringify({ reason: 'Please check the March invoice again.' }),
  },
  recoverWorkItem: {
    path: `/api/operator/work/${WORK_ID}/recover`,
    params: { workId: WORK_ID },
    headers: {},
    body: VALID_RECOVERY,
  },
};

interface BodyRequestOptions extends JsonRequestOptions {
  /** Replaces the valid fixture body; the declared length follows it unless `length` says otherwise. */
  payload?: string | Uint8Array;
}

function bodyRequest(operationId: string, options: BodyRequestOptions = {}): RawRequest {
  const spec = BODY_OPERATIONS[operationId];
  assert.ok(spec, `no request fixture for ${operationId}`);
  const { payload, ...rest } = options;
  return jsonRequest(payload ?? spec.body, {
    path: spec.path,
    params: spec.params,
    ...rest,
    headers: { authorization: 'scheme credentials', ...spec.headers, ...options.headers },
  });
}

describe('correlation ids', () => {
  it('echoes a well-formed inbound id', () => {
    assert.equal(pickCorrelationId('trace-0001.abc_DEF'), 'trace-0001.abc_DEF');
  });

  it('replaces a missing, short, long or unsafe id with 16 random hex characters', () => {
    for (const unsafe of [null, 'short', 'x'.repeat(65), 'has space in it', 'line\nbreak-inject', 'semi;colon-value']) {
      assert.match(pickCorrelationId(unsafe), /^[0-9a-f]{16}$/, String(unsafe));
    }
  });

  it('does not repeat itself', () => {
    assert.notEqual(pickCorrelationId(null), pickCorrelationId(null));
  });
});

describe('originAllowed', () => {
  const url = new URL('https://api.example.test/api/session');

  it('accepts a listed origin and any origin on the same host', () => {
    assert.equal(originAllowed('https://console.example.test', url, ['https://console.example.test']), true);
    assert.equal(originAllowed('https://api.example.test', url, []), true);
    assert.equal(originAllowed('http://api.example.test', url, []), true);
  });

  it('refuses another host, a look-alike host, an unparsable origin and the opaque origin', () => {
    assert.equal(originAllowed('https://evil.example.test', url, []), false);
    assert.equal(originAllowed('https://api.example.test.evil.test', url, []), false);
    assert.equal(originAllowed('not a url', url, []), false);
    assert.equal(originAllowed('null', url, []), false);
  });
});

describe('readBoundedBody', () => {
  it('returns an empty array for a missing body', async () => {
    assert.equal((await readBoundedBody(null, 10)).byteLength, 0);
  });

  it('joins chunks in order and accepts a body of exactly the limit', async () => {
    const bytes = await readBoundedBody(streamOf(ENCODER.encode('abc'), ENCODER.encode('defg'), ENCODER.encode('hi')), 9);
    assert.equal(new TextDecoder().decode(bytes), 'abcdefghi');
  });

  it('refuses a body one byte over the limit', async () => {
    await assert.rejects(
      () => readBoundedBody(streamOf(new Uint8Array(6), new Uint8Array(5)), 10),
      (error: unknown) => error instanceof HttpError && error.status === 413 && error.code === 'payload_too_large',
    );
  });

  it('stops reading and cancels an endless stream at the limit', async () => {
    let cancelled = false;
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(() => readBoundedBody(endless, 4096), (error: unknown) => error instanceof HttpError && error.status === 413);
    assert.equal(cancelled, true);
    assert.ok(pulls < 20, `read ${String(pulls)} chunks before giving up`);
  });
});

describe('the request pipeline', () => {
  describe('responses', () => {
    it('answers an anonymous operation without consulting the authenticator, with the standard headers', async () => {
      const { execute, authorizations, recording } = setup();
      const response = await execute(op('getHealth'), recording(OK), request({ headers: { authorization: 'ignored' } }));
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body ?? ''), { status: 'ok' });
      assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
      assert.equal(response.headers['Cache-Control'], 'no-store');
      assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
      assert.match(response.headers['X-Correlation-Id'] ?? '', /^[0-9a-f]{16}$/);
      assert.equal(response.headers['Strict-Transport-Security'], undefined);
      assert.deepEqual(authorizations, []);
    });

    it('adds Strict-Transport-Security only when running on Azure', async () => {
      const { execute, recording } = setup({ config: { env: 'azure' } });
      const response = await execute(op('getHealth'), recording(OK), request());
      assert.equal(response.headers['Strict-Transport-Security'], 'max-age=31536000');
    });

    it('echoes a safe inbound correlation id, also inside problem bodies', async () => {
      const { execute, recording } = setup({ principal: credentialsMissing() });
      const ok = await execute(op('getHealth'), recording(OK), request({ headers: { 'x-correlation-id': 'trace-0001.abc' } }));
      assert.equal(ok.headers['X-Correlation-Id'], 'trace-0001.abc');
      const refused = await execute(op('getSession'), recording(OK), request({ path: '/api/session', headers: { 'x-correlation-id': 'trace-0002.abc' } }));
      assert.equal(assertProblem(refused, 401, 'unauthenticated').correlationId, 'trace-0002.abc');
    });

    it('treats a handler result without a body as a contract violation, since no operation declares one', async () => {
      const { execute, recording } = setup();
      const response = await execute(op('getHealth'), recording({ status: 200 }), request());
      assertProblem(response, 500, 'response_contract_violation');
    });

    it('sends no body and no Content-Type for a bodiless result when only logging', async () => {
      const { execute, recording } = setup({ config: { responseValidation: 'log' } });
      const response = await execute(op('getHealth'), recording({ status: 200 }), request());
      assert.equal(response.status, 200);
      assert.equal(response.body, undefined);
      assert.equal(response.headers['Content-Type'], undefined);
    });

    it('lets a handler add response headers', async () => {
      const { execute, recording } = setup();
      const response = await execute(op('getHealth'), recording({ ...OK, headers: { 'X-Extra': 'yes' } }), request());
      assert.equal(response.headers['X-Extra'], 'yes');
    });

    it('never reads a body for an operation that declares none', async () => {
      const { execute, recording } = setup();
      const response = await execute(op('getHealth'), recording(OK), request({ body: unreadableBody() }));
      assert.equal(response.status, 200);
    });
  });

  describe('authentication and authorization', () => {
    it('hands the Authorization header to the authenticator and the principal to the handler', async () => {
      const { execute, authorizations, contexts, recording } = setup({ principal: principalWith('Representative') });
      const response = await execute(
        op('getSession'),
        recording(SESSION),
        request({ path: '/api/session', headers: { authorization: 'scheme credentials' } }),
      );
      assert.equal(response.status, 200, response.body);
      assert.deepEqual(authorizations, ['scheme credentials']);
      assert.equal(contexts[0]?.principal?.tenantId, 'aurora');
      assert.equal(contexts[0]?.now, NOW);
    });

    it('answers 401 with the challenge from the authenticator and never runs the handler', async () => {
      const { execute, contexts, recording } = setup({ principal: credentialsMissing() });
      const response = await execute(op('getSession'), recording(OK), request({ path: '/api/session' }));
      assertProblem(response, 401, 'unauthenticated');
      assert.equal(response.headers['WWW-Authenticate'], 'Bearer');
      assert.deepEqual(contexts, []);
    });

    it('answers 403 forbidden_role when no role of the principal is allowed', async () => {
      const { execute, contexts, recording } = setup({ principal: principalWith('Representative', 'Approver') });
      const response = await execute(op('listOperatorWork'), recording(OK), request({ path: '/api/operator/work' }));
      assertProblem(response, 403, 'forbidden_role');
      assert.deepEqual(contexts, []);
    });

    it('answers 403 for a foreign origin before authenticating, even without credentials', async () => {
      const { execute, authorizations, recording } = setup();
      const response = await execute(
        op('getSession'),
        recording(OK),
        request({ path: '/api/session', headers: { origin: 'https://evil.example.test' } }),
      );
      assertProblem(response, 403, 'origin_not_allowed');
      assert.deepEqual(authorizations, []);
    });

    it('accepts the same host and a listed origin, and ignores the origin of anonymous operations', async () => {
      const { execute, authorizations, recording } = setup({ config: { allowedOrigins: ['https://console.example.test'] } });
      for (const origin of ['http://localhost:7071', 'https://console.example.test']) {
        const response = await execute(
          op('getSession'),
          recording(SESSION),
          request({ path: '/api/session', headers: { origin, authorization: 'x' } }),
        );
        assert.equal(response.status, 200, `${origin}: ${response.body ?? ''}`);
      }
      assert.equal(authorizations.length, 2);
      const anonymous = await execute(op('getHealth'), recording(OK), request({ headers: { origin: 'https://evil.example.test' } }));
      assert.equal(anonymous.status, 200);
    });
  });

  describe('parameters', () => {
    it('rejects an unknown query parameter and an out-of-range one with the field pointers', async () => {
      const { execute, contexts, recording } = setup();
      const unknown = await execute(op('listCases'), recording(OK), request({ path: '/api/cases?bogus=1', headers: { authorization: 'x' } }));
      const unknownProblem = assertProblem(unknown, 400, 'validation_failed');
      assert.ok(unknownProblem.errors?.some((error) => error.pointer.startsWith('/query')));

      const range = await execute(op('listCases'), recording(OK), request({ path: '/api/cases?limit=0', headers: { authorization: 'x' } }));
      assert.ok(assertProblem(range, 400, 'validation_failed').errors?.some((error) => error.pointer === '/query/limit'));
      assert.deepEqual(contexts, []);
    });

    it('rejects a repeated query parameter', async () => {
      const { execute, recording } = setup();
      const response = await execute(op('listCases'), recording(OK), request({ path: '/api/cases?limit=5&limit=6', headers: { authorization: 'x' } }));
      assert.ok(assertProblem(response, 400, 'validation_failed').errors?.some((error) => error.code === 'duplicate_parameter'));
    });

    it('rejects a malformed path parameter', async () => {
      const { execute, recording } = setup();
      const response = await execute(op('getCase'), recording(OK), request({ path: '/api/cases/nope', params: { caseId: 'nope' }, headers: { authorization: 'x' } }));
      assert.ok(assertProblem(response, 400, 'validation_failed').errors?.some((error) => error.pointer.startsWith('/path/caseId')));
    });

    it('rejects a missing or malformed required header before reading the body', async () => {
      const { execute, contexts, recording } = setup();
      const headerCases: Record<string, string>[] = [{}, { 'idempotency-key': 'too-short' }];
      for (const headers of headerCases) {
        const response = await execute(
          op('createCase'),
          recording(OK),
          jsonRequest('', { path: '/api/cases', headers: { authorization: 'x', ...headers }, body: unreadableBody(), length: null }),
        );
        assert.ok(assertProblem(response, 400, 'validation_failed').errors?.some((error) => error.pointer.startsWith('/header')));
      }
      assert.deepEqual(contexts, []);
    });

    it('passes the validated, coerced values to the handler', async () => {
      const { execute, contexts, recording } = setup();
      const response = await execute(
        op('listCases'),
        recording({ status: 200, body: { items: [], continuationToken: null } }),
        request({ path: '/api/cases?limit=7', headers: { authorization: 'x' } }),
      );
      assert.equal(response.status, 200);
      assert.equal(contexts[0]?.query['limit'], 7);
    });
  });

  describe('request bodies', () => {
    it('hands a valid, parsed body to the handler', async () => {
      const { execute, contexts, recording } = setup({ principal: principalWith('Operator') });
      const response = await execute(op('recoverWorkItem'), recording(RECOVERED), bodyRequest('recoverWorkItem'));
      assert.equal(response.status, 202, response.body);
      assert.deepEqual(contexts[0]?.body, JSON.parse(VALID_RECOVERY));
      assert.equal(contexts[0]?.path['workId'], WORK_ID);
    });

    it('accepts a charset parameter of utf-8 on the content type', async () => {
      const { execute, recording } = setup({ principal: principalWith('Operator') });
      const response = await execute(
        op('recoverWorkItem'),
        recording(RECOVERED),
        bodyRequest('recoverWorkItem', { contentType: 'application/json; charset=UTF-8' }),
      );
      assert.equal(response.status, 202, response.body);
    });

    it('answers 415 for anything but JSON, before looking at the length', async () => {
      const { execute, contexts, recording } = setup();
      for (const contentType of [null, 'text/plain', 'application/jsonx', 'application/json; charset=latin1', 'application/x-www-form-urlencoded']) {
        const response = await execute(op('createCase'), recording(OK), bodyRequest('createCase', { contentType, length: null }));
        assertProblem(response, 415, 'unsupported_media_type');
      }
      assert.deepEqual(contexts, []);
    });

    it('answers 411 when no Content-Length is declared, even for a small valid body', async () => {
      const { execute, contexts, recording } = setup();
      const response = await execute(op('createCase'), recording(OK), bodyRequest('createCase', { length: null }));
      assertProblem(response, 411, 'length_required');
      assert.deepEqual(contexts, []);
    });

    it('answers 411 without reading the body', async () => {
      const { execute, recording } = setup();
      const response = await execute(op('createCase'), recording(OK), bodyRequest('createCase', { length: null, body: unreadableBody() }));
      assertProblem(response, 411, 'length_required');
    });

    it('answers 411 for every operation with a body, and the response stays within the declared contract', async () => {
      assert.deepEqual(
        Object.keys(BODY_OPERATIONS).sort(),
        contract.operations.filter((o) => o.bodySchema !== null).map((o) => o.operationId).sort(),
        'every operation with a body needs a request fixture',
      );
      for (const operationId of Object.keys(BODY_OPERATIONS)) {
        const { execute, contexts, recording } = setup();
        const response = await execute(op(operationId), recording(OK), bodyRequest(operationId, { length: null }));
        assertProblem(response, 411, 'length_required');
        assert.deepEqual(contexts, [], operationId);
      }
    });

    it('answers 413 from the declared length without reading anything', async () => {
      const { execute, recording } = setup();
      const response = await execute(
        op('createCase'),
        recording(OK),
        bodyRequest('createCase', { length: HTTP_LIMITS.bodyBytes + 1, body: unreadableBody() }),
      );
      assertProblem(response, 413, 'payload_too_large');
    });

    it('answers 413 when a stream exceeds the limit although it declared a small length', async () => {
      const { execute, contexts, recording } = setup();
      const response = await execute(
        op('createCase'),
        recording(OK),
        bodyRequest('createCase', { length: 10, body: streamOf(new Uint8Array(HTTP_LIMITS.bodyBytes), new Uint8Array(1)) }),
      );
      assertProblem(response, 413, 'payload_too_large');
      assert.deepEqual(contexts, []);
    });

    it('accepts a body of exactly the limit by size, then judges its content', async () => {
      const { execute, recording } = setup();
      const padded = JSON.stringify({ description: 'x'.repeat(HTTP_LIMITS.bodyBytes - 20) });
      assert.equal(ENCODER.encode(padded).byteLength <= HTTP_LIMITS.bodyBytes, true);
      const response = await execute(op('createCase'), recording(OK), bodyRequest('createCase', { body: streamOf(ENCODER.encode(padded)), length: ENCODER.encode(padded).byteLength }));
      assertProblem(response, 400, 'validation_failed');
    });

    it('answers 400 invalid_json for an empty, truncated or non-UTF-8 body', async () => {
      const { execute, contexts, recording } = setup();
      const cases: Uint8Array[] = [new Uint8Array(0), ENCODER.encode('{"accountId":'), new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])];
      for (const payload of cases) {
        const response = await execute(op('createCase'), recording(OK), bodyRequest('createCase', { body: streamOf(payload), length: payload.byteLength }));
        assertProblem(response, 400, 'invalid_json');
      }
      assert.deepEqual(contexts, []);
    });

    it('answers 400 for Content-Length 0 with no body, not 411', async () => {
      const { execute, recording } = setup();
      const response = await execute(op('createCase'), recording(OK), bodyRequest('createCase', { body: null, length: 0 }));
      assertProblem(response, 400, 'invalid_json');
    });

    it('answers 400 validation_failed with a pointer for each problem, including unknown properties', async () => {
      const { execute, contexts, recording } = setup();
      const payload = JSON.stringify({ category: 'duplicate_charge', description: 7, surprise: true });
      const response = await execute(
        op('createCase'),
        recording(OK),
        bodyRequest('createCase', { body: streamOf(ENCODER.encode(payload)), length: ENCODER.encode(payload).byteLength }),
      );
      const problem = assertProblem(response, 400, 'validation_failed');
      const pointers = (problem.errors ?? []).map((error) => error.pointer);
      for (const expected of ['/accountId', '/description', '/surprise']) assert.ok(pointers.includes(expected), `${expected} in ${pointers.join(',')}`);
      assert.deepEqual(contexts, []);
    });
  });

  describe('failures inside the handler', () => {
    const operator = () => setup({ principal: principalWith('Operator') });
    const fail = (error: unknown): Handler<PipelineServices> => () => Promise.reject(error instanceof Error ? error : new Error('thrown'));

    it('turns an HttpError into its problem, with headers', async () => {
      const { execute } = operator();
      const stale = new HttpError(409, 'stale_version', 'The proposal changed', { headers: { 'X-Hint': 'reload' }, detail: 'Reload the case.' });
      const response = await execute(op('recoverWorkItem'), fail(stale), bodyRequest('recoverWorkItem'));
      const problem = assertProblem(response, 409, 'stale_version');
      assert.equal(problem.title, 'The proposal changed');
      assert.equal(response.headers['X-Hint'], 'reload');
    });

    it('keeps the details of an unexpected error out of the response', async () => {
      const { execute, lines } = operator();
      const response = await execute(op('recoverWorkItem'), fail(new Error('connection string leaked: AccountKey=hunter2')), bodyRequest('recoverWorkItem'));
      const problem = assertProblem(response, 500, 'internal_error');
      assert.equal(problem.title, 'Internal error');
      assert.equal(response.body?.includes('hunter2'), false);
      assert.ok(lines.some((line) => line.includes('unhandled error')));
    });

    it('maps a throttled or unreachable dependency to 503 with Retry-After', async () => {
      for (const transient of [{ code: 429 }, { statusCode: 503 }, { code: 'ECONNREFUSED' }, { name: 'TimeoutError' }]) {
        const { execute } = operator();
        const response = await execute(op('recoverWorkItem'), fail(Object.assign(new Error('dependency'), transient)), bodyRequest('recoverWorkItem'));
        const problem = assertProblem(response, 503, 'dependency_unavailable');
        assert.equal(response.headers['Retry-After'], '5');
        assert.equal(problem.retryAfterSeconds, 5);
      }
    });

    it('treats a non-transient SDK error as an internal error', async () => {
      const { execute } = operator();
      const response = await execute(op('recoverWorkItem'), fail(Object.assign(new Error('bad request'), { code: 400 })), bodyRequest('recoverWorkItem'));
      assertProblem(response, 500, 'internal_error');
    });

    it('passes a declared client error through', async () => {
      const { execute } = operator();
      const response = await execute(op('recoverWorkItem'), fail(conflict('stale_version', 'Stale')), bodyRequest('recoverWorkItem'));
      assertProblem(response, 409, 'stale_version');
    });
  });

  describe('response contract', () => {
    it('replaces a body that violates the contract with an opaque 500 when enforcing', async () => {
      const { execute, lines, recording } = setup();
      const response = await execute(op('getHealth'), recording({ status: 200, body: { status: 'sideways', extra: 1 } }), request());
      assertProblem(response, 500, 'response_contract_violation');
      assert.equal(response.body?.includes('sideways'), false);
      assert.ok(lines.some((line) => line.includes('response violates the contract')));
    });

    it('replaces a status the operation does not declare when enforcing', async () => {
      const { execute, recording } = setup();
      const response = await execute(op('getHealth'), recording({ status: 202, body: { status: 'ok' } }), request());
      assertProblem(response, 500, 'response_contract_violation');
    });

    it('also holds an undeclared error status to the contract', async () => {
      const { execute } = setup();
      const response = await execute(op('getHealth'), () => Promise.reject(notFound()), request());
      assertProblem(response, 500, 'response_contract_violation');
    });

    it('logs the violation but returns the response when only logging', async () => {
      const { execute, lines, recording } = setup({ config: { responseValidation: 'log' } });
      const response = await execute(op('getHealth'), recording({ status: 200, body: { status: 'sideways' } }), request());
      assert.equal(response.status, 200);
      assert.ok(lines.some((line) => line.includes('response violates the contract')));
    });
  });

  describe('diagnostics', () => {
    it('logs one completion line with the route, status, tenant and request-unit totals', async () => {
      const { execute, lines } = setup({ principal: principalWith('Operator') });
      const handler: Handler<PipelineServices> = () => {
        recordCharge(2.5);
        recordCharge(1.25);
        recordCharge(undefined);
        return Promise.resolve(RECOVERED);
      };
      await execute(op('recoverWorkItem'), handler, bodyRequest('recoverWorkItem'));
      const completed = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((record) => record['message'] === 'request completed');
      assert.equal(completed.length, 1);
      const record = completed[0] ?? {};
      assert.equal(record['operationId'], 'recoverWorkItem');
      assert.equal(record['method'], 'POST');
      assert.equal(record['route'], '/operator/work/{workId}/recover');
      assert.equal(record['status'], 202);
      assert.equal(record['tenantId'], 'aurora');
      assert.equal(record['cosmosRequestUnits'], 3.75);
      assert.equal(record['cosmosMeasuredOperations'], 2);
      assert.equal(record['cosmosUnmeasuredOperations'], 1);
      assert.equal(typeof record['durationMs'], 'number');
    });

    it('omits request-unit fields when the request touched no data', async () => {
      const { execute, lines, recording } = setup();
      await execute(op('getHealth'), recording(OK), request());
      const record = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
      assert.equal('cosmosRequestUnits' in record, false);
      assert.equal('tenantId' in record, false);
    });

    it('never logs the credentials or the content of a request, whichever way the request ends', async () => {
      const secretText = 'free text that must stay out of logs';
      const credential = 'scheme super-secret-credential';
      const outcomes: Record<string, { payload: string; handler: Handler<PipelineServices> }> = {
        success: { payload: JSON.stringify({ action: 'requeue', reason: secretText }), handler: () => Promise.resolve(RECOVERED) },
        invalid: { payload: JSON.stringify({ action: 'requeue', reason: secretText, [secretText]: 1 }), handler: () => Promise.resolve(RECOVERED) },
        refused: { payload: JSON.stringify({ action: 'requeue', reason: secretText }), handler: () => Promise.reject(new HttpError(409, 'stale_version', 'Stale')) },
        crashed: { payload: JSON.stringify({ action: 'requeue', reason: secretText }), handler: () => Promise.reject(new Error('boom')) },
      };
      for (const [name, { payload, handler }] of Object.entries(outcomes)) {
        const { execute, lines } = setup({ principal: principalWith('Operator') });
        const bytes = ENCODER.encode(payload);
        await execute(
          op('recoverWorkItem'),
          handler,
          bodyRequest('recoverWorkItem', { body: streamOf(bytes), length: bytes.byteLength, headers: { authorization: credential } }),
        );
        assert.ok(lines.length > 0, name);
        const everything = lines.join('\n');
        assert.equal(everything.includes('super-secret-credential'), false, name);
        assert.equal(everything.includes(secretText), false, name);
      }
    });

    it('gives a handler a logger that names the tenant and a hash prefix, never the object id', async () => {
      const { execute, lines } = setup({ principal: principalWith('Representative') });
      const handler: Handler<PipelineServices> = (ctx) => {
        ctx.logger.info('handler ran');
        return Promise.resolve(SESSION);
      };
      const response = await execute(op('getSession'), handler, request({ path: '/api/session', headers: { authorization: 'x' } }));
      assert.equal(response.status, 200, response.body);
      const record = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry['message'] === 'handler ran');
      assert.ok(record, 'the handler log line');
      assert.equal(record['tenantId'], 'aurora');
      assert.match(String(record['principal']), /^[0-9a-f]{12}$/);
      assert.equal(record['operationId'], 'getSession');
      assert.equal(lines.join('\n').includes('00000000-0000-4000-8000-0000000000a1'), false);
    });
  });
});
