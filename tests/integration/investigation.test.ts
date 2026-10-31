import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import { CASE_DOC_ID, IDEMPOTENCY_DOC_ID, isTerminalRun } from '../../src/cases/documents.ts';
import { BASE_RUN_LIMITS } from '../../src/config/limits.ts';
import { deriveCaseId } from '../../src/domain/ids.ts';
import { objectIdFor, type Api, type ApiResult } from '../support/api.ts';
import { assertApiHeaders, assertProblem, jsonBody } from '../support/assertions.ts';
import {
  BOREALIS,
  BOREALIS_INVOICES,
  CONTRADICTORY_EVIDENCE,
  CORRELATION_ID,
  DUPLICATE,
  DUPLICATE_INVOICES,
  HOSTILE,
  MISSING_EVIDENCE,
  OUTBOX_ID,
  TENANT,
  approver,
  caseFlow,
  colleague,
  docsOfType,
  eur,
  newKey,
  operator,
  representative,
  stranger,
  usd,
  withoutCorrelation,
  type CaseAccepted,
  type CaseStatus,
  type Created,
  type CreateCaseRequest,
  type DocOfType,
  type Problem,
} from '../support/case-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';
import { sleep, waitFor } from '../support/wait.ts';

const APPROVAL_WINDOW_MS = 72 * 60 * 60 * 1000;

const READS: readonly { name: string; path: (caseId: string) => string }[] = [
  { name: 'getCase', path: (id) => `/api/cases/${id}` },
  { name: 'getCaseTimeline', path: (id) => `/api/cases/${id}/timeline` },
  { name: 'listInvestigationRuns', path: (id) => `/api/cases/${id}/runs` },
  { name: 'getInvestigationRun', path: (id) => `/api/cases/${id}/runs/run-1` },
  { name: 'listRunUsageEvents', path: (id) => `/api/cases/${id}/runs/run-1/usage` },
  { name: 'listProposals', path: (id) => `/api/cases/${id}/proposals` },
  { name: 'getProposal', path: (id) => `/api/cases/${id}/proposals/1` },
];

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;

before(() => {
  stack = readStackConnection();
  api = connectApi(stack);
  cosmos = openEmulator(stack);
});

after(() => {
  cosmos.dispose();
});

const {
  admission,
  awaitCase,
  awaitCompletedOutbox,
  casePages,
  createCase,
  getCase,
  getProposal,
  readStored,
  storedDocs,
  submitRaw,
  timelinePages,
  usagePages,
} = caseFlow(() => ({ stack, api, cosmos }));

/** Waits until the host log shows the request with this correlation id, then returns the whole log. */
function hostLogAfter(correlationId: string): Promise<string> {
  return waitFor(
    'the host log to record the request',
    async () => {
      const text = await readFile(stack.hostLog, 'utf8');
      return text.includes(correlationId) ? text : undefined;
    },
    { timeoutMs: 20_000, intervalMs: 500 },
  );
}

