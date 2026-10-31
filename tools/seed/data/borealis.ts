import { money, monthlyInvoice, subscription, type PolicySeed, type TenantSeed } from './helpers.ts';
import type { Account, Invoice } from '../../../src/data/documents.ts';

const EUR = 'EUR' as const;
const SEPTEMBER = { year: 2026, month: 9 } as const;
const AUGUST = { year: 2026, month: 8 } as const;

const accounts: Account[] = [
  {
    accountId: 'acct_borealis_0001',
    displayName: 'Fjord Robotics (fictional)',
    currency: EUR,
    status: 'active',
    subscriptions: [subscription('sub_borealis_0001', 'Team', money(5900, EUR))],
  },
  {
    accountId: 'acct_borealis_0002',
    displayName: 'Lumen Textiles (fictional)',
    currency: EUR,
    status: 'active',
    subscriptions: [subscription('sub_borealis_0002', 'Business', money(14000, EUR))],
  },
  {
    accountId: 'acct_borealis_0003',
    displayName: 'Nordlys Bakery (fictional)',
    currency: EUR,
    status: 'active',
    subscriptions: [subscription('sub_borealis_0003', 'Starter', money(3900, EUR))],
  },
  {
    accountId: 'acct_borealis_0004',
    displayName: 'Skerry Marine (fictional)',
    currency: EUR,
    status: 'active',
    subscriptions: [subscription('sub_borealis_0004', 'Team', money(5900, EUR))],
  },
];

const invoices: Invoice[] = [
  monthlyInvoice({ invoiceId: 'inv_borealis_0001_a', accountId: 'acct_borealis_0001', subscriptionId: 'sub_borealis_0001', number: 'BOR-2026-09-0001', billingMonth: SEPTEMBER, plan: 'Team', amountMinor: 5900, currency: EUR }),
  monthlyInvoice({ invoiceId: 'inv_borealis_0001_b', accountId: 'acct_borealis_0001', subscriptionId: 'sub_borealis_0001', number: 'BOR-2026-09-0002', billingMonth: SEPTEMBER, plan: 'Team', amountMinor: 5900, currency: EUR, issuedAt: '2026-09-01T06:00:05Z' }),

  monthlyInvoice({ invoiceId: 'inv_borealis_0002_a', accountId: 'acct_borealis_0002', subscriptionId: 'sub_borealis_0002', number: 'BOR-2026-09-0003', billingMonth: SEPTEMBER, plan: 'Business', amountMinor: 14000, currency: EUR }),

  monthlyInvoice({ invoiceId: 'inv_borealis_0003_a', accountId: 'acct_borealis_0003', subscriptionId: 'sub_borealis_0003', number: 'BOR-2026-08-0001', billingMonth: AUGUST, plan: 'Starter', amountMinor: 3900, currency: EUR }),

  monthlyInvoice({
    invoiceId: 'inv_borealis_0004_a',
    accountId: 'acct_borealis_0004',
    subscriptionId: 'sub_borealis_0004',
    number: 'BOR-2026-09-0004',
    billingMonth: SEPTEMBER,
    plan: 'Team',
    amountMinor: 5900,
    currency: EUR,
    status: 'void',
    payments: [{ paymentId: 'pay_borealis_0004_a', amount: money(5900, EUR), status: 'succeeded' }],
  }),
];

const policies: PolicySeed[] = [
  {
    policyId: 'credit-policy',
    version: 1,
    effectiveFrom: '2026-01-01T00:00:00Z',
    currency: EUR,
    clauses: [
      { clauseId: 'dup-charge', title: 'Duplicate charge', text: 'A charge collected twice for one subscription period is credited once, up to the clause limit.', appliesTo: 'duplicate_charge', maxCreditMinor: 20000 },
      { clauseId: 'incorrect-amount', title: 'Incorrect amount', text: 'The difference between the billed and the contracted amount is credited, up to the clause limit.', appliesTo: 'incorrect_amount', maxCreditMinor: 12000 },
      { clauseId: 'outage-sla', title: 'Service outage', text: 'A reported outage of more than four hours in a billing period is credited at fifteen percent of that period charge, up to the clause limit.', appliesTo: 'service_outage', maxCreditMinor: 15000, creditRateBasisPoints: 1500 },
      { clauseId: 'other-disputes', title: 'Other disputes', text: 'Other disputes are never credited automatically; they are reported for human follow-up.', appliesTo: 'other', maxCreditMinor: 0 },
    ],
  },
];

export const borealis: TenantSeed = { tenantId: 'borealis', accounts, invoices, policies };
