import type { Account } from '../data/documents.ts';

export type Currency = Account['currency'];

/** USD and EUR both have two minor-unit digits. Add an exponent lookup before allowing another currency. */
export function formatMinor(amountMinor: number, currency: Currency): string {
  const whole = Math.floor(amountMinor / 100);
  const fraction = String(amountMinor % 100).padStart(2, '0');
  return `${currency} ${String(whole)}.${fraction}`;
}
