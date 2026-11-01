import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CaseWriteError } from '../../src/cases/store.ts';
import { defineCaseStoreConformance } from '../support/case-store-conformance.ts';
import { newCaseId, sampleCase, sampleRun, uniqueTenant } from '../support/case-fixtures.ts';
import { createMemoryCases } from '../support/memory-case-store.ts';

defineCaseStoreConformance('in-memory twin', () => createMemoryCases());

describe('in-memory case store fault injection', () => {
  it('writes nothing when a failure is injected before the commit', async () => {
    const memory = createMemoryCases();
    const tenant = uniqueTenant();
    const caseId = newCaseId();
    memory.hooks.beforeCommit = () => {
      throw new Error('injected');
    };
    await assert.rejects(memory.store.commit(tenant, caseId, [{ op: 'create', doc: sampleCase(tenant, caseId) }]), /injected/);
    assert.deepEqual(memory.docs(tenant, caseId), []);
    assert.deepEqual(memory.batches, []);
  });

  it('applies the batch when the response is lost, so a retry meets the existing documents', async () => {
    const memory = createMemoryCases();
    const tenant = uniqueTenant();
    const caseId = newCaseId();
    memory.hooks.afterCommit = () => {
      throw new Error('response lost');
    };
    const ops = [{ op: 'create' as const, doc: sampleCase(tenant, caseId) }, { op: 'create' as const, doc: sampleRun(tenant, caseId) }];
    await assert.rejects(memory.store.commit(tenant, caseId, ops), /response lost/);
    assert.equal(memory.docs(tenant, caseId).length, 2);

    memory.hooks.afterCommit = undefined;
    await assert.rejects(memory.store.commit(tenant, caseId, ops), (error: unknown) => error instanceof CaseWriteError && error.reason === 'exists');
  });

  it('records which documents each batch wrote, in order', async () => {
    const memory = createMemoryCases();
    const tenant = uniqueTenant();
    const caseId = newCaseId();
    await memory.store.commit(tenant, caseId, [
      { op: 'create', doc: sampleCase(tenant, caseId) },
      { op: 'create', doc: sampleRun(tenant, caseId) },
    ]);
    assert.deepEqual(memory.batches, [
      {
        tenantId: tenant,
        caseId,
        ops: [
          { op: 'create', type: 'case', id: 'case' },
          { op: 'create', type: 'run', id: 'run-1' },
        ],
      },
    ]);
  });
});
