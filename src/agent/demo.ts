import { adjudicate, type CaseFacts } from './adjudicate.ts';
import { submissionFor } from './guard.ts';
import type { Investigator } from './investigator.ts';
import { MAX_LIST_INVOICES, proposalArguments } from './tools.ts';

/**
 * The deterministic investigator of demo mode. It uses no model: it retrieves the evidence a
 * representative would look at, lets `adjudicate` decide, and submits exactly what that decides. The
 * submission guard checks it like any other, so a demo run exercises the same tools and the same
 * acceptance rules as a live one.
 *
 * Its plan is: the account, the policy, each cited invoice and, when a duplicate charge cites fewer than
 * two invoices, the newest invoices of the account so the duplicate can be found; then one proposal. At most
 * eight calls, which is the default step allowance. It never proposes more than the evidence supports; the
 * guard's refusals are exercised by scripted investigators in tests.
 */

/** A duplicate is found by comparing invoices, so fewer than two cited invoices need the account's own list. */
const needsListing = (facts: CaseFacts): boolean => facts.category === 'duplicate_charge' && facts.invoiceIds.length < 2;

export function createDemoInvestigator(): Investigator {
  return {
    mode: 'demo',
    async investigate(session) {
      const { facts } = session;

      await session.call('get_account');
      await session.call('get_policy');
      const { account, policy } = session.retrieved();
      // Without the account or an effective policy there is nothing to decide; the runner records why.
      if (account.status !== 'present' || policy.status !== 'present') return;

      for (const invoiceId of facts.invoiceIds) await session.call('get_invoice', { invoiceId });
      if (needsListing(facts)) await session.call('list_invoices', { limit: MAX_LIST_INVOICES });

      const { invoices } = session.retrieved();
      const adjudication = adjudicate(facts, { account: account.value, invoices, policy: policy.value });
      await session.call('submit_proposal', proposalArguments(submissionFor(adjudication)));
    },
  };
}
