import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadContract, type OperationSpec } from '../../src/contract/load.ts';

const contract = loadContract();

interface ContractDocument {
  components: { schemas: Record<string, unknown> };
  paths: Record<string, Record<string, { operationId: string; requestBody?: { required?: boolean } }>>;
}
const document = contract.document as ContractDocument;

const EXPECTED_OPERATIONS = [
  'approveProposal',
  'createCase',
  'getAccount',
  'getCase',
  'getCaseTimeline',
  'getCreditResult',
  'getHealth',
  'getInvestigationRun',
  'getInvoice',
  'getOperatorWorkItem',
  'getPolicy',
  'getProposal',
  'getReadiness',
  'getSession',
  'listCases',
  'listInvestigationRuns',
  'listInvoices',
  'listOperatorWork',
  'listPolicies',
  'listProposals',
  'listRunUsageEvents',
  'recoverWorkItem',
  'rejectProposal',
  'requestRevision',
];

function op(operationId: string): OperationSpec {
  const found = contract.byId.get(operationId);
  assert.ok(found, `operation ${operationId} is not in the contract`);
  return found;
}

describe('contract loader', () => {
  it('registers exactly the expected operations', () => {
    assert.deepEqual([...contract.byId.keys()].sort(), EXPECTED_OPERATIONS);
    assert.equal(contract.operations.length, EXPECTED_OPERATIONS.length);
  });

  it('serves every route under api/ with GET or POST only', () => {
    for (const operation of contract.operations) {
      assert.ok(operation.route.startsWith('api/'), `${operation.operationId} route ${operation.route}`);
      assert.ok(operation.method === 'GET' || operation.method === 'POST');
    }
  });

  it('treats only health and readiness as anonymous', () => {
    const anonymous = contract.operations.filter((operation) => operation.roles === null).map((o) => o.operationId);
    assert.deepEqual(anonymous.sort(), ['getHealth', 'getReadiness']);
  });

  it('declares 400 on every operation', () => {
    for (const operation of contract.operations) {
      assert.ok(operation.responses.has(400), `${operation.operationId} must declare 400`);
    }
  });

  it('declares 401 and 403 on every secured operation', () => {
    for (const operation of contract.operations.filter((o) => o.roles !== null)) {
      assert.ok(operation.responses.has(401), `${operation.operationId} must declare 401`);
      assert.ok(operation.responses.has(403), `${operation.operationId} must declare 403`);
    }
  });

  it('declares 411, 413 and 415 on every operation with a body', () => {
    for (const operation of contract.operations.filter((o) => o.bodySchema !== null)) {
      assert.ok(operation.responses.has(411), `${operation.operationId} must declare 411`);
      assert.ok(operation.responses.has(413), `${operation.operationId} must declare 413`);
      assert.ok(operation.responses.has(415), `${operation.operationId} must declare 415`);
    }
  });

  it('declares 429 on the operations that are admission controlled', () => {
    assert.ok(op('createCase').responses.has(429));
    assert.ok(op('requestRevision').responses.has(429));
  });

  it('requires every request body, because the pipeline treats them all as required', () => {
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (operation.requestBody !== undefined) {
          assert.equal(operation.requestBody.required, true, `${method} ${path} requestBody.required`);
        }
      }
    }
  });

  it('compiles every component schema under strict Ajv', () => {
    for (const name of Object.keys(document.components.schemas)) {
      assert.doesNotThrow(() => contract.validateComponent(name, {}), `component ${name}`);
    }
  });

  it('compiles every declared body, parameter and response schema', () => {
    for (const operation of contract.operations) {
      if (operation.bodySchema !== null) contract.validateBody(operation, {});
      contract.validateParams(operation, { path: {}, query: new URLSearchParams(), header: () => null });
      for (const status of operation.responses.keys()) contract.validateResponse(operation, status, {});
    }
  });
});

