import type { Account, Invoice, Policy } from '../../../src/data/documents.ts';

export type Currency = Account['currency'];
export type Money = Invoice['total'];
export type PolicySeed = Omit<Policy, 'status'>;

export interface TenantSeed {
  tenantId: string;
  accounts: Account[];
  invoices: Invoice[];
  policies: PolicySeed[];
}

export const money = (amountMinor: number, currency: Currency): Money => ({ amountMinor, currency });

const pad = (value: number): string => String(value).padStart(2, '0');

export interface BillingMonth {
  year: number;
  month: number;
}

export function monthRange({ year, month }: BillingMonth): { periodStart: string; periodEnd: string; issuedAt: string; label: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return {
    periodStart: `${String(year)}-${pad(month)}-01`,
    periodEnd: `${String(year)}-${pad(month)}-${pad(lastDay)}`,
    issuedAt: `${String(year)}-${pad(month)}-01T06:00:00Z`,
    label: `${names[month - 1] ?? 'Unknown'} ${String(year)}`,
  };
}

export interface MonthlyInvoiceInput {
  invoiceId: string;
  accountId: string;
  subscriptionId: string;
  number: string;
  billingMonth: BillingMonth;
  plan: string;
  amountMinor: number;
  currency: Currency;
  status?: Invoice['status'];
  /** Overrides the default single succeeded payment. */
  payments?: Invoice['payments'];
  /** Overrides the default issue time; used to place a second invoice seconds after the first. */
  issuedAt?: string;
  /** Overrides the generated line description. */
  lineDescription?: string;
}

/** One-line subscription invoice for a calendar month, paid in full unless stated otherwise. */
export function monthlyInvoice(input: MonthlyInvoiceInput): Invoice {
  const range = monthRange(input.billingMonth);
  const amount = money(input.amountMinor, input.currency);
  const status = input.status ?? 'paid';
  return {
    invoiceId: input.invoiceId,
    accountId: input.accountId,
    subscriptionId: input.subscriptionId,
    number: input.number,
    periodStart: range.periodStart,
    periodEnd: range.periodEnd,
    issuedAt: input.issuedAt ?? range.issuedAt,
    status,
    lines: [{ description: input.lineDescription ?? `${input.plan} plan – ${range.label}`, amount }],
    total: amount,
    payments:
      input.payments ??
      (status === 'paid'
        ? [{ paymentId: `pay_${input.invoiceId.slice('inv_'.length)}`, amount, status: 'succeeded' }]
        : []),
  };
}

export function subscription(subscriptionId: string, plan: string, monthlyAmount: Money): Account['subscriptions'][number] {
  return { subscriptionId, plan, status: 'active', monthlyAmount };
}