describe('submitting a case', () => {
  it('acknowledges with 202 only after the case, its run and its queued work are stored', async () => {
    const key = newKey('ack');
    const { accepted, response } = await createCase(representative, key);
    const caseId = accepted.case.caseId;
    const principalId = objectIdFor(representative.label);

    assert.equal(caseId, deriveCaseId(TENANT, principalId, key), 'the case id derives from tenant, caller and key');
    assert.equal(accepted.runId, 'run-1');
    assert.equal(accepted.replayed, false);
    assert.equal(accepted.case.status, 'queued');
    assert.equal(accepted.case.tenantId, TENANT);
    assert.equal(accepted.case.revision, 1);
    assert.equal(accepted.case.latestProposal, null);
    assert.deepEqual(accepted.case.createdBy, { type: 'user', id: principalId });
    assert.equal(response.headers.get('location'), `/api/cases/${caseId}`);
    assert.equal(response.headers.get('retry-after'), '2');
    assert.equal(response.headers.get('idempotency-replayed'), 'false');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('x-correlation-id') ?? '', CORRELATION_ID);

    const docs = await storedDocs(TENANT, caseId);
    const ids = docs.map((doc) => doc.id);
    for (const id of [CASE_DOC_ID, IDEMPOTENCY_DOC_ID, 'run-1', 'tl-00001', 'tl-00002', OUTBOX_ID]) {
      assert.ok(ids.includes(id), `${id} was stored before the 202`);
    }
    const [outbox] = docsOfType(docs, 'outbox');
    assert.ok(outbox);
    assert.equal(outbox.kind, 'investigation.start');
    assert.deepEqual(outbox.payload, { runId: 'run-1', revision: 1 });

    // A queued run holds an admission slot. If the slot is already gone, the run must already be over:
    // the slot is read first, so a release that happened before it implies a terminal run in the read after it.
    const held = (await admission(TENANT))?.slots.some((slot) => slot.runKey === `${caseId}:run-1`) ?? false;
    const run = await readStored<DocOfType<'run'>>(TENANT, caseId, 'run-1');
    assert.ok(run);
    assert.ok(held || isTerminalRun(run.state), 'the queued run holds its admission slot');
  });

  it('refuses an account that is unknown or belongs to another tenant, identically', async () => {
    const unknown = await submitRaw(representative, newKey('unknown'), { ...DUPLICATE, accountId: 'acct_aurora_9999' });
    const foreign = await submitRaw(representative, newKey('foreign'), { ...DUPLICATE, accountId: 'acct_borealis_0001' });
    assertProblem(unknown, 400, 'validation_failed');
    assert.deepEqual(
      jsonBody<Problem>(unknown).errors?.map((error) => [error.pointer, error.code]),
      [['/accountId', 'unknown_account']],
    );
    assert.equal(withoutCorrelation(foreign), withoutCorrelation(unknown));
  });

  it('refuses a credit in the wrong currency with a field error', async () => {
    const result = await submitRaw(representative, newKey('currency'), { ...DUPLICATE, requestedCredit: eur(4900) });
    assertProblem(result, 400, 'validation_failed');
    assert.deepEqual(
      jsonBody<Problem>(result).errors?.map((error) => [error.pointer, error.code]),
      [['/requestedCredit/currency', 'currency_mismatch']],
    );
  });
});