describe('parameter validation', () => {
  const noHeaders = () => null;

  it('coerces a valid page size to a number', () => {
    const { values, errors } = contract.validateParams(op('listCases'), {
      path: {},
      query: new URLSearchParams('limit=5'),
      header: noHeaders,
    });
    assert.deepEqual(errors, []);
    assert.equal(values.query['limit'], 5);
  });

  it('applies the documented default page size', () => {
    const { values } = contract.validateParams(op('listCases'), { path: {}, query: new URLSearchParams(), header: noHeaders });
    assert.equal(values.query['limit'], 20);
  });

  it('rejects out-of-range and non-numeric page sizes', () => {
    for (const limit of ['0', '51', 'abc', '1.5']) {
      const { errors } = contract.validateParams(op('listCases'), {
        path: {},
        query: new URLSearchParams({ limit }),
        header: noHeaders,
      });
      assert.ok(errors.some((e) => e.pointer.startsWith('/query')), `limit=${limit}`);
    }
  });

  it('rejects unknown query parameters', () => {
    const { errors } = contract.validateParams(op('listCases'), {
      path: {},
      query: new URLSearchParams('surprise=1'),
      header: noHeaders,
    });
    assert.ok(errors.length > 0);
  });

  it('rejects repeated query parameters', () => {
    const { errors } = contract.validateParams(op('listCases'), {
      path: {},
      query: new URLSearchParams('limit=1&limit=2'),
      header: noHeaders,
    });
    assert.ok(errors.some((e) => e.code === 'duplicate_parameter'));
  });

  it('rejects malformed path parameters', () => {
    const { errors } = contract.validateParams(op('getCase'), {
      path: { caseId: '../etc/passwd' },
      query: new URLSearchParams(),
      header: noHeaders,
    });
    assert.ok(errors.some((e) => e.pointer === '/path/caseId'));
  });

  it('accepts a well-formed case id', () => {
    const { errors } = contract.validateParams(op('getCase'), {
      path: { caseId: `case_${'a'.repeat(32)}` },
      query: new URLSearchParams(),
      header: noHeaders,
    });
    assert.deepEqual(errors, []);
  });

  it('requires a well-formed idempotency key to create a case', () => {
    const headerWith = (value: string | null) => (name: string) => (name.toLowerCase() === 'idempotency-key' ? value : null);
    const missing = contract.validateParams(op('createCase'), { path: {}, query: new URLSearchParams(), header: headerWith(null) });
    const short = contract.validateParams(op('createCase'), { path: {}, query: new URLSearchParams(), header: headerWith('short') });
    const good = contract.validateParams(op('createCase'), {
      path: {},
      query: new URLSearchParams(),
      header: headerWith('demo-key-0123456789'),
    });
    assert.ok(missing.errors.length > 0, 'missing key');
    assert.ok(short.errors.length > 0, 'short key');
    assert.deepEqual(good.errors, []);
  });
});

describe('body validation', () => {
  const valid = { accountId: 'acct_aurora_0001', category: 'duplicate_charge', description: 'Charged twice in March.' };

  it('accepts a minimal case', () => {
    assert.deepEqual(contract.validateBody(op('createCase'), valid), []);
  });

  it('accepts a case with invoices and a requested credit', () => {
    const body = {
      ...valid,
      invoiceIds: ['inv_aurora_0001_a', 'inv_aurora_0001_b'],
      requestedCredit: { amountMinor: 4900, currency: 'USD' },
    };
    assert.deepEqual(contract.validateBody(op('createCase'), body), []);
  });

  it('rejects missing, unknown and out-of-range fields', () => {
    const bad: unknown[] = [
      {},
      { ...valid, extra: true },
      { ...valid, description: '' },
      { ...valid, description: 'x'.repeat(4001) },
      { ...valid, category: 'unknown' },
      { ...valid, requestedCredit: { amountMinor: -1, currency: 'USD' } },
      { ...valid, requestedCredit: { amountMinor: 10, currency: 'JPY' } },
      { ...valid, invoiceIds: ['inv_aurora_0001_a', 'inv_aurora_0001_a'] },
      [],
      null,
    ];
    for (const body of bad) {
      assert.ok(contract.validateBody(op('createCase'), body).length > 0, JSON.stringify(body));
    }
  });

  it('binds decisions to a proposal digest and policy version', () => {
    const digest = `sha256:${'0'.repeat(64)}`;
    assert.deepEqual(contract.validateBody(op('approveProposal'), { policyVersion: 2, proposalDigest: digest }), []);
    assert.ok(contract.validateBody(op('approveProposal'), { policyVersion: 2 }).length > 0);
    assert.ok(contract.validateBody(op('approveProposal'), { policyVersion: 2, proposalDigest: 'sha256:abc' }).length > 0);
    assert.ok(contract.validateBody(op('rejectProposal'), { policyVersion: 2, proposalDigest: digest }).length > 0, 'reason required');
  });

  it('returns pointers and codes that fit the Problem schema', () => {
    const errors = contract.validateBody(op('createCase'), { ...valid, extra: true, description: '' });
    const problem = {
      type: 'about:blank',
      title: 'Request validation failed',
      status: 400,
      code: 'validation_failed',
      correlationId: 'corr-0123456789',
      errors,
    };
    assert.deepEqual(contract.validateComponent('Problem', problem), []);
  });
});

describe('response validation', () => {
  it('reports an undeclared status', () => {
    const errors = contract.validateResponse(op('getHealth'), 418, {});
    assert.ok(errors.some((e) => e.code === 'undeclared_status'));
  });

  it('validates declared problem responses', () => {
    const problem = { type: 'about:blank', title: 'Not found', status: 404, code: 'not_found', correlationId: 'corr-0123456789' };
    assert.deepEqual(contract.validateResponse(op('getCase'), 404, problem), []);
    assert.ok(contract.validateResponse(op('getCase'), 404, { ...problem, status: 200 }).length > 0);
    assert.ok(contract.validateResponse(op('getCase'), 404, { ...problem, leaked: 'stack trace' }).length > 0);
  });

  it('rejects an unknown component name', () => {
    assert.throws(() => contract.validateComponent('NoSuchSchema', {}));
  });
});
