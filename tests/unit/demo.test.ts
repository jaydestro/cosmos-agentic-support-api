import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CaseFacts } from '../../src/agent/adjudicate.ts';
import { createDemoInvestigator } from '../../src/agent/demo.ts';
import type { Retrieved } from '../../src/agent/guard.ts';
import { RunStopped, type InvestigationSession } from '../../src/agent/investigator.ts';
import { createToolBox, type ToolCall } from '../../src/agent/tools.ts';
import type { CaseCategory, EvidenceAssessment, FindingCode, Money } from '../../src/cases/documents.ts';
import { SEED_TENANTS } from '../../tools/seed/data/index.ts';
import { createTestClock } from '../support/clock.ts';
import { createMemoryReference, type ReferenceCall } from '../support/memory-reference.ts';
import { SEEDED_FREE_TEXT, WHEN_V1, WHEN_V2, eur, invoicesOf, usd } from '../support/seed-evidence.ts';

const BEFORE_ANY_POLICY = new Date('2025-12-31T23:59:59.000Z');

interface Result {
  names: string[];
  calls: ToolCall[];
  /** The call whose proposal the guard accepted, if any. */
  accepted: ToolCall | null;
  retrieved: Retrieved;
  reads: ReferenceCall[];
}

/** Runs the demo investigator against the real tool box over the seeded evidence. */
async function investigate(tenantId: string, accountId: string, facts: CaseFacts, when: Date = WHEN_V2): Promise<Result> {
  const reference = createMemoryReference(SEED_TENANTS);
  const box = createToolBox({ reference: reference.store, clock: createTestClock(when) }, { tenantId, accountId, facts });
  const names: string[] = [];
  const calls: ToolCall[] = [];
  const session: InvestigationSession = {
    facts,
    call: async (name, args) => {
      names.push(name);
      const call = await box.call(name, args);
      calls.push(call);
      return call;
    },
    model: () => assert.fail('the demo plan uses no model'),
    retrieved: () => box.retrieved(),
  };
  await createDemoInvestigator().investigate(session);
  return { names, calls, accepted: calls.find((call) => call.submission !== null) ?? null, retrieved: box.retrieved(), reads: reference.calls };
}

type Expected =
  | { kind: 'credit'; amount: Money; clauseId: string; version: number }
  | { kind: 'finding'; findingCode: FindingCode; assessment: EvidenceAssessment };

interface Scenario {
  label: string;
  tenantId: string;
  accountId: string;
  facts: CaseFacts;
  names: string[];
  expected: Expected;
  when?: Date;
}

const facts = (category: CaseCategory, invoiceIds: string[], requestedCredit: Money | null): CaseFacts => ({
  category,
  invoiceIds,
  requestedCredit,
});

const CITED = ['get_account', 'get_policy', 'get_invoice', 'get_invoice', 'submit_proposal'];
const CITED_ONE = ['get_account', 'get_policy', 'get_invoice', 'submit_proposal'];

