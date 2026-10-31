import {
  ProviderKeyConflictError,
  ProviderUnavailableError,
  type CreditProvider,
  type IssueOutcome,
  type IssueRequest,
  type ProviderCredit,
} from '../../src/credits/provider.ts';
import { sha256Hex } from '../../src/domain/canonical.ts';

/** The in-memory twin of the simulated provider, with controls a test needs to break it on purpose. */
export interface MemoryProvider extends CreditProvider {
  /** Every credit held, in the order recorded. */
  credits(): ProviderCredit[];
  readonly calls: { lookups: number; issues: number };
  /** The next `count` issues fail before anything is recorded. */
  failNextIssues(count: number): void;
  /** The next `count` issues record the credit and then fail, as an answer that never arrived does. */
  loseNextResponses(count: number): void;
  /** Holds a credit as if an earlier call had recorded it. */
  record(credit: ProviderCredit): void;
}

export function createMemoryProvider(): MemoryProvider {
  const held = new Map<string, ProviderCredit>();
  const calls = { lookups: 0, issues: 0 };
  let failing = 0;
  let losing = 0;
  const slot = (tenantId: string, key: string): string => `${tenantId}|${key}`;

  return {
    calls,
    credits: () => [...held.values()].map((credit) => structuredClone(credit)),
    failNextIssues(count) {
      failing = count;
    },
    loseNextResponses(count) {
      losing = count;
    },
    record(credit) {
      held.set(slot(credit.tenantId, credit.key), structuredClone(credit));
    },

    lookup(tenantId, key) {
      calls.lookups += 1;
      const credit = held.get(slot(tenantId, key));
      return Promise.resolve(credit === undefined ? null : structuredClone(credit));
    },

    issue(request: IssueRequest): Promise<IssueOutcome> {
      calls.issues += 1;
      if (failing > 0) {
        failing -= 1;
        return Promise.reject(new ProviderUnavailableError('The provider is unavailable (test fault).'));
      }
      const id = slot(request.tenantId, request.key);
      const existing = held.get(id);
      let outcome: IssueOutcome;
      if (existing === undefined) {
        const credit: ProviderCredit = {
          key: request.key,
          tenantId: request.tenantId,
          caseId: request.caseId,
          amount: { amountMinor: request.amount.amountMinor, currency: request.amount.currency },
          reference: `sim-${sha256Hex(request.key).slice(0, 16)}`,
          createdAt: request.now.toISOString(),
        };
        held.set(id, credit);
        outcome = { credit: structuredClone(credit), created: true };
      } else if (
        existing.caseId === request.caseId &&
        existing.amount.amountMinor === request.amount.amountMinor &&
        existing.amount.currency === request.amount.currency
      ) {
        outcome = { credit: structuredClone(existing), created: false };
      } else {
        return Promise.reject(new ProviderKeyConflictError(`The provider already holds key ${request.key} for a different credit.`));
      }
      if (losing > 0) {
        losing -= 1;
        return Promise.reject(new ProviderUnavailableError('The provider answer was lost (test fault).'));
      }
      return Promise.resolve(outcome);
    },
  };
}
