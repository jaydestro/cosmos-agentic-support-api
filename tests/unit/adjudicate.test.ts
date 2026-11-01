import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_INVOICE_REFS,
  adjudicate,
  type Adjudication,
  type CreditAdjudication,
  type Evidence,
  type FindingAdjudication,
} from '../../src/agent/adjudicate.ts';
import type { CaseCategory, Money } from '../../src/cases/documents.ts';
import { buildPolicyDoc, type Invoice, type Policy } from '../../src/data/documents.ts';
import { effectivePolicy } from '../../src/domain/policy.ts';
import { SEED_TENANTS, type TenantSeed } from '../../tools/seed/data/index.ts';
import { monthlyInvoice, type MonthlyInvoiceInput } from '../../tools/seed/data/helpers.ts';

/** Policy v1 is the only visible aurora version at this time; v2 takes effect on 2026-06-01. */
const WHEN_V1 = new Date('2026-03-01T10:00:00.000Z');
const WHEN_V2 = new Date('2026-10-01T00:00:00.000Z');

const usd = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });
const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

function tenantSeed(tenantId: string): TenantSeed {
  const seed = SEED_TENANTS.find((candidate) => candidate.tenantId === tenantId);
  assert.ok(seed, `unknown seed tenant ${tenantId}`);
  return seed;
}

function seededInvoice(tenantId: string, invoiceId: string): Invoice {
  const invoice = tenantSeed(tenantId).invoices.find((candidate) => candidate.invoiceId === invoiceId);
  assert.ok(invoice, `unknown seed invoice ${invoiceId}`);
  return invoice;
}

function evidenceFor(tenantId: string, accountId: string, when: Date = WHEN_V2, retrieved?: readonly string[]): Evidence {
  const seed = tenantSeed(tenantId);
  const account = seed.accounts.find((candidate) => candidate.accountId === accountId);
  assert.ok(account, `unknown seed account ${accountId}`);
  const policy = effectivePolicy(
    seed.policies.map((candidate) => buildPolicyDoc(tenantId, candidate)),
    when,
  );
  assert.ok(policy, 'no effective policy');
  return {
    account,
    policy,
    invoices: seed.invoices.filter(
      (invoice) => invoice.accountId === accountId && (retrieved === undefined || retrieved.includes(invoice.invoiceId)),
    ),
  };
}

function withClause(policy: Policy, clauseId: string, patch: Partial<Policy['clauses'][number]>): Policy {
  return { ...policy, clauses: policy.clauses.map((clause) => (clause.clauseId === clauseId ? { ...clause, ...patch } : clause)) };
}

function withInvoices(evidence: Evidence, ...invoices: Invoice[]): Evidence {
  return { ...evidence, invoices: [...evidence.invoices, ...invoices] };
}

function synthetic(overrides: Partial<MonthlyInvoiceInput> & Pick<MonthlyInvoiceInput, 'invoiceId'>): Invoice {
  return monthlyInvoice({
    accountId: 'acct_aurora_0001',
    subscriptionId: 'sub_aurora_0001',
    number: `SYN-${overrides.invoiceId}`,
    billingMonth: { year: 2026, month: 9 },
    plan: 'Team',
    amountMinor: 4900,
    currency: 'USD',
    ...overrides,
  });
}

/** Text a hostile record could carry; none of it may ever reach a derived sentence. */
const FREE_TEXT = [
  ...SEED_TENANTS.flatMap((seed) => seed.invoices.flatMap((invoice) => invoice.lines.map((line) => line.description))),
  ...SEED_TENANTS.flatMap((seed) => seed.policies.flatMap((policy) => policy.clauses.map((clause) => clause.text))),
];

