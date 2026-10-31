import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { PERSONAS } from '../../web/src/personas.ts';
import type { Api } from '../support/api.ts';
import {
  assertNoProblems,
  awaitStatus,
  caseHeading,
  consoleUrl,
  eventuallyEquals,
  fieldErrorOf,
  fillDispute,
  focused,
  heading,
  isList,
  isRecord,
  KESTREL,
  launchBrowser,
  loadWholeTimeline,
  messages,
  need,
  newContext,
  openAs,
  openCase,
  openDisputeForm,
  panel,
  PERSONA,
  steps,
  submitDispute,
  textOf,
  watchPage,
  type BrowserProblem,
} from '../support/browser.ts';
import { DUPLICATE, representative } from '../support/case-flow.ts';
import { approverB, creditFlow, expectOk, REASON } from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';

/**
 * One dispute from the first sign-in to a simulated credit, driven through the console in a real browser the way two
 * people would drive it: a representative opens it, an approver rejects it, the representative asks for a revision,
 * and the approver approves the new proposal. The service is read directly only to compare what the page shows with
 * what was recorded, and to prove that exactly one credit reached the simulated provider.
 *
 * The steps depend on each other, so they run in order and share the case they are about.
 */

const REVISION = 'Fictional revision request: please look at the second invoice again.';
const APPROVAL_NOTE = 'Fictional approval comment: version 2 matches the invoices.';
const USAGE_READ = /\/api\/cases\/[^/]+\/runs\/[^/]+\/usage(\?|$)/;

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
const problems: BrowserProblem[] = [];

let representativePage: Page | undefined;
let approverPage: Page | undefined;
let caseId: string | undefined;

const flow = creditFlow(() => ({ stack, api, cosmos }));
const { approve, awaitCase, awaitingApproval, creditsOf, timelineOf } = flow;
const step = steps(() => need(context, 'the browser context'));

before(
  async () => {
    stack = readStackConnection();
    api = connectApi(stack);
    cosmos = openEmulator(stack);
    browser = await launchBrowser();
    context = await newContext(browser, 'desktop', consoleUrl(stack.apiUrl));
  },
  { timeout: 120_000 },
);

after(async () => {
  try {
    await browser?.close();
  } finally {
    cosmos?.dispose();
  }
});

/** A copy of a usage page in which the last call is shown as still in flight, the way a read in the middle of a run sees it. */
function withLastCallReserved(page: unknown): unknown {
  assert.ok(isRecord(page), 'a usage page is an object');
  const items = page['items'];
  assert.ok(isList(items) && items.length > 0, 'the usage page lists calls');
  const last = items[items.length - 1];
  assert.ok(isRecord(last), 'a call is an object');
  return { ...page, items: [...items.slice(0, -1), { ...last, outcome: 'reserved', latencyMs: null }] };
}