const SCENARIOS: Scenario[] = [
  {
    label: 'a collected duplicate pair is credited once',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0001',
    facts: facts('duplicate_charge', ['inv_aurora_0001_a', 'inv_aurora_0001_b'], usd(4900)),
    names: CITED,
    expected: { kind: 'credit', amount: usd(4900), clauseId: 'dup-charge', version: 2 },
  },
  {
    label: 'a duplicate with no cited invoice is found by listing the account',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0001',
    facts: facts('duplicate_charge', [], null),
    names: ['get_account', 'get_policy', 'list_invoices', 'submit_proposal'],
    expected: { kind: 'credit', amount: usd(4900), clauseId: 'dup-charge', version: 2 },
  },
  {
    label: 'a duplicate that cites one invoice lists the account to find its twin',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0001',
    facts: facts('duplicate_charge', ['inv_aurora_0001_b'], usd(4900)),
    names: ['get_account', 'get_policy', 'get_invoice', 'list_invoices', 'submit_proposal'],
    expected: { kind: 'credit', amount: usd(4900), clauseId: 'dup-charge', version: 2 },
  },
  {
    label: 'a request above the evidence is reduced to what the evidence supports',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0001',
    facts: facts('duplicate_charge', ['inv_aurora_0001_a', 'inv_aurora_0001_b'], usd(10000)),
    names: CITED,
    expected: { kind: 'credit', amount: usd(4900), clauseId: 'dup-charge', version: 2 },
  },
  {
    label: 'an outage is credited at the clause rate for one period',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0002',
    facts: facts('service_outage', ['inv_aurora_0002_a'], usd(1200)),
    names: CITED_ONE,
    expected: { kind: 'credit', amount: usd(1200), clauseId: 'outage-sla', version: 2 },
  },
  {
    label: 'an outage across two periods is credited for both',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0002',
    facts: facts('service_outage', ['inv_aurora_0002_a', 'inv_aurora_0002_b'], null),
    names: CITED,
    expected: { kind: 'credit', amount: usd(2400), clauseId: 'outage-sla', version: 2 },
  },
  {
    label: 'a cited invoice that does not exist is a missing-evidence finding, not a credit',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0003',
    facts: facts('service_outage', ['inv_aurora_0003_a', 'inv_aurora_0003_b'], usd(7900)),
    names: CITED,
    expected: { kind: 'finding', findingCode: 'missing_evidence', assessment: 'missing' },
  },
  {
    label: 'contradictory billing records are a finding, not a credit',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0004',
    facts: facts('duplicate_charge', ['inv_aurora_0004_a', 'inv_aurora_0004_b'], usd(4900)),
    names: CITED,
    expected: { kind: 'finding', findingCode: 'contradictory_evidence', assessment: 'contradictory' },
  },
  {
    label: 'a duplicate above the policy cap is capped under the current policy version',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0005',
    facts: facts('duplicate_charge', ['inv_aurora_0005_a', 'inv_aurora_0005_b'], usd(90000)),
    names: CITED,
    expected: { kind: 'credit', amount: usd(25000), clauseId: 'dup-charge', version: 2 },
  },
  {
    label: 'the same duplicate is capped lower under the policy version in force earlier',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0005',
    facts: facts('duplicate_charge', ['inv_aurora_0005_a', 'inv_aurora_0005_b'], usd(90000)),
    names: CITED,
    when: WHEN_V1,
    expected: { kind: 'credit', amount: usd(10000), clauseId: 'dup-charge', version: 1 },
  },
  {
    label: 'an instruction inside a retrieved invoice does not change the outcome',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0007',
    facts: facts('service_outage', ['inv_aurora_0007_a'], null),
    names: CITED_ONE,
    expected: { kind: 'credit', amount: usd(390), clauseId: 'outage-sla', version: 2 },
  },
  {
    label: 'a charge that matches the agreed amount is no credit due',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0007',
    facts: facts('incorrect_amount', ['inv_aurora_0007_a'], usd(5000)),
    names: CITED_ONE,
    expected: { kind: 'finding', findingCode: 'no_credit_due', assessment: 'consistent' },
  },
  {
    label: 'a category the policy never credits is no credit due when nothing is requested',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0006',
    facts: facts('other', [], null),
    names: ['get_account', 'get_policy', 'submit_proposal'],
    expected: { kind: 'finding', findingCode: 'no_credit_due', assessment: 'consistent' },
  },
  {
    label: 'a category the policy never credits is above the limit when a credit is requested',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0006',
    facts: facts('other', [], usd(1000)),
    names: ['get_account', 'get_policy', 'submit_proposal'],
    expected: { kind: 'finding', findingCode: 'exceeds_policy_limit', assessment: 'consistent' },
  },
  {
    label: 'a second tenant has its own duplicate in its own currency',
    tenantId: 'borealis',
    accountId: 'acct_borealis_0001',
    facts: facts('duplicate_charge', ['inv_borealis_0001_a', 'inv_borealis_0001_b'], eur(5900)),
    names: CITED,
    expected: { kind: 'credit', amount: eur(5900), clauseId: 'dup-charge', version: 1 },
  },
  {
    label: 'a second tenant has its own outage rate',
    tenantId: 'borealis',
    accountId: 'acct_borealis_0002',
    facts: facts('service_outage', ['inv_borealis_0002_a'], null),
    names: CITED_ONE,
    expected: { kind: 'credit', amount: eur(2100), clauseId: 'outage-sla', version: 1 },
  },
  {
    label: 'a void invoice with a successful payment is contradictory in the second tenant too',
    tenantId: 'borealis',
    accountId: 'acct_borealis_0004',
    facts: facts('incorrect_amount', ['inv_borealis_0004_a'], null),
    names: CITED_ONE,
    expected: { kind: 'finding', findingCode: 'contradictory_evidence', assessment: 'contradictory' },
  },
  {
    label: 'an invoice that belongs to the other tenant is missing, not retrievable',
    tenantId: 'aurora',
    accountId: 'acct_aurora_0001',
    facts: facts('duplicate_charge', ['inv_borealis_0001_a', 'inv_borealis_0001_b'], usd(5900)),
    names: CITED,
    expected: { kind: 'finding', findingCode: 'missing_evidence', assessment: 'missing' },
  },
];

