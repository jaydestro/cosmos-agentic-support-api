import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoInvestigator } from '../../src/agent/demo.ts';
import { createLiveInvestigator } from '../../src/agent/live.ts';
import { HTTP_LIMITS } from '../../src/config/limits.ts';
import { invoiceSortKey } from '../../src/data/documents.ts';
import { handlers } from '../../src/handlers/index.ts';
import { liveStatus } from '../../src/handlers/system.ts';
import { SEED_TENANTS } from '../../tools/seed/data/index.ts';
import { as, BASE_CONFIG, contract, harness, PRINCIPAL_ID, type CallOptions, type Reply } from '../support/handler-harness.ts';
import { scriptedModel } from '../support/scripted-model.ts';

const CASE_ID = `case_${'a'.repeat(32)}`;

interface Page<T> {
  items: T[];
  continuationToken: string | null;
}
interface InvoiceView {
  invoiceId: string;
  accountId: string;
  issuedAt: string;
}
interface PolicyView {
  policyId: string;
  version: number;
  status: string;
  clauses: { clauseId: string }[];
}

const AURORA = SEED_TENANTS.find((tenant) => tenant.tenantId === 'aurora');
const BOREALIS = SEED_TENANTS.find((tenant) => tenant.tenantId === 'borealis');
assert.ok(AURORA && BOREALIS, 'the seed data should hold both tenants');