describe('the investigation of a duplicate-charge case', () => {
  const key = newKey('settled');
  let created: Created;
  let caseId: string;

  before(async () => {
    created = await createCase(representative, key);
    caseId = created.accepted.case.caseId;
    await awaitCase(representative, caseId, 'awaiting_approval');
    await awaitCompletedOutbox(caseId);
  });

  it('proposes the credit the evidence supports, citing the invoices and the governing clause', async () => {
    const proposal = await getProposal(representative, caseId, 1);
    assert.equal(proposal.caseId, caseId);
    assert.equal(proposal.version, 1);
    assert.equal(proposal.runId, 'run-1');
    assert.equal(proposal.kind, 'credit');
    assert.equal(proposal.status, 'pending_approval');
    assert.deepEqual(proposal.amount, usd(4900));
    assert.deepEqual(
      proposal.invoiceRefs.map((ref) => ref.invoiceId),
      DUPLICATE_INVOICES,
    );
    assert.deepEqual(proposal.policyRef, { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' });
    assert.equal(proposal.findingCode, null);
    assert.equal(proposal.evidenceAssessment, 'consistent');
    assert.match(proposal.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(proposal.decision, null, 'no one has decided yet');
    assert.ok(proposal.explanation.length > 0);

    assert.ok(proposal.approvalExpiresAt);
    const window = Date.parse(proposal.approvalExpiresAt) - Date.parse(proposal.createdAt);
    assert.ok(Math.abs(window - APPROVAL_WINDOW_MS) < 10 * 60 * 1000, `the approval window is about 72 hours, not ${String(window)} ms`);
  });

  it('shows one consistent picture through the case, run and proposal reads', async () => {
    const client = api.client(representative);
    const detail = await getCase(representative, caseId);
    assert.equal(detail.status, 'awaiting_approval');
    assert.equal(detail.description, DUPLICATE.description);
    assert.deepEqual(detail.invoiceIds, DUPLICATE.invoiceIds);
    assert.deepEqual(detail.requestedCredit, DUPLICATE.requestedCredit);
    assert.equal(detail.creditResult, null);
    assert.equal(detail.latestRun?.runId, 'run-1');
    assert.equal(detail.latestRun.state, 'completed');
    assert.equal(detail.latestRun.mode, 'demo');

    const proposal = await getProposal(representative, caseId, 1);
    assert.deepEqual(detail.latestProposal, {
      version: 1,
      kind: proposal.kind,
      status: proposal.status,
      amount: proposal.amount,
      approvalExpiresAt: proposal.approvalExpiresAt,
    });
    const listed = await client.GET('/cases/{caseId}/proposals', { params: { path: { caseId } } });
    assert.deepEqual(listed.data?.items, [proposal]);

    const runs = await client.GET('/cases/{caseId}/runs', { params: { path: { caseId } } });
    assert.deepEqual(
      runs.data?.items.map((run) => [run.runId, run.state]),
      [['run-1', 'completed']],
    );
    const single = await client.GET('/cases/{caseId}/runs/{runId}', { params: { path: { caseId, runId: 'run-1' } } });
    assert.deepEqual(single.data, runs.data?.items[0]);
    assert.equal(single.data?.stopReason, null);
    assert.ok(single.data?.startedAt);
    assert.ok(single.data.finishedAt);
  });

  it('pages the timeline in order', async () => {
    const pages = await timelinePages(representative, caseId, 3);
    assert.deepEqual(
      pages.map((page) => page.length),
      [3, 3, 2],
    );
    assert.deepEqual(
      pages.flat().map((item) => [item.seq, item.kind]),
      [
        [1, 'case_created'],
        [2, 'run_queued'],
        [3, 'run_started'],
        [4, 'tool_called'],
        [5, 'tool_called'],
        [6, 'tool_called'],
        [7, 'tool_called'],
        [8, 'proposal_submitted'],
      ],
    );
    const whole = await timelinePages(representative, caseId, 50);
    assert.deepEqual(whole.flat(), pages.flat(), 'the page size does not change the content');
  });

  it('records the demo investigator usage as not applicable rather than as zero, and within its limits', async () => {
    const pages = await usagePages(representative, caseId, 'run-1', 2);
    assert.deepEqual(
      pages.map((page) => page.length),
      [2, 2, 1],
    );
    const events = pages.flat();
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      events.map((event) => event.name),
      ['get_account', 'get_policy', 'get_invoice', 'get_invoice', 'submit_proposal'],
    );
    for (const event of events) {
      assert.equal(event.kind, 'tool');
      assert.equal(event.outcome, 'succeeded');
      assert.equal(event.tokenQuality, 'not_applicable');
      assert.equal(event.inputTokens, null, 'a demo run reports no token usage rather than zero');
      assert.equal(event.outputTokens, null);
      assert.equal(event.errorCode, null);
    }

    const { data: run } = await api.client(representative).GET('/cases/{caseId}/runs/{runId}', { params: { path: { caseId, runId: 'run-1' } } });
    assert.ok(run);
    assert.equal(run.usage.toolCalls, events.length);
    assert.equal(run.usage.steps, events.length);
    assert.equal(run.usage.modelCalls, 0);
    assert.equal(run.usage.failedCalls, 0);
    assert.equal(run.usage.ambiguousCalls, 0);
    assert.equal(run.usage.inputTokens, null);
    assert.equal(run.usage.tokenQuality, 'not_applicable');
    assert.deepEqual(run.limits, BASE_RUN_LIMITS, 'the limits were fixed when the run was created');
  });

  it('ran the queued work exactly once and released its admission slot', async () => {
    const docs = await storedDocs(TENANT, caseId);
    const [outbox, ...others] = docsOfType(docs, 'outbox');
    assert.ok(outbox);
    assert.equal(others.length, 0);
    assert.equal(outbox.state, 'completed');
    assert.equal(outbox.attempts, 1, 'one claim, one execution');
    assert.equal(outbox.lastError, null);

    const runs = docsOfType(docs, 'run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.state, 'completed');
    assert.equal(docsOfType(docs, 'proposal').length, 1);
    assert.equal(docsOfType(docs, 'usage').length, 5);

    const slots = (await admission(TENANT))?.slots ?? [];
    assert.equal(
      slots.some((slot) => slot.runKey === `${caseId}:run-1`),
      false,
      'compute and its slot are released while the case waits for a person',
    );
  });

  it('replays the original answer for an identical request and creates nothing', async () => {
    const before = (await storedDocs(TENANT, caseId)).map((doc) => doc.id).sort();
    const replay = await createCase(representative, key);

    assert.equal(replay.accepted.replayed, true);
    assert.equal(replay.response.headers.get('idempotency-replayed'), 'true');
    assert.equal(replay.accepted.case.caseId, caseId);
    assert.equal(replay.accepted.runId, 'run-1');
    assert.equal(replay.response.headers.get('location'), `/api/cases/${caseId}`);
    assert.deepEqual(replay.accepted.case, created.accepted.case, 'the snapshot taken at creation, not the current state');
    assert.equal(replay.accepted.case.status, 'queued');

    const reordered = await submitRaw(representative, key, {
      description: DUPLICATE.description,
      requestedCredit: DUPLICATE.requestedCredit,
      category: DUPLICATE.category,
      invoiceIds: DUPLICATE.invoiceIds,
      accountId: DUPLICATE.accountId,
    });
    assert.equal(reordered.status, 202, 'the order of properties does not matter');
    assert.equal(reordered.headers.get('idempotency-replayed'), 'true');

    assert.deepEqual(
      (await storedDocs(TENANT, caseId)).map((doc) => doc.id).sort(),
      before,
      'a replay writes nothing',
    );
  });

  it('refuses the same key with a different request', async () => {
    const before = (await storedDocs(TENANT, caseId)).map((doc) => doc.id).sort();
    const changed: CreateCaseRequest[] = [
      { ...DUPLICATE, description: 'A different description.' },
      { ...DUPLICATE, invoiceIds: [...DUPLICATE_INVOICES].reverse() },
      { ...DUPLICATE, requestedCredit: usd(4800) },
    ];
    for (const body of changed) {
      const result = await submitRaw(representative, key, body);
      assertProblem(result, 409, 'idempotency_key_reused');
    }
    assert.deepEqual((await storedDocs(TENANT, caseId)).map((doc) => doc.id).sort(), before);
    assert.equal((await getCase(representative, caseId)).description, DUPLICATE.description);
  });

  it('scopes the key to the tenant and to the caller', async () => {
    const sameKey = await createCase(colleague, key);
    assert.equal(sameKey.accepted.case.caseId, deriveCaseId(TENANT, objectIdFor(colleague.label), key));
    assert.notEqual(sameKey.accepted.case.caseId, caseId);
    assert.equal(sameKey.accepted.replayed, false);
    assert.equal(sameKey.accepted.case.createdBy.id, objectIdFor(colleague.label));

    const otherTenant = await createCase(stranger, key, BOREALIS);
    assert.equal(otherTenant.accepted.case.caseId, deriveCaseId('borealis', objectIdFor(stranger.label), key));
    assert.equal(otherTenant.accepted.case.tenantId, 'borealis');
    assert.equal(otherTenant.accepted.replayed, false);

    assert.equal((await getCase(representative, caseId)).createdBy.id, objectIdFor(representative.label), 'the original is untouched');
  });

  it('keeps the idempotency key and the case text out of stored documents and the host log', async () => {
    const stored = JSON.stringify(await storedDocs(TENANT, caseId));
    assert.equal(stored.includes(key), false, 'the key is never stored');

    const correlationId = created.response.headers.get('x-correlation-id');
    assert.ok(correlationId);
    const log = await hostLogAfter(correlationId);
    assert.equal(log.includes(key), false, 'the key never reaches the log');
    assert.equal(log.includes(DUPLICATE.description), false, 'free text never reaches the log');
  });
});

describe('concurrent identical submissions', () => {
  /** A well-behaved client: it waits as long as the server asks and tries again when admission is busy. */
  async function submitPatiently(key: string): Promise<ApiResult> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await submitRaw(representative, key, DUPLICATE);
      if (result.status !== 429) return result;
      assertProblem(result, 429, 'tenant_admission_busy');
      await sleep(Math.min(5, Number(result.headers.get('retry-after') ?? '1')) * 1000);
    }
    throw new Error('admission stayed busy for six attempts');
  }

  it('create one case, one run and one investigation however many requests race', async () => {
    const key = newKey('race');
    const results = await Promise.all(Array.from({ length: 5 }, () => submitPatiently(key)));

    for (const result of results) {
      assert.equal(result.status, 202, result.text.slice(0, 300));
      assertApiHeaders(result);
    }
    const caseIds = new Set(results.map((result) => jsonBody<CaseAccepted>(result).case.caseId));
    assert.equal(caseIds.size, 1, 'one case id');
    const [caseId] = [...caseIds];
    assert.ok(caseId);
    assert.equal(caseId, deriveCaseId(TENANT, objectIdFor(representative.label), key));
    const fresh = results.filter((result) => result.headers.get('idempotency-replayed') === 'false');
    assert.equal(fresh.length, 1, 'exactly one request created the case; the others replayed it');

    await awaitCase(representative, caseId, 'awaiting_approval');
    await awaitCompletedOutbox(caseId);
    const docs = await storedDocs(TENANT, caseId);
    assert.equal(docsOfType(docs, 'case').length, 1);
    assert.equal(docsOfType(docs, 'idempotency').length, 1);
    assert.equal(docsOfType(docs, 'run').length, 1);
    assert.equal(docsOfType(docs, 'outbox').length, 1);
    assert.equal(docsOfType(docs, 'outbox')[0]?.attempts, 1, 'the work ran once');
    assert.equal(docsOfType(docs, 'usage').length, 5, 'one investigation, not five');
    assert.equal(docsOfType(docs, 'proposal').length, 1);
    assert.deepEqual(
      docsOfType(docs, 'timeline')
        .map((item) => item.seq)
        .sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  });
});

describe('what the investigator may conclude', () => {
  const FINDINGS = [
    { name: 'missing evidence', body: MISSING_EVIDENCE, code: 'missing_evidence', assessment: 'missing' },
    { name: 'contradictory evidence', body: CONTRADICTORY_EVIDENCE, code: 'contradictory_evidence', assessment: 'contradictory' },
  ] as const;

  for (const scenario of FINDINGS) {
    it(`reports ${scenario.name} as a finding and invents no credit`, async () => {
      const { accepted } = await createCase(representative, newKey('finding'), scenario.body);
      const caseId = accepted.case.caseId;
      const detail = await awaitCase(representative, caseId, 'finding_reported');
      assert.equal(detail.latestProposal?.kind, 'finding');
      assert.equal(detail.latestProposal.amount, null);
      assert.equal(detail.latestProposal.approvalExpiresAt, null, 'a finding is not waiting for approval, so it does not expire');
      assert.equal(detail.creditResult, null);

      const proposal = await getProposal(representative, caseId, 1);
      assert.equal(proposal.kind, 'finding');
      assert.equal(proposal.status, 'reported');
      assert.equal(proposal.amount, null);
      assert.equal(proposal.findingCode, scenario.code);
      assert.equal(proposal.evidenceAssessment, scenario.assessment);
      assert.deepEqual(proposal.policyRef, { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' });
      assert.equal(proposal.decision, null);
      assert.ok(proposal.explanation.length > 0);
    });
  }

  it('treats hostile case text as data and credits only what the evidence supports', async () => {
    const { accepted, response } = await createCase(representative, newKey('hostile'), {
      ...DUPLICATE,
      description: HOSTILE,
      requestedCredit: undefined,
    });
    const caseId = accepted.case.caseId;
    const detail = await awaitCase(representative, caseId, 'awaiting_approval');
    assert.equal(detail.description, HOSTILE, 'shown back verbatim, as data');
    assert.equal(detail.creditResult, null);

    const proposal = await getProposal(representative, caseId, 1);
    assert.equal(proposal.status, 'pending_approval');
    assert.equal(proposal.decision, null, 'the model cannot approve');
    assert.deepEqual(proposal.amount, usd(4900), 'the credit follows the evidence and the policy, not the text');

    const client = api.client(representative);
    const derived = [
      JSON.stringify(proposal),
      JSON.stringify((await client.GET('/cases/{caseId}/timeline', { params: { path: { caseId } } })).data),
      JSON.stringify((await client.GET('/cases/{caseId}/runs', { params: { path: { caseId } } })).data),
      JSON.stringify((await client.GET('/cases/{caseId}/runs/{runId}/usage', { params: { path: { caseId, runId: 'run-1' } } })).data),
    ];
    for (const text of derived) {
      assert.equal(text.includes('ignore the credit policy'), false);
      assert.equal(text.includes('<script>'), false);
    }

    const correlationId = response.headers.get('x-correlation-id');
    assert.ok(correlationId);
    assert.equal((await hostLogAfter(correlationId)).includes('ignore the credit policy'), false, 'hostile text never reaches the log');
  });

  it('serves a second tenant from its own evidence and in its own currency', async () => {
    const { accepted } = await createCase(stranger, newKey('borealis'), BOREALIS);
    const caseId = accepted.case.caseId;
    await awaitCase(stranger, caseId, 'awaiting_approval');
    const proposal = await getProposal(stranger, caseId, 1);
    assert.deepEqual(proposal.amount, eur(5900));
    assert.deepEqual(proposal.policyRef, { policyId: 'credit-policy', version: 1, clauseId: 'dup-charge' });
    assert.deepEqual(
      proposal.invoiceRefs.map((ref) => ref.invoiceId),
      BOREALIS_INVOICES,
    );
  });
});

describe('tenant and role boundaries', () => {
  let caseId: string;

  before(async () => {
    const { accepted } = await createCase(representative, newKey('boundary'));
    caseId = accepted.case.caseId;
    await awaitCase(representative, caseId, 'awaiting_approval');
  });

  it('answers a case of another tenant exactly like an unknown case', async () => {
    const unknownId = deriveCaseId('borealis', objectIdFor('nobody'), 'unknown-case-key-0000');
    for (const read of READS) {
      const own = await api.get(read.path(caseId), { as: representative });
      assert.equal(own.status, 200, `${read.name} as the owner`);
      assertApiHeaders(own);

      const foreign = await api.get(read.path(caseId), { as: stranger });
      const unknown = await api.get(read.path(unknownId), { as: stranger });
      assertProblem(foreign, 404, 'not_found');
      assertProblem(unknown, 404, 'not_found');
      assert.equal(withoutCorrelation(foreign), withoutCorrelation(unknown), `${read.name}: another tenant's case is indistinguishable from none`);
    }
  });

  it('keeps a case out of the listings of another tenant', async () => {
    const strangerCases = (await casePages(stranger, 50)).flat();
    assert.equal(
      strangerCases.some((item) => item.caseId === caseId),
      false,
    );
    for (const item of strangerCases) assert.equal(item.tenantId, 'borealis');
    const own = (await casePages(representative, 50)).flat();
    assert.ok(own.some((item) => item.caseId === caseId));
    for (const item of own) assert.equal(item.tenantId, TENANT);
  });

  it('lets every role of the owning tenant read the case', async () => {
    for (const who of [colleague, approver, operator]) {
      for (const read of READS) {
        const result = await api.get(read.path(caseId), { as: who });
        assert.equal(result.status, 200, `${read.name} as ${who.role}`);
      }
      assert.ok((await casePages(who, 50)).flat().some((item) => item.caseId === caseId), `${who.role} sees the case in the listing`);
    }
  });

  it('requires authentication for every read', async () => {
    for (const read of READS) assertProblem(await api.get(read.path(caseId)), 401, 'unauthenticated');
    assertProblem(await api.get('/api/cases'), 401, 'unauthenticated');
  });

  it('answers 404 for a run or proposal that does not exist and 400 for a malformed request', async () => {
    for (const path of [`/api/cases/${caseId}/runs/run-2`, `/api/cases/${caseId}/runs/run-2/usage`, `/api/cases/${caseId}/proposals/2`]) {
      assertProblem(await api.get(path, { as: representative }), 404, 'not_found');
    }
    for (const path of [
      `/api/cases/${caseId}/runs/run-9`,
      `/api/cases/${caseId}/proposals/0`,
      `/api/cases/${caseId}/proposals/x`,
      '/api/cases/nope',
      `/api/cases/${caseId}/timeline?limit=0`,
      '/api/cases?limit=51',
      '/api/cases?status=nope',
    ]) {
      assertProblem(await api.get(path, { as: representative }), 400, 'validation_failed');
    }
    for (const path of [`/api/cases/${caseId}/timeline?continuationToken=garbage`, '/api/cases?continuationToken=garbage']) {
      assertProblem(await api.get(path, { as: representative }), 400, 'invalid_continuation_token');
    }
  });
});

describe('listing cases', () => {
  it('lists the newest case first across pages and honours the status filter', async () => {
    const mine: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { accepted } = await createCase(representative, newKey(`list${String(index)}`), {
        ...DUPLICATE,
        description: `Listing check ${String(index)}.`,
      });
      mine.push(accepted.case.caseId);
      await sleep(20);
    }

    const pages = await casePages(representative, 2);
    for (const page of pages.slice(0, -1)) assert.equal(page.length, 2, 'every page but the last is full');
    const listed = pages.flat();
    const ids = listed.map((item) => item.caseId);
    assert.equal(new Set(ids).size, ids.length, 'no case appears twice');
    const created = listed.map((item) => item.createdAt);
    assert.deepEqual(created, [...created].sort().reverse(), 'newest first');
    const positions = mine.map((id) => ids.indexOf(id));
    assert.ok(
      positions.every((position) => position >= 0),
      'every new case is listed',
    );
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok((positions[index - 1] ?? -1) > (positions[index] ?? Number.MAX_SAFE_INTEGER), 'a later case is listed before an earlier one');
    }

    const settled: CaseStatus = 'awaiting_approval';
    for (const id of mine) await awaitCase(representative, id, settled);
    const filtered = (await casePages(representative, 2, settled)).flat();
    for (const item of filtered) assert.equal(item.status, settled);
    assert.deepEqual(
      filtered.map((item) => item.caseId).filter((id) => mine.includes(id)),
      [...mine].reverse(),
      'the filtered listing keeps the order',
    );
    const queued = (await casePages(representative, 50, 'queued')).flat();
    assert.equal(
      queued.some((item) => mine.includes(item.caseId)),
      false,
      'settled cases are not listed as queued',
    );
  });
});