function assertExpected(result: Result, expected: Expected): void {
  assert.ok(result.accepted, 'a proposal was accepted');
  const { submission } = result.accepted;
  assert.ok(submission);
  if (expected.kind === 'credit') {
    assert.equal(submission.kind, 'credit');
    assert.deepEqual(submission.amount, expected.amount);
    assert.equal(submission.findingCode, null);
    assert.equal(submission.evidenceAssessment, 'consistent');
    assert.equal(submission.policyRef?.clauseId, expected.clauseId);
    assert.equal(submission.policyRef?.version, expected.version);
    assert.ok(submission.invoiceRefs.length > 0, 'a credit cites the invoices it rests on');
  } else {
    assert.equal(submission.kind, 'finding');
    assert.equal(submission.amount, null);
    assert.equal(submission.findingCode, expected.findingCode);
    assert.equal(submission.evidenceAssessment, expected.assessment);
  }
}

describe('the demo investigator', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.label, async () => {
      const result = await investigate(scenario.tenantId, scenario.accountId, scenario.facts, scenario.when);
      assert.deepEqual(result.names, scenario.names);
      assertExpected(result, scenario.expected);
      assert.ok(
        result.calls.every((call) => call.outcome === 'succeeded'),
        'no call was refused by code',
      );
      assert.equal(result.calls.at(-1)?.submission, result.accepted?.submission, 'the proposal is the last call');
    });
  }

  it('retrieves only inside the tenant of the case', async () => {
    for (const scenario of SCENARIOS) {
      const result = await investigate(scenario.tenantId, scenario.accountId, scenario.facts, scenario.when);
      assert.ok(result.reads.length > 0);
      assert.ok(
        result.reads.every((read) => read.tenantId === scenario.tenantId),
        scenario.label,
      );
    }
  });

  it('never carries retrieved free text into the proposal', async () => {
    const result = await investigate('aurora', 'acct_aurora_0007', facts('service_outage', ['inv_aurora_0007_a'], null));
    const text = JSON.stringify(result.accepted?.submission);
    for (const phrase of SEEDED_FREE_TEXT) assert.ok(!text.includes(phrase), `the proposal repeats: ${phrase}`);
    assert.ok(!/ignore|SYSTEM NOTICE|approve/i.test(text));
  });

  it('is deterministic: the same case yields the same calls and the same proposal', async () => {
    const duplicate = facts('duplicate_charge', ['inv_aurora_0001_a', 'inv_aurora_0001_b'], usd(4900));
    const first = await investigate('aurora', 'acct_aurora_0001', duplicate);
    const second = await investigate('aurora', 'acct_aurora_0001', duplicate);
    assert.deepEqual(second.names, first.names);
    assert.equal(JSON.stringify(second.accepted?.submission), JSON.stringify(first.accepted?.submission));
  });

  describe('when there is nothing to decide', () => {
    it('submits nothing for an account that does not exist', async () => {
      const result = await investigate('aurora', 'acct_aurora_9999', facts('duplicate_charge', [], null));
      assert.deepEqual(result.names, ['get_account', 'get_policy']);
      assert.equal(result.accepted, null);
      assert.equal(result.retrieved.account.status, 'absent');
    });

    it("treats another tenant's account exactly like an absent one", async () => {
      const foreign = await investigate('borealis', 'acct_aurora_0001', facts('duplicate_charge', [], null));
      const absent = await investigate('borealis', 'acct_borealis_9999', facts('duplicate_charge', [], null));
      assert.deepEqual(foreign.names, ['get_account', 'get_policy']);
      assert.equal(foreign.accepted, null);
      assert.deepEqual(foreign.retrieved.account, absent.retrieved.account);
    });

    it('submits nothing while no policy version is in force', async () => {
      const result = await investigate('aurora', 'acct_aurora_0001', facts('duplicate_charge', [], null), BEFORE_ANY_POLICY);
      assert.deepEqual(result.names, ['get_account', 'get_policy']);
      assert.equal(result.accepted, null);
      assert.equal(result.retrieved.account.status, 'present');
      assert.equal(result.retrieved.policy.status, 'absent');
    });
  });

  it('lets a stop pass through and makes no further call', async () => {
    const stop = new RunStopped('budget_exhausted', 'steps_exhausted');
    const names: string[] = [];
    const answered: ToolCall = { tool: 'get_account', outcome: 'succeeded', errorCode: null, result: { ok: true, data: {} }, submission: null };
    const session: InvestigationSession = {
      facts: facts('duplicate_charge', [], null),
      call: (name) => {
        names.push(name);
        return names.length < 2 ? Promise.resolve(answered) : Promise.reject(stop);
      },
      model: () => assert.fail('the demo plan uses no model'),
      retrieved: () => assert.fail('the plan must not go on after a stop'),
    };
    await assert.rejects(createDemoInvestigator().investigate(session), (error: unknown) => error === stop);
    assert.deepEqual(names, ['get_account', 'get_policy']);
  });

  it('is a demo investigator', () => {
    assert.equal(createDemoInvestigator().mode, 'demo');
  });

  describe('RunStopped', () => {
    it('carries what the runner records', () => {
      const stop = new RunStopped('failed', 'tool_error');
      assert.ok(stop instanceof Error);
      assert.equal(stop.name, 'RunStopped');
      assert.equal(stop.kind, 'failed');
      assert.equal(stop.reason, 'tool_error');
    });
  });

  describe('over every seeded account', () => {
    const CATEGORIES: CaseCategory[] = ['duplicate_charge', 'incorrect_amount', 'service_outage', 'other'];
    const OTHER_CURRENCY = { USD: 'EUR', EUR: 'USD' } as const;

    it('always gets a proposal accepted and never trips the guard', async () => {
      let runs = 0;
      for (const tenant of SEED_TENANTS) {
        const foreign = SEED_TENANTS.find((other) => other.tenantId !== tenant.tenantId)?.invoices[0]?.invoiceId ?? 'inv_nowhere_0001';
        for (const account of tenant.accounts) {
          const own = invoicesOf(tenant.tenantId, account.accountId).map((invoice) => invoice.invoiceId);
          const citations: string[][] = [[], own.slice(0, 1), own.slice(0, 2), own.slice(0, 5), ['inv_nowhere_0001'], [foreign]];
          const requests: (Money | null)[] = [
            null,
            { amountMinor: 0, currency: account.currency },
            { amountMinor: 1, currency: account.currency },
            { amountMinor: 100_000, currency: account.currency },
            { amountMinor: 500, currency: OTHER_CURRENCY[account.currency] },
          ];
          for (const category of CATEGORIES) {
            for (const invoiceIds of citations) {
              for (const requestedCredit of requests) {
                for (const when of [WHEN_V1, WHEN_V2]) {
                  const label = `${account.accountId} ${category} [${invoiceIds.join(',')}] ${JSON.stringify(requestedCredit)} ${when.toISOString()}`;
                  const result = await investigate(tenant.tenantId, account.accountId, { category, invoiceIds, requestedCredit }, when);
                  assert.ok(result.accepted, label);
                  assert.ok(
                    result.calls.every((call) => call.outcome === 'succeeded'),
                    `${label}: a call was refused`,
                  );
                  assert.equal(result.calls.filter((call) => call.tool === 'submit_proposal').length, 1, label);
                  assert.equal(result.calls.at(-1)?.tool, 'submit_proposal', label);
                  assert.ok(result.names.length <= 8, `${label}: ${String(result.names.length)} calls`);
                  assert.ok(result.reads.every((read) => read.tenantId === tenant.tenantId), label);

                  const submission = result.accepted.submission;
                  assert.ok(submission, label);
                  if (submission.kind === 'credit') {
                    assert.ok(submission.amount !== null && submission.amount.amountMinor > 0, label);
                    assert.equal(submission.amount.currency, account.currency, label);
                    if (requestedCredit !== null) assert.ok(submission.amount.amountMinor <= requestedCredit.amountMinor, label);
                    assert.equal(submission.evidenceAssessment, 'consistent', label);
                  } else {
                    assert.equal(submission.amount, null, label);
                  }
                  runs += 1;
                }
              }
            }
          }
        }
      }
      assert.ok(runs > 1000, `only ${String(runs)} runs`);
    });
  });
});