const invoiceCounts = new Map<string, number>();
for (const invoice of AURORA.invoices) invoiceCounts.set(invoice.accountId, (invoiceCounts.get(invoice.accountId) ?? 0) + 1);
const [BUSY_ACCOUNT, BUSY_COUNT] = [...invoiceCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
const BUSY_INVOICES_NEWEST_FIRST = AURORA.invoices
  .filter((invoice) => invoice.accountId === BUSY_ACCOUNT)
  .map((invoice) => ({ id: invoice.invoiceId, key: invoiceSortKey(invoice.issuedAt, invoice.invoiceId) }))
  .sort((a, b) => (a.key < b.key ? 1 : -1))
  .map((entry) => entry.id);

const listInvoicesOf = (accountId: string, query: Record<string, string> = {}): CallOptions => ({ params: { accountId }, query });

describe('handler registry', () => {
  it('has exactly one handler per contract operation', () => {
    const operations = contract.operations.map((op) => op.operationId).sort();
    assert.equal(operations.length, 24);
    assert.deepEqual(Object.keys(handlers).sort(), operations);
  });

  it('cannot be changed after start-up', () => {
    assert.ok(Object.isFrozen(handlers));
  });

  it('keeps the decision and credit operations behind the role check and validation', async () => {
    const operator = harness({ roles: ['Operator'] });
    const forbidden = await operator.call('approveProposal', { params: { caseId: CASE_ID, version: '1' } });
    assert.equal(forbidden.status, 403);
    assert.equal(as<{ code: string }>(forbidden.json).code, 'forbidden_role');

    const invalid = await harness().call('getCreditResult', { params: { caseId: 'nope' } });
    assert.equal(invalid.status, 400);
    assert.equal(as<{ code: string }>(invalid.json).code, 'validation_failed');

    const unknown = await harness().call('getCreditResult', { params: { caseId: CASE_ID } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers['Content-Type'], 'application/problem+json; charset=utf-8');
    assert.equal(as<{ code: string }>(unknown.json).code, 'not_found');
  });
});

describe('system handlers', () => {
  it('answers the health probe without authenticating', async () => {
    const { call, authentications } = harness();
    const reply = await call('getHealth');
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json, { status: 'ok' });
    assert.equal(authentications.length, 0);
  });

  it('reports ready when the database answers and unavailable when it does not', async () => {
    const ready = harness();
    const up = await ready.call('getReadiness');
    assert.equal(up.status, 200);
    assert.deepEqual(up.json, { status: 'ok' });

    const down = harness();
    down.reference.failPing(new Error('database-host-unreachable'));
    const reply = await down.call('getReadiness');
    assert.equal(reply.status, 503);
    assert.deepEqual(reply.json, { status: 'unavailable' });
    assert.equal(JSON.stringify(reply.json).includes('database-host-unreachable'), false);
    assert.equal(down.lines.some((line) => line.includes('readiness probe failed')), true);
  });

  it('describes the caller and the environment, and labels credits as simulated', async () => {
    const { call, authentications } = harness({ roles: ['Representative', 'Operator'] });
    const reply = await call('getSession');
    assert.equal(reply.status, 200);
    assert.equal(authentications.length, 1);
    assert.deepEqual(reply.json, {
      principal: { principalId: PRINCIPAL_ID, tenantId: 'aurora', roles: ['Representative', 'Operator'] },
      environment: {
        agentMode: BASE_CONFIG.agent.mode,
        liveAvailable: false,
        liveBlockedReason: 'live_not_approved',
        simulatedCredits: true,
        apiVersion: contract.info.version,
      },
    });
  });

  it('reports live mode as blocked when it was approved but no model is configured', async () => {
    const approved = harness({ config: { agent: { ...BASE_CONFIG.agent, liveApproved: true } } });
    const reply = as<{ environment: { liveAvailable: boolean; liveBlockedReason: string | null; agentMode: string } }>(
      (await approved.call('getSession')).json,
    );
    assert.equal(reply.environment.liveAvailable, false);
    assert.equal(reply.environment.liveBlockedReason, 'live_not_configured');
    assert.equal(reply.environment.agentMode, BASE_CONFIG.agent.mode);
  });

  it('reports live mode as available only when it is both approved and has a model and an investigator', async () => {
    const live = createLiveInvestigator();
    const model = scriptedModel([]);
    const available = harness({
      config: { agent: { ...BASE_CONFIG.agent, liveApproved: true } },
      model,
      investigators: { demo: createDemoInvestigator(), live },
    });
    const reply = as<{ environment: { liveAvailable: boolean; liveBlockedReason: string | null } }>((await available.call('getSession')).json);
    assert.equal(reply.environment.liveAvailable, true);
    assert.equal(reply.environment.liveBlockedReason, null);

    const unapproved = harness({ model, investigators: { demo: createDemoInvestigator(), live } });
    const blocked = as<{ environment: { liveAvailable: boolean; liveBlockedReason: string | null } }>((await unapproved.call('getSession')).json);
    assert.equal(blocked.environment.liveAvailable, false);
    assert.equal(blocked.environment.liveBlockedReason, 'live_not_approved');
  });

  it('derives the live status from the approval flag and whether a model is configured', () => {
    assert.deepEqual(liveStatus({ ...BASE_CONFIG.agent, liveApproved: false }, true), { available: false, blockedReason: 'live_not_approved' });
    assert.deepEqual(liveStatus({ ...BASE_CONFIG.agent, liveApproved: false }, false), { available: false, blockedReason: 'live_not_approved' });
    assert.deepEqual(liveStatus({ ...BASE_CONFIG.agent, liveApproved: true }, false), { available: false, blockedReason: 'live_not_configured' });
    assert.deepEqual(liveStatus({ ...BASE_CONFIG.agent, liveApproved: true }, true), { available: true, blockedReason: null });
  });
});

describe('account and invoice reads', () => {
  it('returns an account of the caller tenant without any storage fields', async () => {
    const { call } = harness();
    const reply = await call('getAccount', { params: { accountId: 'acct_aurora_0001' } });
    assert.equal(reply.status, 200);
    const account = as<Record<string, unknown>>(reply.json);
    assert.deepEqual(Object.keys(account).sort(), ['accountId', 'currency', 'displayName', 'status', 'subscriptions']);
    assert.equal(account['accountId'], 'acct_aurora_0001');
    assert.equal(account['currency'], 'USD');
  });

  it('treats another tenant\'s account exactly like one that does not exist', async () => {
    const foreign = harness({ tenant: 'borealis' });
    const other = await foreign.call('getAccount', { params: { accountId: 'acct_aurora_0001' } });
    const missing = await harness().call('getAccount', { params: { accountId: 'acct_aurora_9999' } });
    assert.equal(other.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(as<{ code: string }>(other.json).code, 'not_found');
    assert.deepEqual(
      { ...as<Record<string, unknown>>(other.json), correlationId: undefined },
      { ...as<Record<string, unknown>>(missing.json), correlationId: undefined },
    );
    assert.deepEqual(foreign.reference.calls, [{ method: 'getAccount', tenantId: 'borealis' }]);
  });

  it('reads only the partition of the caller for every operation', async () => {
    const { call, reference } = harness({ tenant: 'borealis' });
    await call('getAccount', { params: { accountId: 'acct_borealis_0001' } });
    await call('listInvoices', listInvoicesOf('acct_borealis_0001'));
    await call('getInvoice', { params: { invoiceId: 'inv_borealis_0001_a' } });
    await call('listPolicies');
    await call('getPolicy', { params: { policyId: 'credit-policy', policyVersion: '1' } });
    assert.equal(reference.calls.length, 6);
    assert.ok(reference.calls.every((entry) => entry.tenantId === 'borealis'));
  });

  it('returns an invoice with its lines and payments but not its sort key', async () => {
    const { call } = harness();
    const reply = await call('getInvoice', { params: { invoiceId: 'inv_aurora_0001_a' } });
    assert.equal(reply.status, 200);
    const invoice = as<Record<string, unknown>>(reply.json);
    assert.deepEqual(Object.keys(invoice).sort(), [
      'accountId', 'invoiceId', 'issuedAt', 'lines', 'number', 'payments', 'periodEnd', 'periodStart', 'status', 'subscriptionId', 'total',
    ]);
    assert.equal(invoice['invoiceId'], 'inv_aurora_0001_a');
  });

  it('hides another tenant\'s invoice', async () => {
    const reply = await harness({ tenant: 'borealis' }).call('getInvoice', { params: { invoiceId: 'inv_aurora_0001_a' } });
    assert.equal(reply.status, 404);
  });

  it('has seed data that is large enough to need a second page', () => {
    assert.ok(BUSY_COUNT > HTTP_LIMITS.defaultPageSize, `the busiest account has ${String(BUSY_COUNT)} invoices`);
    assert.ok(BUSY_COUNT <= 2 * HTTP_LIMITS.maxPageSize);
  });

  it('lists invoices newest first and uses the default page size', async () => {
    const reply = await harness().call('listInvoices', listInvoicesOf(BUSY_ACCOUNT));
    assert.equal(reply.status, 200);
    const page = as<Page<InvoiceView>>(reply.json);
    assert.deepEqual(
      page.items.map((invoice) => invoice.invoiceId),
      BUSY_INVOICES_NEWEST_FIRST.slice(0, HTTP_LIMITS.defaultPageSize),
    );
    assert.equal(typeof page.continuationToken, 'string');
    assert.ok(page.items.every((invoice) => invoice.accountId === BUSY_ACCOUNT));
  });

  it('walks every invoice exactly once across pages and ends with a null token', async () => {
    const { call } = harness();
    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const reply = await call('listInvoices', listInvoicesOf(BUSY_ACCOUNT, { limit: '10', ...(token === null ? {} : { continuationToken: token }) }));
      assert.equal(reply.status, 200);
      const page = as<Page<InvoiceView>>(reply.json);
      assert.ok(page.items.length <= 10);
      seen.push(...page.items.map((invoice) => invoice.invoiceId));
      token = page.continuationToken;
      pages += 1;
      assert.ok(pages <= BUSY_COUNT, 'paging must terminate');
    } while (token !== null);
    assert.deepEqual(seen, BUSY_INVOICES_NEWEST_FIRST);
    assert.equal(pages, Math.ceil(BUSY_COUNT / 10));
  });

  it('gives a token only when more invoices remain, even at an exact page boundary', async () => {
    const { call } = harness();
    const exact = as<Page<InvoiceView>>((await call('listInvoices', listInvoicesOf(BUSY_ACCOUNT, { limit: String(BUSY_COUNT) }))).json);
    assert.equal(exact.items.length, BUSY_COUNT);
    assert.equal(exact.continuationToken, null);

    const short = as<Page<InvoiceView>>((await call('listInvoices', listInvoicesOf(BUSY_ACCOUNT, { limit: String(BUSY_COUNT - 1) }))).json);
    assert.equal(short.items.length, BUSY_COUNT - 1);
    assert.notEqual(short.continuationToken, null);
    const rest = as<Page<InvoiceView>>(
      (await call('listInvoices', listInvoicesOf(BUSY_ACCOUNT, { limit: String(BUSY_COUNT - 1), continuationToken: short.continuationToken ?? '' }))).json,
    );
    assert.deepEqual(rest.items.map((invoice) => invoice.invoiceId), BUSY_INVOICES_NEWEST_FIRST.slice(BUSY_COUNT - 1));
    assert.equal(rest.continuationToken, null);
  });

  it('refuses a page size above the maximum and a token that it did not issue', async () => {
    const { call } = harness();
    const tooBig = await call('listInvoices', listInvoicesOf(BUSY_ACCOUNT, { limit: String(HTTP_LIMITS.maxPageSize + 1) }));
    assert.equal(tooBig.status, 400);
    assert.equal(as<{ code: string }>(tooBig.json).code, 'validation_failed');

    for (const token of ['garbage', 'e30', 'AAAA']) {
      const reply = await call('listInvoices', listInvoicesOf(BUSY_ACCOUNT, { continuationToken: token }));
      assert.equal(reply.status, 400, token);
      assert.equal(as<{ code: string }>(reply.json).code, 'invalid_continuation_token', token);
    }
  });

  it('does not list invoices of an account that the caller cannot see', async () => {
    const foreign = harness({ tenant: 'borealis' });
    const other = await foreign.call('listInvoices', listInvoicesOf(BUSY_ACCOUNT));
    assert.equal(other.status, 404);
    assert.deepEqual(foreign.reference.calls, [{ method: 'getAccount', tenantId: 'borealis' }]);

    const missing = harness();
    assert.equal((await missing.call('listInvoices', listInvoicesOf('acct_aurora_9999'))).status, 404);
    assert.deepEqual(missing.reference.calls.map((entry) => entry.method), ['getAccount']);
  });

  it('returns an empty page for an account without invoices', async () => {
    const empty = AURORA.accounts.find((account) => !invoiceCounts.has(account.accountId));
    if (empty === undefined) return;
    const reply = await harness().call('listInvoices', listInvoicesOf(empty.accountId));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json, { items: [], continuationToken: null });
  });
});