describe('one dispute in the browser, from sign-in to a simulated credit', () => {
  step('the sign-in screen offers every test person and says the credits are simulated', async () => {
    const page = await need(context, 'the browser context').newPage();
    watchPage(page, 'signed-out', problems);
    await page.goto('/');
    await heading(page, 'Sign in').waitFor();
    assert.match(await page.title(), /^Sign in – Resolve \(simulated credits\)$/);
    const buttons = (await page.getByRole('button', { name: /^Sign in as / }).allInnerTexts()).map((text) => text.trim());
    assert.deepEqual(
      buttons,
      PERSONAS.map((persona) => `Sign in as ${persona.label}`),
    );
    await page.locator('.banner-title', { hasText: 'Local test sign-in' }).waitFor();
    assert.match(await textOf(page.locator('p.simulated')), /^Simulated credits\. No real money moves/);
    await page.close();
  });

  step('a representative opens a dispute and the demo investigation proposes a cited credit', async () => {
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.representative);
    representativePage = page;
    await heading(page, 'Cases').waitFor();
    await page.locator('.mode-region').getByText('Deterministic demo agent').waitFor();

    await openDisputeForm(page);
    await fillDispute(page, KESTREL);
    caseId = await submitDispute(page);
    await heading(page, caseHeading(caseId)).waitFor();

    await awaitStatus(page, 'Awaiting approval');
    assert.match(await textOf(panel(page, 'Proposal').locator('p.amount')), /^USD 49\.00 \(a simulated credit\)$/);
    assert.match(await textOf(panel(page, 'Proposal')), /Policy credit-policy, version 2, clause dup-charge/);
    assert.equal(await panel(page, 'Where this case stands').locator('ol.progress li[aria-current="step"]').count(), 1, 'exactly one progress step is the current one');
  });

  step('the evidence opens on demand and marks what the proposal cites', async () => {
    const page = need(representativePage, 'the representative page');
    const evidence = panel(page, 'Evidence');
    await evidence.locator('summary', { hasText: 'Show the evidence' }).click();
    await evidence.locator('h3', { hasText: 'Account: Kestrel Freight (fictional)' }).waitFor();
    await evidence.locator('h3', { hasText: 'Policy credit-policy, version 2' }).waitFor();
    const text = await textOf(evidence);
    assert.ok(!text.includes('Loading the evidence'), 'the loading note is gone');
    for (const invoiceId of KESTREL.invoices) assert.ok(text.includes(invoiceId), `the evidence shows ${invoiceId}`);
    assert.equal(await evidence.locator('.clause-cited').count(), 1, 'one clause is marked as cited');
    assert.match(await textOf(evidence.locator('.clause-cited')), /Clause id dup-charge/);
    assert.ok((await evidence.getByText(/Cited by the proposal/).count()) >= 2, 'the cited invoices and clause are marked');
  });

  step('the list of calls redraws a call it first showed as still reserved', async () => {
    const page = need(representativePage, 'the representative page');
    let reads = 0;
    let routeFailure: string | undefined;
    await page.route(USAGE_READ, async (route) => {
      reads += 1;
      if (reads > 1) {
        await route.continue();
        return;
      }
      try {
        const response = await route.fetch();
        const stale = withLastCallReserved(await response.json());
        await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(stale) });
      } catch (error) {
        routeFailure = error instanceof Error ? error.message : String(error);
        await route.continue();
      }
    });

    const usage = page.locator('details.usage-events');
    const summary = usage.locator('summary');
    const entries = usage.locator('li.timeline-item');
    await summary.click();
    await eventuallyEquals('five calls to be listed', () => entries.count(), 5);
    assert.deepEqual(await usage.locator('li.timeline-item strong').allInnerTexts(), [
      'Tool call: get_account',
      'Tool call: get_policy',
      'Tool call: get_invoice',
      'Tool call: get_invoice',
      'Tool call: submit_proposal',
    ]);
    assert.match(await textOf(entries.last()), /Outcome Reserved, not finished/);
    assert.equal(reads, 1, 'opening the list reads it once');

    // Closing and opening the list reads it again. The service now answers truthfully: the call has finished.
    await summary.click();
    await summary.click();
    await eventuallyEquals('the last call to be redrawn as finished', async () => /Outcome Succeeded/.test(await textOf(entries.last())), true);
    assert.equal(await entries.count(), 5, 'the call was redrawn in place, not added again');
    assert.deepEqual(await usage.locator('.timeline-seq').allInnerTexts(), ['#1', '#2', '#3', '#4', '#5']);
    assert.equal(reads, 2, 'the second read is the one that corrected the entry');
    await page.unroute(USAGE_READ);
    assert.equal(routeFailure, undefined, 'the rewritten response could be built');
  });

  step('an approver sees the form refuse an empty reason, then rejects with a reason that is recorded', async () => {
    const id = need(caseId, 'the case');
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.approver);
    approverPage = page;
    await openCase(page, id);
    await awaitStatus(page, 'Awaiting approval');

    const decision = panel(page, 'Your decision');
    const reason = decision.getByLabel('Reason for rejecting', { exact: true });
    await decision.getByRole('button', { name: 'Reject proposal', exact: true }).click();
    const error = await fieldErrorOf(page, reason);
    await error.waitFor({ state: 'visible' });
    assert.equal(await textOf(error), 'Error: A reason is required.');
    assert.equal(await reason.getAttribute('aria-invalid'), 'true');
    assert.equal((await focused(page)).id, await reason.getAttribute('id'), 'focus moves to the field that needs fixing');

    await reason.fill(REASON);
    await decision.getByRole('button', { name: 'Reject proposal', exact: true }).click();
    const done = messages(page).locator('.banner-success');
    await done.waitFor();
    assert.match(await textOf(done), /^Rejected\. The reason is recorded\./);
    await awaitStatus(page, 'Rejected', 30_000);
    assert.ok(
      (await textOf(panel(page, 'Proposal'))).includes(`Rejected by You on`) && (await textOf(panel(page, 'Proposal'))).includes(`Reason: “${REASON}”`),
      'the proposal shows who rejected it and why',
    );
    await eventuallyEquals('focus to move to the message region', async () => (await focused(page)).className.split(' ').includes('messages'), true, 10_000);
  });

  step('the representative asks for a revision and gets a new proposal that needs a fresh approval', async () => {
    const id = need(caseId, 'the case');
    const page = need(representativePage, 'the representative page');
    await page.reload();
    await heading(page, caseHeading(id)).waitFor();
    await awaitStatus(page, 'Rejected');

    const revision = panel(page, 'Request a revision');
    const reason = revision.getByLabel('Reason', { exact: true });
    await revision.getByRole('button', { name: 'Request revision', exact: true }).click();
    assert.match(await textOf(await fieldErrorOf(page, reason)), /^Error: .*required/);
    assert.equal(await reason.getAttribute('aria-invalid'), 'true');

    await reason.fill(REVISION);
    await revision.getByRole('button', { name: 'Request revision', exact: true }).click();
    const done = messages(page).locator('.banner-success');
    await done.waitFor();
    assert.match(await textOf(done), /^Revision requested\. A new investigation is starting/);

    await awaitStatus(page, 'Awaiting approval', 90_000);
    const proposal = panel(page, 'Proposal');
    assert.match(await textOf(proposal.locator('p.status-line').first()), /Version 2$/);
    const earlier = proposal.locator('details.earlier');
    await earlier.locator('summary', { hasText: 'Earlier versions (1)' }).click();
    const text = await textOf(earlier);
    assert.ok(text.includes(`Version 1: credit USD 49.00 (Rejected). Reason: “${REASON}”`), `the earlier version is listed with its reason: ${text}`);
  });

  step('the approver approves version 2 and exactly one simulated credit is recorded', async () => {
    const id = need(caseId, 'the case');
    const page = need(approverPage, 'the approver page');
    await page.reload();
    await heading(page, caseHeading(id)).waitFor();
    await awaitStatus(page, 'Awaiting approval');

    const decision = panel(page, 'Your decision');
    await decision.getByLabel('Comment (optional)', { exact: true }).fill(APPROVAL_NOTE);
    await decision.getByRole('button', { name: 'Approve proposal', exact: true }).click();
    const done = messages(page).locator('.banner-success');
    await done.waitFor();
    assert.equal(await textOf(done), 'Approved. The simulated credit is being issued.');

    await awaitStatus(page, 'Credited (simulated)', 60_000);
    const credit = await textOf(panel(page, 'Credit'));
    assert.match(credit, /USD 49\.00 credited for proposal version 2\. No real money moved\./);
    const credits = await creditsOf(id);
    assert.equal(credits.length, 1, 'the simulated provider holds exactly one credit for the case');
    const [issued] = credits;
    assert.deepEqual(issued?.amount, { amountMinor: 4900, currency: 'USD' });
    assert.ok(credit.includes(issued?.reference ?? 'no reference'), 'the page shows the provider reference the provider holds');
    assert.ok((await textOf(panel(page, 'Proposal'))).includes(`Comment: “${APPROVAL_NOTE}”`), 'the approval comment is shown');
  });

  step('the timeline pages in order and shows exactly what the service recorded', async () => {
    const id = need(caseId, 'the case');
    const page = need(representativePage, 'the representative page');
    await page.reload();
    await heading(page, caseHeading(id)).waitFor();
    await awaitStatus(page, 'Credited (simulated)');

    const recorded = await timelineOf(representative, id);
    assert.ok(recorded.length > 10, `the case recorded ${String(recorded.length)} entries, and the timeline needs more than one page of ten`);
    const timeline = panel(page, 'Timeline');
    const entries = timeline.locator('li.timeline-item');
    await eventuallyEquals('the first page of ten entries', () => entries.count(), 10);

    await loadWholeTimeline(page);
    const end = timeline.locator('p.end-note');
    assert.equal(await textOf(end), `${String(recorded.length)} entries shown. That is everything recorded so far.`);
    assert.deepEqual(
      await timeline.locator('.timeline-seq').allInnerTexts(),
      recorded.map((item) => `#${String(item.seq)}`),
      'the page lists every entry once, in the order the service recorded them',
    );
  });

  step('a decision the service refuses is shown with its code and the correlation id the service sent', async () => {
    const page = need(approverPage, 'the approver page');
    const pending = await awaitingApproval(representative, DUPLICATE, 'e2e-conflict');
    await openCase(page, pending.caseId);
    await awaitStatus(page, 'Awaiting approval');
    const approveButton = panel(page, 'Your decision').getByRole('button', { name: 'Approve proposal', exact: true });
    await approveButton.waitFor();

    // Someone else decides first, so the click that follows is a competing decision.
    expectOk(await approve(approverB, pending), 202);
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => candidate.request().method() === 'POST' && /\/proposals\/\d+\/approve$/.test(new URL(candidate.url()).pathname)),
      approveButton.click(),
    ]);
    assert.equal(response.status(), 409);
    const body: unknown = await response.json();
    assert.ok(isRecord(body), 'the refusal is a problem document');
    const { code, correlationId } = body;
    assert.equal(code, 'proposal_already_decided', 'a decision made after another approver decided is refused as already decided');
    assert.equal(typeof correlationId, 'string');
    assert.equal(response.headers()['x-correlation-id'], correlationId, 'the header and the body name the same request');

    const banner = messages(page).locator('.banner-error');
    await banner.waitFor();
    assert.equal(await textOf(banner.locator('p.meta')), `Code proposal_already_decided · HTTP 409 · Correlation id ${String(correlationId)}`);

    await awaitCase(representative, pending.caseId, 'credited');
    assert.equal((await creditsOf(pending.caseId)).length, 1, 'the competing decisions produced one credit');
  });

  step('the browser reported no unexpected errors', () => {
    assertNoProblems(problems);
  });
});