function checkInvariants(result: Adjudication): void {
  const ids = result.invoiceRefs.map((ref) => ref.invoiceId);
  assert.ok(result.invoiceRefs.length <= MAX_INVOICE_REFS, 'too many invoice references');
  assert.equal(new Set(ids).size, ids.length, 'duplicate invoice references');
  assert.ok(result.invoiceRefs.every((ref) => ref.lineIndex === null));
  assert.ok(result.facts.length > 0, 'no facts');
  for (const fact of result.facts) {
    for (const text of FREE_TEXT) assert.ok(!fact.includes(text), `fact leaks free text: ${fact}`);
  }
  if (result.kind === 'credit') {
    assert.equal(result.assessment, 'consistent');
    assert.ok(result.maxCreditMinor > 0);
    assert.ok(result.maxCreditMinor <= result.capMinor, 'above the policy cap');
    assert.ok(result.maxCreditMinor <= result.eligibleMinor, 'above the evidence');
    if (result.requestedMinor !== null) assert.ok(result.maxCreditMinor <= result.requestedMinor, 'above the request');
    assert.ok(result.creditedInvoiceIds.length > 0 && result.creditedInvoiceIds.length <= MAX_INVOICE_REFS);
    for (const id of result.creditedInvoiceIds) assert.ok(ids.includes(id), `${id} is credited but not cited`);
  } else {
    const expected =
      result.findingCode === 'contradictory_evidence' ? 'contradictory' : result.findingCode === 'missing_evidence' ? 'missing' : 'consistent';
    assert.equal(result.assessment, expected);
  }
}

function run(category: CaseCategory, invoiceIds: readonly string[], evidence: Evidence, requestedCredit: Money | null = null): Adjudication {
  const result = adjudicate({ category, invoiceIds, requestedCredit }, evidence);
  checkInvariants(result);
  return result;
}

function creditOf(result: Adjudication): CreditAdjudication {
  assert.ok(result.kind === 'credit', `expected a credit, got ${JSON.stringify(result)}`);
  return result;
}

function findingOf(result: Adjudication, code?: FindingAdjudication['findingCode']): FindingAdjudication {
  assert.ok(result.kind === 'finding', `expected a finding, got ${JSON.stringify(result)}`);
  if (code !== undefined) assert.equal(result.findingCode, code, JSON.stringify(result));
  return result;
}

const refIds = (result: Adjudication): string[] => result.invoiceRefs.map((ref) => ref.invoiceId);
const mentions = (result: Adjudication, text: string): boolean => result.facts.some((fact) => fact.includes(text));

const A1 = 'acct_aurora_0001';
const DUP_A = 'inv_aurora_0001_a';
const DUP_B = 'inv_aurora_0001_b';