describe('policy reads', () => {
  const versions = (reply: Reply): [string, number, string][] =>
    as<{ items: PolicyView[] }>(reply.json).items.map((policy) => [policy.policyId, policy.version, policy.status]);

  it('marks the newest visible version effective and the rest superseded, newest first', async () => {
    const reply = await harness().call('listPolicies');
    assert.equal(reply.status, 200);
    assert.deepEqual(versions(reply), [['credit-policy', 2, 'effective'], ['credit-policy', 1, 'superseded']]);
  });

  it('shows each tenant only its own policy versions', async () => {
    const reply = await harness({ tenant: 'borealis' }).call('listPolicies');
    assert.deepEqual(versions(reply), [['credit-policy', 1, 'effective']]);
  });

  it('hides a version until its effective date', async () => {
    const early = await harness({ now: new Date('2026-03-01T00:00:00.000Z') }).call('listPolicies');
    assert.deepEqual(versions(early), [['credit-policy', 1, 'effective']]);
    const before = await harness({ now: new Date('2025-12-31T23:59:59.000Z') }).call('listPolicies');
    assert.deepEqual(before.json, { items: [] });
  });

  it('returns one version with its clauses', async () => {
    const { call } = harness();
    const current = await call('getPolicy', { params: { policyId: 'credit-policy', policyVersion: '2' } });
    assert.equal(current.status, 200);
    assert.equal(as<PolicyView>(current.json).status, 'effective');
    assert.ok(as<PolicyView>(current.json).clauses.length > 0);
    const old = await call('getPolicy', { params: { policyId: 'credit-policy', policyVersion: '1' } });
    assert.equal(as<PolicyView>(old.json).status, 'superseded');
  });

  it('answers 404 for a version that does not exist for this tenant or is not yet effective', async () => {
    assert.equal((await harness().call('getPolicy', { params: { policyId: 'credit-policy', policyVersion: '3' } })).status, 404);
    assert.equal((await harness().call('getPolicy', { params: { policyId: 'other-policy', policyVersion: '1' } })).status, 404);
    assert.equal((await harness({ tenant: 'borealis' }).call('getPolicy', { params: { policyId: 'credit-policy', policyVersion: '2' } })).status, 404);
    const early = harness({ now: new Date('2026-03-01T00:00:00.000Z') });
    assert.equal((await early.call('getPolicy', { params: { policyId: 'credit-policy', policyVersion: '2' } })).status, 404);
  });

  it('refuses a version that is not an integer', async () => {
    const reply = await harness().call('getPolicy', { params: { policyId: 'credit-policy', policyVersion: 'latest' } });
    assert.equal(reply.status, 400);
    assert.equal(as<{ code: string }>(reply.json).code, 'validation_failed');
  });
});