describe('adjudication: duplicate charge', () => {
  it('credits the later-issued duplicate once, in whatever order the invoices are cited', () => {
    const evidence = evidenceFor('aurora', A1);
    const forward = creditOf(run('duplicate_charge', [DUP_A, DUP_B], evidence, usd(4900)));
    assert.deepEqual(forward.policyRef, { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' });
    assert.deepEqual(forward.creditedInvoiceIds, [DUP_B]);
    assert.equal(forward.currency, 'USD');
    assert.equal(forward.eligibleMinor, 4900);
    assert.equal(forward.capMinor, 25000);
    assert.equal(forward.requestedMinor, 4900);
    assert.equal(forward.maxCreditMinor, 4900);
    assert.deepEqual(forward.invoiceRefs, [
      { invoiceId: DUP_A, lineIndex: null },
      { invoiceId: DUP_B, lineIndex: null },
    ]);
    assert.ok(mentions(forward, `${DUP_A} was issued first`));
    assert.deepEqual(run('duplicate_charge', [DUP_B, DUP_A], evidence, usd(4900)), forward);
  });

  it('finds the duplicate from retrieved invoices alone when only one is cited', () => {
    const result = creditOf(run('duplicate_charge', [DUP_A], evidenceFor('aurora', A1)));
    assert.deepEqual(result.creditedInvoiceIds, [DUP_B]);
    assert.equal(result.requestedMinor, null);
    assert.equal(result.maxCreditMinor, 4900);
  });

  it('cites the policy version that was retrieved and applies that version’s cap', () => {
    const v1 = creditOf(run('duplicate_charge', [DUP_A, DUP_B], evidenceFor('aurora', A1, WHEN_V1)));
    assert.deepEqual(v1.policyRef, { policyId: 'credit-policy', version: 1, clauseId: 'dup-charge' });
    assert.equal(v1.capMinor, 10000);
    assert.equal(v1.maxCreditMinor, 4900);
  });

  it('never exceeds the request, and says so when it reduces one', () => {
    const evidence = evidenceFor('aurora', A1);
    const lower = creditOf(run('duplicate_charge', [DUP_A, DUP_B], evidence, usd(2000)));
    assert.equal(lower.maxCreditMinor, 2000);
    assert.ok(!mentions(lower, 'reduced'));
    const higher = creditOf(run('duplicate_charge', [DUP_A, DUP_B], evidence, usd(9900)));
    assert.equal(higher.requestedMinor, 9900);
    assert.equal(higher.maxCreditMinor, 4900);
    assert.ok(mentions(higher, 'reduced'));
  });

  it('reduces a duplicate that exceeds the policy cap to the cap, as a credit and not a finding', () => {
    const evidence = (when: Date) => evidenceFor('aurora', 'acct_aurora_0005', when);
    const ids = ['inv_aurora_0005_a', 'inv_aurora_0005_b'];
    const v2 = creditOf(run('duplicate_charge', ids, evidence(WHEN_V2), usd(90000)));
    assert.equal(v2.eligibleMinor, 90000);
    assert.equal(v2.capMinor, 25000);
    assert.equal(v2.maxCreditMinor, 25000);
    assert.deepEqual(v2.creditedInvoiceIds, ['inv_aurora_0005_b']);
    assert.equal(creditOf(run('duplicate_charge', ids, evidence(WHEN_V1), usd(90000))).maxCreditMinor, 10000);
  });

  it('credits every duplicate in a group of three and in separate periods', () => {
    const evidence = evidenceFor('aurora', A1, WHEN_V2, []);
    const triple = withInvoices(
      evidence,
      synthetic({ invoiceId: 'inv_syn_t_a' }),
      synthetic({ invoiceId: 'inv_syn_t_b', issuedAt: '2026-09-01T06:00:05Z' }),
      synthetic({ invoiceId: 'inv_syn_t_c', issuedAt: '2026-09-01T06:00:09Z' }),
    );
    const three = creditOf(run('duplicate_charge', [], triple));
    assert.deepEqual(three.creditedInvoiceIds, ['inv_syn_t_b', 'inv_syn_t_c']);
    assert.equal(three.eligibleMinor, 9800);
    assert.equal(creditOf(run('duplicate_charge', [], triple, usd(4900))).maxCreditMinor, 4900);

    const twoPeriods = withInvoices(
      evidence,
      synthetic({ invoiceId: 'inv_syn_p_a', billingMonth: { year: 2026, month: 8 } }),
      synthetic({ invoiceId: 'inv_syn_p_b', billingMonth: { year: 2026, month: 8 }, issuedAt: '2026-08-01T06:00:05Z' }),
      synthetic({ invoiceId: 'inv_syn_q_a' }),
      synthetic({ invoiceId: 'inv_syn_q_b', issuedAt: '2026-09-01T06:00:05Z' }),
    );
    const both = creditOf(run('duplicate_charge', [], twoPeriods));
    assert.deepEqual(both.creditedInvoiceIds, ['inv_syn_p_b', 'inv_syn_q_b']);
    assert.equal(both.eligibleMinor, 9800);
  });

  it('does not treat unpaid, differently priced or other-period invoices as duplicates', () => {
    const base = evidenceFor('aurora', A1, WHEN_V2, []);
    const original = synthetic({ invoiceId: 'inv_syn_o_a' });
    for (const [label, other] of [
      ['an open invoice', synthetic({ invoiceId: 'inv_syn_o_b', status: 'open', payments: [] })],
      ['a void invoice', synthetic({ invoiceId: 'inv_syn_o_b', status: 'void', payments: [] })],
      ['a different amount', synthetic({ invoiceId: 'inv_syn_o_b', amountMinor: 5900 })],
      ['another period', synthetic({ invoiceId: 'inv_syn_o_b', billingMonth: { year: 2026, month: 8 } })],
    ] as const) {
      const result = findingOf(run('duplicate_charge', ['inv_syn_o_a', 'inv_syn_o_b'], withInvoices(base, original, other)), 'no_credit_due');
      assert.equal(result.assessment, 'consistent', label);
    }
  });

  it('asks for evidence when fewer than two invoices were retrieved for the period', () => {
    const result = findingOf(run('duplicate_charge', [DUP_A], evidenceFor('aurora', A1, WHEN_V2, [DUP_A])), 'missing_evidence');
    assert.ok(mentions(result, 'at least two invoices'));
    assert.deepEqual(refIds(result), [DUP_A]);
  });

  it('reports no credit due for two invoices of different periods', () => {
    const retrieved = [DUP_A, 'inv_aurora_0001_c'];
    const result = findingOf(run('duplicate_charge', retrieved, evidenceFor('aurora', A1, WHEN_V2, retrieved)), 'no_credit_due');
    assert.equal(result.assessment, 'consistent');
  });

  it('still finds a duplicate in the retrieved evidence that the representative did not cite', () => {
    const result = creditOf(run('duplicate_charge', [DUP_A, 'inv_aurora_0001_c'], evidenceFor('aurora', A1)));
    assert.deepEqual(result.creditedInvoiceIds, [DUP_B]);
    assert.deepEqual(refIds(result), [DUP_A, DUP_B]);
  });
});

describe('adjudication: service outage and the structured clause rate', () => {
  const OUTAGE = 'inv_aurora_0002_a';

  it('credits the clause rate of the period charge, not the whole charge', () => {
    const result = creditOf(run('service_outage', [OUTAGE], evidenceFor('aurora', 'acct_aurora_0002'), usd(12000)));
    assert.deepEqual(result.policyRef, { policyId: 'credit-policy', version: 2, clauseId: 'outage-sla' });
    assert.equal(result.eligibleMinor, 1200);
    assert.equal(result.maxCreditMinor, 1200);
    assert.equal(result.capMinor, 20000);
    assert.deepEqual(result.creditedInvoiceIds, [OUTAGE]);
    assert.ok(mentions(result, '10% of USD 120.00'));
    assert.equal(creditOf(run('service_outage', [OUTAGE], evidenceFor('aurora', 'acct_aurora_0002', WHEN_V1))).capMinor, 10000);
  });

  it('sums one original charge per period and ignores duplicate charges in the same period', () => {
    const evidence = evidenceFor('aurora', 'acct_aurora_0002');
    const both = creditOf(run('service_outage', [OUTAGE, 'inv_aurora_0002_b'], evidence));
    assert.equal(both.eligibleMinor, 2400);
    assert.deepEqual(both.creditedInvoiceIds, ['inv_aurora_0002_b', OUTAGE]);

    const withTwin = withInvoices(evidence, synthetic({ invoiceId: 'inv_syn_twin', accountId: 'acct_aurora_0002', subscriptionId: 'sub_aurora_0002', amountMinor: 12000, issuedAt: '2026-09-01T06:00:09Z' }));
    const single = creditOf(run('service_outage', [OUTAGE, 'inv_syn_twin'], withTwin));
    assert.equal(single.eligibleMinor, 1200);
    assert.deepEqual(single.creditedInvoiceIds, [OUTAGE]);
  });

  it('rounds down to a whole minor unit', () => {
    const odd = synthetic({ invoiceId: 'inv_syn_odd', accountId: 'acct_aurora_0002', subscriptionId: 'sub_aurora_0002', amountMinor: 12345 });
    const evidence = withInvoices(evidenceFor('aurora', 'acct_aurora_0002', WHEN_V2, []), odd);
    assert.equal(creditOf(run('service_outage', ['inv_syn_odd'], evidence)).eligibleMinor, 1234);
  });

  it('treats a clause without a rate as the full amount, and applies a rate to any clause', () => {
    const base = evidenceFor('aurora', 'acct_aurora_0002');
    const noRate = { ...base, policy: withClause(base.policy, 'outage-sla', { creditRateBasisPoints: undefined }) };
    assert.equal(creditOf(run('service_outage', [OUTAGE], noRate)).eligibleMinor, 12000);

    const dup = evidenceFor('aurora', A1);
    const half = { ...dup, policy: withClause(dup.policy, 'dup-charge', { creditRateBasisPoints: 5000 }) };
    assert.equal(creditOf(run('duplicate_charge', [DUP_A, DUP_B], half)).eligibleMinor, 2450);
  });

  it('uses the Borealis rate and currency', () => {
    const result = creditOf(run('service_outage', ['inv_borealis_0002_a'], evidenceFor('borealis', 'acct_borealis_0002')));
    assert.equal(result.currency, 'EUR');
    assert.equal(result.eligibleMinor, 2100);
    assert.equal(result.capMinor, 15000);
    assert.ok(mentions(result, '15% of EUR 140.00'));
  });

  it('keeps hostile invoice text inert: the credit follows the policy, not the record', () => {
    const evidence = evidenceFor('aurora', 'acct_aurora_0007');
    const outage = creditOf(run('service_outage', ['inv_aurora_0007_a'], evidence, usd(500000)));
    assert.equal(outage.eligibleMinor, 390);
    assert.equal(outage.maxCreditMinor, 390);
    assert.equal(findingOf(run('incorrect_amount', ['inv_aurora_0007_a'], evidence), 'no_credit_due').assessment, 'consistent');
    findingOf(run('other', ['inv_aurora_0007_a'], evidence, usd(500000)), 'exceeds_policy_limit');
  });
});

describe('adjudication: incorrect amount', () => {
  const agreed = evidenceFor('aurora', A1, WHEN_V2, []);

  it('credits the overcharge against the agreed monthly amount, up to the cap', () => {
    const evidence = withInvoices(agreed, synthetic({ invoiceId: 'inv_syn_over', amountMinor: 6900 }));
    const result = creditOf(run('incorrect_amount', ['inv_syn_over'], evidence, usd(6900)));
    assert.equal(result.eligibleMinor, 2000);
    assert.equal(result.maxCreditMinor, 2000);
    assert.deepEqual(result.creditedInvoiceIds, ['inv_syn_over']);

    const huge = withInvoices(agreed, synthetic({ invoiceId: 'inv_syn_huge', amountMinor: 30000 }));
    assert.equal(creditOf(run('incorrect_amount', ['inv_syn_huge'], huge)).maxCreditMinor, 15000);
    assert.equal(creditOf(run('incorrect_amount', ['inv_syn_huge'], { ...huge, policy: evidenceFor('aurora', A1, WHEN_V1).policy })).maxCreditMinor, 10000);
  });

  it('adds up the overcharge of several invoices and ignores those billed correctly', () => {
    const evidence = withInvoices(
      agreed,
      synthetic({ invoiceId: 'inv_syn_m1', amountMinor: 5900, billingMonth: { year: 2026, month: 7 } }),
      synthetic({ invoiceId: 'inv_syn_m2', amountMinor: 6400, billingMonth: { year: 2026, month: 8 } }),
      synthetic({ invoiceId: 'inv_syn_m3', amountMinor: 4900 }),
    );
    const result = creditOf(run('incorrect_amount', ['inv_syn_m1', 'inv_syn_m2', 'inv_syn_m3'], evidence));
    assert.equal(result.eligibleMinor, 2500);
    assert.deepEqual(result.creditedInvoiceIds, ['inv_syn_m1', 'inv_syn_m2']);
    assert.ok(mentions(result, 'inv_syn_m3 was collected for USD 49.00 against an agreed USD 49.00'));
  });

  it('reports no credit due when the charge matches the agreed amount', () => {
    const result = findingOf(run('incorrect_amount', [DUP_A], evidenceFor('aurora', A1)), 'no_credit_due');
    assert.deepEqual(refIds(result), [DUP_A]);
    assert.ok(mentions(result, `${DUP_A} was collected for USD 49.00 against an agreed USD 49.00`));
  });

  it('asks for evidence when the agreed amount is not on record', () => {
    const evidence = withInvoices(agreed, synthetic({ invoiceId: 'inv_syn_orphan', subscriptionId: 'sub_unknown_0001' }));
    const result = findingOf(run('incorrect_amount', ['inv_syn_orphan'], evidence), 'missing_evidence');
    assert.ok(mentions(result, 'agreed monthly amount for sub_unknown_0001 is not on record'));
  });

  it('asks for evidence when no invoice is cited', () => {
    findingOf(run('incorrect_amount', [], evidenceFor('aurora', A1)), 'missing_evidence');
    findingOf(run('service_outage', [], evidenceFor('aurora', A1)), 'missing_evidence');
  });
});

describe('adjudication: other disputes', () => {
  it('never credits automatically; a requested credit exceeds the policy limit', () => {
    const evidence = evidenceFor('aurora', A1);
    const asked = findingOf(run('other', [], evidence, usd(1000)), 'exceeds_policy_limit');
    assert.deepEqual(asked.policyRef, { policyId: 'credit-policy', version: 2, clauseId: 'other-disputes' });
    assert.ok(mentions(asked, 'Policy limit: USD 0.00'));
    findingOf(run('other', [], evidence), 'no_credit_due');
    findingOf(run('other', [], evidence, usd(0)), 'no_credit_due');
  });

  it('reports a policy that has no clause for the category without inventing one', () => {
    const base = evidenceFor('aurora', 'acct_aurora_0002');
    const noOutage = { ...base, policy: { ...base.policy, clauses: base.policy.clauses.filter((clause) => clause.appliesTo !== 'service_outage') } };
    const result = findingOf(run('service_outage', ['inv_aurora_0002_a'], noOutage), 'no_credit_due');
    assert.equal(result.policyRef, null);
  });

  it('reports no credit due for a zero request', () => {
    findingOf(run('duplicate_charge', [DUP_A, DUP_B], evidenceFor('aurora', A1), usd(0)), 'no_credit_due');
  });
});

describe('adjudication: missing evidence', () => {
  it('reports a cited invoice that does not exist, with no credit', () => {
    const evidence = evidenceFor('aurora', 'acct_aurora_0003');
    const missing = findingOf(run('service_outage', ['inv_aurora_0003_b'], evidence), 'missing_evidence');
    assert.equal(missing.assessment, 'missing');
    assert.ok(mentions(missing, 'Cited invoice inv_aurora_0003_b could not be found for this account.'));
    assert.deepEqual(missing.invoiceRefs, []);
    assert.deepEqual(refIds(findingOf(run('duplicate_charge', ['inv_aurora_0003_a', 'inv_aurora_0003_b'], evidence), 'missing_evidence')), ['inv_aurora_0003_a']);
  });

  it('treats an invoice that belongs to another account as not found', () => {
    const foreign = seededInvoice('aurora', 'inv_aurora_0002_a');
    const evidence = withInvoices(evidenceFor('aurora', A1), foreign);
    const result = findingOf(run('service_outage', [foreign.invoiceId], evidence), 'missing_evidence');
    assert.ok(mentions(result, 'inv_aurora_0002_a could not be found'));
    const duplicateEvidence = withInvoices(evidence, { ...foreign, invoiceId: 'inv_syn_foreign', issuedAt: '2026-09-01T06:00:09Z' });
    assert.deepEqual(creditOf(run('duplicate_charge', [DUP_A, DUP_B], duplicateEvidence)).creditedInvoiceIds, [DUP_B]);
  });

  it('counts a retrieved invoice once however often it was retrieved', () => {
    const evidence = evidenceFor('aurora', A1);
    const repeated = { ...evidence, invoices: [...evidence.invoices, ...evidence.invoices] };
    assert.deepEqual(run('duplicate_charge', [DUP_A, DUP_B], repeated), run('duplicate_charge', [DUP_A, DUP_B], evidence));
  });
});

describe('adjudication: contradictory evidence', () => {
  it('reports the records that disagree instead of inventing a credit', () => {
    const result = findingOf(run('duplicate_charge', ['inv_aurora_0004_a', 'inv_aurora_0004_b'], evidenceFor('aurora', 'acct_aurora_0004'), usd(4900)), 'contradictory_evidence');
    assert.equal(result.assessment, 'contradictory');
    assert.deepEqual(refIds(result), ['inv_aurora_0004_a', 'inv_aurora_0004_b']);
    assert.deepEqual(result.policyRef, { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' });
    assert.ok(mentions(result, 'inv_aurora_0004_a is void but has a successful payment.'));
    assert.ok(mentions(result, 'inv_aurora_0004_b is marked paid but its successful payments do not equal its total.'));
  });

  it('prefers the contradiction over a missing invoice', () => {
    const result = findingOf(run('service_outage', ['inv_aurora_0004_a', 'inv_aurora_0004_z'], evidenceFor('aurora', 'acct_aurora_0004')), 'contradictory_evidence');
    assert.deepEqual(refIds(result), ['inv_aurora_0004_a']);
  });

  it('applies to the Borealis seed too', () => {
    const result = findingOf(run('service_outage', ['inv_borealis_0004_a'], evidenceFor('borealis', 'acct_borealis_0004')), 'contradictory_evidence');
    assert.ok(mentions(result, 'inv_borealis_0004_a is void but has a successful payment.'));
  });

  it('flags only genuine contradictions across every seeded invoice', () => {
    const contradictory = new Set(['inv_aurora_0004_a', 'inv_aurora_0004_b', 'inv_borealis_0004_a']);
    const wrong: string[] = [];
    for (const seed of SEED_TENANTS) {
      for (const invoice of seed.invoices) {
        const result = adjudicate(
          { category: 'service_outage', invoiceIds: [invoice.invoiceId], requestedCredit: null },
          evidenceFor(seed.tenantId, invoice.accountId, WHEN_V2, [invoice.invoiceId]),
        );
        const flagged = result.kind === 'finding' && result.findingCode === 'contradictory_evidence';
        if (flagged !== contradictory.has(invoice.invoiceId)) wrong.push(invoice.invoiceId);
      }
    }
    assert.deepEqual(wrong, []);
  });

  it('flags each kind of disagreement', () => {
    const base = evidenceFor('aurora', A1, WHEN_V2, []);
    const cases: [string, Invoice][] = [
      [
        'is open but has a successful payment',
        synthetic({ invoiceId: 'inv_syn_c1', status: 'open', payments: [{ paymentId: 'pay_syn_c1', amount: usd(4900), status: 'succeeded' }] }),
      ],
      ['is not in the account currency', synthetic({ invoiceId: 'inv_syn_c2', currency: 'EUR' })],
      [
        'has line items that do not add up to its total',
        { ...synthetic({ invoiceId: 'inv_syn_c3' }), lines: [{ description: 'Team plan', amount: usd(4000) }] },
      ],
      [
        'is marked paid but its successful payments do not equal its total',
        synthetic({ invoiceId: 'inv_syn_c4', payments: [{ paymentId: 'pay_syn_c4', amount: usd(2000), status: 'succeeded' }] }),
      ],
    ];
    for (const [text, invoice] of cases) {
      const result = findingOf(run('service_outage', [invoice.invoiceId], withInvoices(base, invoice)), 'contradictory_evidence');
      assert.ok(mentions(result, `${invoice.invoiceId} ${text}.`), text);
    }
  });

  it('does not flag a refunded or an open invoice that holds no payment', () => {
    const base = evidenceFor('aurora', A1, WHEN_V2, []);
    const refunded = synthetic({ invoiceId: 'inv_syn_refunded', status: 'refunded', payments: [{ paymentId: 'pay_syn_refunded', amount: usd(4900), status: 'refunded' }] });
    const open = synthetic({ invoiceId: 'inv_syn_open', status: 'open', payments: [] });
    for (const invoice of [refunded, open]) {
      const result = findingOf(run('service_outage', [invoice.invoiceId], withInvoices(base, invoice)), 'no_credit_due');
      assert.equal(result.assessment, 'consistent');
    }
  });

  it('flags a currency that disagrees with the account', () => {
    const base = evidenceFor('aurora', A1);
    const requested = findingOf(run('duplicate_charge', [DUP_A, DUP_B], base, eur(4900)), 'contradictory_evidence');
    assert.ok(mentions(requested, 'The requested credit is in EUR but the account is in USD.'));
    const policyCurrency = { ...base, policy: { ...base.policy, currency: 'EUR' as const } };
    const mismatched = findingOf(run('duplicate_charge', [DUP_A, DUP_B], policyCurrency), 'contradictory_evidence');
    assert.ok(mentions(mismatched, 'Policy currency EUR differs from account currency USD.'));
    assert.deepEqual(mismatched.invoiceRefs, []);
  });
});

describe('adjudication: borealis duplicate', () => {
  it('credits in euros', () => {
    const result = creditOf(run('duplicate_charge', ['inv_borealis_0001_a', 'inv_borealis_0001_b'], evidenceFor('borealis', 'acct_borealis_0001'), eur(5900)));
    assert.deepEqual(result.creditedInvoiceIds, ['inv_borealis_0001_b']);
    assert.equal(result.currency, 'EUR');
    assert.equal(result.maxCreditMinor, 5900);
    assert.equal(result.capMinor, 20000);
    assert.ok(mentions(result, 'EUR 59.00'));
  });

  it('asks for evidence for the Borealis account with only an August invoice', () => {
    findingOf(run('service_outage', ['inv_borealis_0003_b'], evidenceFor('borealis', 'acct_borealis_0003')), 'missing_evidence');
  });
});

describe('adjudication: bounds, order and purity', () => {
  it('cites every credited invoice even when more invoices were retrieved than a proposal may cite', () => {
    const base = evidenceFor('aurora', A1, WHEN_V2, []);
    const invoices = Array.from({ length: 6 }, (_, index) => {
      const month = index + 1;
      const id = String(month);
      return [
        synthetic({ invoiceId: `inv_syn_d${id}_a`, billingMonth: { year: 2026, month } }),
        synthetic({ invoiceId: `inv_syn_d${id}_b`, billingMonth: { year: 2026, month }, issuedAt: `2026-0${id}-01T06:00:05Z` }),
      ];
    }).flat();
    const result = creditOf(run('duplicate_charge', [], withInvoices(base, ...invoices)));
    assert.equal(result.invoiceRefs.length, MAX_INVOICE_REFS);
    assert.equal(result.creditedInvoiceIds.length, 6);
    assert.equal(result.eligibleMinor, 6 * 4900);
  });

  it('never credits an invoice it cannot cite, and bases the amount only on those it cites', () => {
    const base = evidenceFor('aurora', A1, WHEN_V2, []);
    const invoices = Array.from({ length: 11 }, (_, index) => {
      const year = 2025 + Math.floor(index / 12);
      const month = (index % 12) + 1;
      const id = String(index + 1).padStart(2, '0');
      return [
        synthetic({ invoiceId: `inv_syn_e${id}_a`, billingMonth: { year, month } }),
        synthetic({ invoiceId: `inv_syn_e${id}_b`, billingMonth: { year, month }, issuedAt: `${String(year)}-${String(month).padStart(2, '0')}-01T06:00:05Z` }),
      ];
    }).flat();
    const evidence = withInvoices(base, ...invoices);
    const uncapped = { ...evidence, policy: withClause(evidence.policy, 'dup-charge', { maxCreditMinor: 1000000 }) };
    const result = creditOf(run('duplicate_charge', [], uncapped));
    assert.equal(result.creditedInvoiceIds.length, MAX_INVOICE_REFS);
    assert.equal(result.eligibleMinor, MAX_INVOICE_REFS * 4900);
    assert.ok(!result.creditedInvoiceIds.includes('inv_syn_e11_b'), 'the newest duplicate is the one left out');
    assert.ok(mentions(result, '1 further creditable invoice is not included'));
  });

  it('gives the same result whatever order the invoices were retrieved or cited in', () => {
    const evidence = evidenceFor('aurora', A1);
    const expected = run('duplicate_charge', [DUP_A, DUP_B], evidence, usd(4900));
    const reversed = { ...evidence, invoices: evidence.invoices.toReversed() };
    assert.deepEqual(run('duplicate_charge', [DUP_B, DUP_A], reversed, usd(4900)), expected);
    const rotated = { ...evidence, invoices: [...evidence.invoices.slice(1), ...evidence.invoices.slice(0, 1)] };
    assert.deepEqual(run('duplicate_charge', [DUP_A, DUP_B], rotated, usd(4900)), expected);
  });

  it('does not modify its input', () => {
    const evidence = structuredClone(evidenceFor('aurora', A1));
    const frozen = JSON.stringify(evidence);
    const deepFreeze = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    };
    deepFreeze(evidence);
    run('duplicate_charge', [DUP_A, DUP_B], evidence, usd(4900));
    run('service_outage', [DUP_A], evidence);
    assert.equal(JSON.stringify(evidence), frozen);
  });
});
