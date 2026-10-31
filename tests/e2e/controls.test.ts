import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { loadContract } from '../../src/contract/load.ts';
import { statusInfo } from '../../web/src/format.ts';
import type { Api } from '../support/api.ts';
import {
  a11yViolations,
  announced,
  assertNoProblems,
  awaitStatus,
  caseHeading,
  consoleUrl,
  evaluate,
  evaluateStrings,
  eventuallyEquals,
  fieldErrorOf,
  fillDispute,
  FJORD,
  focused,
  goTo,
  heading,
  isRecord,
  KESTREL,
  launchBrowser,
  listedCaseIds,
  need,
  newContext,
  openAs,
  openCase,
  openDisputeForm,
  panel,
  PERSONA,
  primaryNav,
  steps,
  submitDispute,
  textOf,
  watchPage,
  type BrowserProblem,
} from '../support/browser.ts';
import { caseFlow, MISSING_EVIDENCE, newKey, representative, stranger, type CaseStatus } from '../support/case-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';
import { sleep, waitFor } from '../support/wait.ts';

/**
 * What the console does around the main journey, checked in a real browser under the policy it is served with:
 * separation of duties, idempotent replay and its conflict, two tenants, paging and filtering, validation that stops
 * before the network, accessibility and keyboard use, the labelled agent mode, the content security policy, and the
 * interactive API reference. Where the page shows what the service recorded, the service is read to compare.
 *
 * The steps depend on each other, so they run in order and share the two representatives' pages and cases.
 */

const SMALL_PAGE = 5;
const WANTED_DISPUTES = 11;
const SESSION = /\/api\/session(\?|$)/;

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
const problems: BrowserProblem[] = [];

let auroraPage: Page | undefined;
let borealisPage: Page | undefined;
let auroraCaseId: string | undefined;
let borealisCaseId: string | undefined;

const flow = caseFlow(() => ({ stack, api, cosmos }));
const { casePages, createCase } = flow;
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

/** Waits for the browser to have reported something that matches, and says what it did report when it has not. */
async function reported(reports: readonly string[], pattern: RegExp, what: string): Promise<void> {
  try {
    await waitFor(what, () => Promise.resolve(reports.find((text) => pattern.test(text))), { timeoutMs: 10_000, intervalMs: 100 });
  } catch (error) {
    throw new Error(`${what}; the browser reported ${JSON.stringify(reports)}`, { cause: error });
  }
}

/** What has keyboard focus, as its tag and text. */
async function focusOf(page: Page): Promise<string> {
  const now = await focused(page);
  return `${now.tag}:${now.text}`;
}

const shownNote = (count: number): string => `${String(count)} ${count === 1 ? 'dispute' : 'disputes'} shown. That is all of them.`;
const loadedNote = (count: number): string => `${String(count)} more ${count === 1 ? 'dispute' : 'disputes'} loaded.`;

/** The status label on each listed card, in order. */
const listedBadges = (page: Page): Promise<string[]> => page.locator('.list-region ul.cards li.card .card-head .badge').allInnerTexts();

async function openCases(page: Page): Promise<void> {
  await primaryNav(page).getByRole('link', { name: 'Cases', exact: true }).click();
  await heading(page, 'Cases').waitFor();
}

interface Accepted {
  readonly caseId: string;
  readonly status: string;
  readonly runId: string;
  readonly replayed: boolean;
}

function acceptedOf(body: unknown): Accepted {
  assert.ok(isRecord(body), 'the answer is an object');
  const summary = body['case'];
  assert.ok(isRecord(summary), 'the answer carries the case');
  const { caseId, status } = summary;
  const { runId, replayed } = body;
  assert.ok(
    typeof caseId === 'string' && typeof status === 'string' && typeof runId === 'string' && typeof replayed === 'boolean',
    'the answer has the shape of an accepted case',
  );
  return { caseId, status, runId, replayed };
}

function problemOf(body: unknown): { readonly code: string; readonly correlationId: string } {
  assert.ok(isRecord(body), 'the refusal is a problem document');
  const { code, correlationId } = body;
  assert.ok(typeof code === 'string' && typeof correlationId === 'string', 'the problem names its code and correlation id');
  return { code, correlationId };
}

interface Answer {
  readonly status: number;
  readonly replayHeader: string | undefined;
  readonly body: unknown;
}

/** Presses "Submit dispute" and returns what the service answered to that request. */
async function submitFor(page: Page): Promise<Answer> {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.request().method() === 'POST' && new URL(candidate.url()).pathname === '/api/cases'),
    page.getByRole('button', { name: 'Submit dispute', exact: true }).click(),
  ]);
  const body: unknown = await response.json();
  return { status: response.status(), replayHeader: response.headers()['idempotency-replayed'], body };
}

/** Opens a dispute of another tenant by its address: the console says it does not exist and shows nothing of it. */
async function assertCaseHidden(page: Page, caseId: string, leaks: readonly string[]): Promise<void> {
  await goTo(page, `#/cases/${caseId}`);
  await heading(page, caseHeading(caseId)).waitFor();
  await page.getByText('This case does not exist, or it belongs to another tenant.', { exact: true }).waitFor();
  const text = await textOf(page.locator('main#main'));
  for (const leak of leaks) assert.ok(!text.includes(leak), `the page does not show "${leak}"`);
}

/** Looks an account up on a fresh form and checks that the console reports it as not found for this tenant. */
async function assertAccountHidden(page: Page, accountId: string): Promise<void> {
  await openCases(page);
  await openDisputeForm(page);
  const input = page.getByLabel('Account id', { exact: true });
  await input.fill(accountId);
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => new URL(candidate.url()).pathname === `/api/accounts/${accountId}`),
    page.getByRole('button', { name: 'Look up account', exact: true }).click(),
  ]);
  assert.equal(response.status(), 404, `${accountId} does not exist for this tenant`);
  const message = await fieldErrorOf(page, input);
  await eventuallyEquals(`the error for ${accountId}`, () => textOf(message), 'Error: No such account for this tenant.');
  assert.equal(await input.getAttribute('aria-invalid'), 'true');
  assert.equal((await focused(page)).id, await input.getAttribute('id'), 'focus is back on the account field');
}

describe('the console around the journey: separation, replay, tenants, paging, validation, accessibility, modes, policy and reference', () => {
  step('a person who is both representative and approver is told they cannot decide their own dispute', async () => {
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.both);
    await openDisputeForm(page);
    await fillDispute(page, KESTREL);
    await submitDispute(page);
    await awaitStatus(page, 'Awaiting approval');

    const decision = panel(page, 'Your decision');
    await decision.waitFor();
    assert.ok(
      (await textOf(decision)).includes('You opened this case, so you cannot approve or reject its proposal. A different Approver has to decide. This separation of duties is enforced by the service.'),
      'the page explains why this person cannot decide',
    );
    assert.equal(await page.getByRole('button', { name: /^(Approve|Reject) proposal$/ }).count(), 0, 'there is nothing to press to decide');
    await page.close();
  });

  step('the same dispute sent again with the same key is answered with the original, and other content under that key is refused', async () => {
    const existing = (await casePages(representative, 50)).flat().length;
    const key = `e2e-replay-${randomBytes(6).toString('hex')}`;
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.representative);
    auroraPage = page;

    await openDisputeForm(page);
    await fillDispute(page, { ...KESTREL, key });
    const caseId = await submitDispute(page);
    auroraCaseId = caseId;
    await awaitStatus(page, 'Awaiting approval');

    await openDisputeForm(page);
    await fillDispute(page, { ...KESTREL, key });
    const replay = await submitFor(page);
    assert.equal(replay.status, 202, 'a replay is answered as the original was');
    assert.equal(replay.replayHeader, 'true', 'the service says it is a replay');
    const accepted = acceptedOf(replay.body);
    assert.equal(accepted.replayed, true);
    assert.equal(accepted.caseId, caseId, 'the replay names the original case');
    assert.equal(accepted.runId, 'run-1');

    await heading(page, 'Dispute already submitted').waitFor();
    await page.getByText('This idempotency key was already used with identical content, so no new dispute was opened. The original dispute is returned.', { exact: true }).waitFor();
    assert.equal(await textOf(page.locator('dl.facts')), `Case ${caseId} Status ${statusInfo(accepted.status).label} Investigation run ${accepted.runId}`, 'the page shows what the service returned');
    assert.equal(await page.getByRole('link', { name: 'Open the case', exact: true }).getAttribute('href'), `#/cases/${caseId}`);

    await page.getByRole('button', { name: 'Submit another dispute', exact: true }).click();
    await heading(page, 'New dispute').waitFor();
    const another = await page.getByLabel('Idempotency key', { exact: true }).inputValue();
    assert.notEqual(another, key, 'another dispute gets another key');
    assert.match(another, /^[A-Za-z0-9._~-]{16,64}$/);

    await fillDispute(page, { ...KESTREL, description: 'Fictional browser journey: different content sent under a key that is already used.', key });
    const conflict = await submitFor(page);
    assert.equal(conflict.status, 409);
    const { code, correlationId } = problemOf(conflict.body);
    assert.equal(code, 'idempotency_key_reused');
    const banner = page.locator('.submit-error .banner-error');
    await banner.waitFor();
    assert.equal(await textOf(banner.locator('p.meta')), `Code ${code} · HTTP 409 · Correlation id ${correlationId}`);

    assert.equal((await casePages(representative, 50)).flat().length, existing + 1, 'the replay and the refused request opened nothing');
  });

  step("a representative of the other tenant opens a dispute and sees the proposal in euros under that tenant's policy", async () => {
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.borealisRepresentative);
    borealisPage = page;
    await openDisputeForm(page);
    await fillDispute(page, { ...FJORD, requested: '59.00' });
    borealisCaseId = await submitDispute(page);
    await awaitStatus(page, 'Awaiting approval');

    const proposal = panel(page, 'Proposal');
    assert.equal(await textOf(proposal.locator('p.amount')), 'EUR 59.00 (a simulated credit)');
    assert.match(await textOf(proposal), /Policy credit-policy, version 1, clause \S+/);
  });

  step("each tenant lists only its own disputes, and another tenant's dispute or account does not exist for it", async () => {
    const aurora = need(auroraPage, 'the aurora representative page');
    const borealis = need(borealisPage, 'the borealis representative page');
    const auroraCase = need(auroraCaseId, 'the aurora case');
    const borealisCase = need(borealisCaseId, 'the borealis case');

    const auroraIds = (await casePages(representative, 50)).flat().map((item) => item.caseId);
    const borealisIds = (await casePages(stranger, 50)).flat().map((item) => item.caseId);
    assert.ok(auroraIds.includes(auroraCase), 'aurora lists its own dispute');
    assert.ok(borealisIds.includes(borealisCase), 'borealis lists its own dispute');
    assert.deepEqual(
      auroraIds.filter((id) => borealisIds.includes(id)),
      [],
      'no dispute is listed by both tenants',
    );
    assert.ok(borealisIds.length <= 20, 'the other tenant fits on one page');

    await openCases(borealis);
    await eventuallyEquals('only the borealis disputes to be listed', () => listedCaseIds(borealis), borealisIds);
    await eventuallyEquals('the end note', () => textOf(borealis.locator('.more-region')), shownNote(borealisIds.length));
    assert.match(await textOf(borealis.locator('p.lede')), /^Disputes for the borealis tenant, newest first\./);

    await assertCaseHidden(borealis, auroraCase, ['Kestrel', 'USD 49.00']);
    await assertCaseHidden(aurora, borealisCase, ['Fjord', 'EUR 59.00']);

    await assertAccountHidden(aurora, 'acct_borealis_0001');
    await assertAccountHidden(aurora, 'acct_aurora_9999');
    await assertAccountHidden(borealis, 'acct_aurora_0001');
  });

  step(
    'the list pages through disputes by the chosen size and filters by status as the service does',
    async () => {
      const page = need(auroraPage, 'the aurora representative page');
      const have = (await casePages(representative, 50)).flat().length;
      await createCase(representative, newKey('e2e-finding'), MISSING_EVIDENCE);
      for (let index = 0; index < WANTED_DISPUTES - have - 1; index += 1) await createCase(representative, newKey(`e2e-fill-${String(index)}`));

      const settled = await waitFor(
        'every dispute to have been investigated',
        async () => {
          const all = (await casePages(representative, 50)).flat();
          return all.some((item) => item.status === 'queued' || item.status === 'investigating') ? undefined : all;
        },
        { timeoutMs: 150_000, intervalMs: 1_000 },
      );
      const ordered = settled.map((item) => item.caseId);
      const total = ordered.length;
      assert.ok(total >= WANTED_DISPUTES && total <= 50, `between ${String(WANTED_DISPUTES)} and 50 disputes, found ${String(total)}`);

      await openCases(page);
      const perPage = page.getByLabel('Per page', { exact: true });
      assert.equal(await perPage.inputValue(), '20', 'the list starts at twenty a page');
      await perPage.selectOption(String(SMALL_PAGE));
      await eventuallyEquals('the first page', () => listedCaseIds(page), ordered.slice(0, SMALL_PAGE));

      const more = page.locator('.more-region');
      let shown = SMALL_PAGE;
      while (shown < total) {
        const next = Math.min(shown + SMALL_PAGE, total);
        await more.getByRole('button', { name: 'Load more', exact: true }).click();
        await eventuallyEquals(`${String(next)} disputes to be listed`, () => listedCaseIds(page), ordered.slice(0, next));
        await eventuallyEquals('focus on the first new dispute', () => focusOf(page), `a:${caseHeading(need(ordered[shown], 'the next dispute'))}`);
        await eventuallyEquals('the announcement of what was added', () => announced(page), loadedNote(next - shown));
        shown = next;
      }
      await eventuallyEquals('the end note', () => textOf(more), shownNote(total));
      assert.equal(await more.getByRole('button').count(), 0, 'there is nothing more to load');

      await perPage.selectOption('50');
      await eventuallyEquals('every dispute at fifty a page', () => listedCaseIds(page), ordered);

      const status = page.getByLabel('Status', { exact: true });
      const filters: readonly { readonly label: string; readonly status: CaseStatus }[] = [
        { label: 'Awaiting approval', status: 'awaiting_approval' },
        { label: 'Finding reported', status: 'finding_reported' },
      ];
      for (const filter of filters) {
        await status.selectOption({ label: filter.label });
        const expected = (await casePages(representative, 50, filter.status)).flat().map((item) => item.caseId);
        assert.ok(expected.length > 0, `the service lists disputes that are ${filter.label}`);
        await eventuallyEquals(`only the ${filter.label} disputes`, () => listedCaseIds(page), expected);
        assert.deepEqual([...new Set(await listedBadges(page))], [filter.label], 'every card carries the chosen status');
      }

      await status.selectOption({ label: 'Approval expired' });
      assert.deepEqual((await casePages(representative, 50, 'expired')).flat(), [], 'no dispute has expired');
      await eventuallyEquals('the empty list', () => textOf(page.locator('.list-region p.empty')), 'There are no disputes with the status “Approval expired”.');
    },
    240_000,
  );

  step('the form refuses an empty submission in the page, names every field and sends nothing', async () => {
    const page = need(auroraPage, 'the aurora representative page');
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/cases') posts.push(request.url());
    });

    await openCases(page);
    await openDisputeForm(page);
    const account = page.getByLabel('Account id', { exact: true });
    const category = page.getByLabel('Category', { exact: true });
    const description = page.getByLabel('What happened?', { exact: true });
    await page.getByRole('button', { name: 'Submit dispute', exact: true }).click();

    await eventuallyEquals(
      'each missing field to be named',
      async () => [await textOf(await fieldErrorOf(page, account)), await textOf(await fieldErrorOf(page, category)), await textOf(await fieldErrorOf(page, description))],
      ['Error: Enter an account id such as acct_aurora_0001.', 'Error: Choose a category.', 'Error: Describe the dispute.'],
    );
    for (const control of [account, category, description]) assert.equal(await control.getAttribute('aria-invalid'), 'true');
    assert.equal((await focused(page)).id, await account.getAttribute('id'), 'focus goes to the first field that needs attention');
    await eventuallyEquals('the announcement', () => announced(page), '3 fields need attention.');

    await sleep(500);
    assert.deepEqual(posts, [], 'nothing was sent');
  });

  step('every screen passes the basic accessibility checks and the keyboard reaches the skip link first', async () => {
    const ctx = need(context, 'the browser context');
    const page = need(auroraPage, 'the aurora representative page');
    const caseId = need(auroraCaseId, 'the aurora case');

    const signedOut = await ctx.newPage();
    watchPage(signedOut, 'signed-out', problems);
    await signedOut.goto('/');
    await heading(signedOut, 'Sign in').waitFor();
    assert.deepEqual(await a11yViolations(signedOut), [], 'the sign-in screen');
    await signedOut.close();

    await openCases(page);
    await page.locator('.list-region ul.cards').waitFor();
    assert.deepEqual(await a11yViolations(page), [], 'the case list');
    await openDisputeForm(page);
    assert.deepEqual(await a11yViolations(page), [], 'the new dispute form');

    const approver = await openAs(ctx, problems, PERSONA.approver);
    await openCase(approver, caseId);
    await awaitStatus(approver, 'Awaiting approval');
    await panel(approver, 'Your decision').getByRole('button', { name: 'Approve proposal', exact: true }).waitFor();
    assert.deepEqual(await a11yViolations(approver), [], 'a dispute waiting for a decision');

    const operator = await openAs(ctx, problems, PERSONA.operator);
    await primaryNav(operator).getByRole('link', { name: 'Operator recovery', exact: true }).click();
    await heading(operator, 'Operator recovery').waitFor();
    await operator.getByLabel('Work state', { exact: true }).waitFor();
    await eventuallyEquals('the work list to finish loading', () => operator.locator('p.loading').count(), 0);
    assert.deepEqual(await a11yViolations(operator), [], 'operator recovery');
    await operator.close();

    // A plain load puts focus nowhere, so the first Tab stop is the skip link, and Enter on it moves focus to the content.
    await approver.reload();
    await primaryNav(approver).waitFor();
    const address = approver.url();
    await approver.keyboard.press('Tab');
    assert.ok((await focused(approver)).className.includes('skip-link'), 'the first Tab stop is the skip link');
    await approver.keyboard.press('Enter');
    const target = await focused(approver);
    assert.equal(`${target.tag}#${target.id}`, 'main#main', 'the skip link moves focus to the content');
    assert.equal(approver.url(), address, 'the skip link does not change the address');
    await approver.close();

    const fresh = await openAs(ctx, problems, PERSONA.representative);
    await eventuallyEquals('focus on the heading after signing in', () => focusOf(fresh), 'h1:Cases');
    await fresh.close();
  });

  step('a blocked live model is shown as blocked and never as the demo agent; an available one is labelled live (the session answer is rewritten here, so this is not a live-model run)', async () => {
    let variant: 'blocked' | 'available' = 'blocked';
    let routeFailure: string | undefined;
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.representative, async (candidate) => {
      await candidate.route(SESSION, async (route) => {
        try {
          const response = await route.fetch();
          const session: unknown = await response.json();
          assert.ok(isRecord(session), 'the session is an object');
          const environment = session['environment'];
          assert.ok(isRecord(environment), 'the session has an environment');
          const live = variant === 'blocked' ? { liveAvailable: false, liveBlockedReason: 'live_not_approved' } : { liveAvailable: true, liveBlockedReason: null };
          await route.fulfill({
            status: response.status(),
            contentType: 'application/json',
            body: JSON.stringify({ ...session, environment: { ...environment, agentMode: 'live', ...live } }),
          });
        } catch (error) {
          routeFailure = error instanceof Error ? error.message : String(error);
          await route.continue();
        }
      });
    });

    const mode = page.locator('.mode-region');
    await mode.getByText('Live model blocked', { exact: true }).waitFor();
    const blocked = await textOf(mode);
    assert.ok(blocked.includes('Live-model runs are not approved on this deployment.'), blocked);
    assert.ok(blocked.includes('The demo agent is not substituted'), blocked);
    assert.ok(!blocked.includes('Deterministic demo agent'), 'the demo agent is not presented as the mode');
    assert.equal(await page.locator('p.simulated').count(), 1, 'the credits are still labelled simulated');

    variant = 'available';
    await page.reload();
    await primaryNav(page).waitFor();
    const live = page.locator('.mode-region p.mode-live');
    await live.waitFor();
    assert.equal(await textOf(live.locator('.badge')), 'Live model');
    assert.ok((await textOf(live)).includes('the model cannot approve or execute a credit'), 'the page says what the model cannot do');
    const available = await textOf(mode);
    assert.ok(!available.includes('Live model blocked'), 'an available model is not shown as blocked');
    assert.ok(!available.includes('Deterministic demo agent'), 'an available model is not shown as the demo agent');
    assert.equal(routeFailure, undefined, 'the rewritten session could be built');
    await page.close();
  });

  step('the browser enforces the strict content security policy the console is served with, and the page watcher treats a violation as a failure', async () => {
    const page = await need(context, 'the browser context').newPage();
    const reports: string[] = [];
    page.on('console', (message) => {
      reports.push(message.text());
    });
    // The probe's own list: the violations this step causes on purpose must not fail the run, but the watcher must record them.
    const caught: BrowserProblem[] = [];
    watchPage(page, 'policy-probe', caught);

    const response = await page.goto('/');
    assert.ok(response, 'the console document was answered');
    const headers = response.headers();
    const policy = headers['content-security-policy'] ?? '';
    for (const directive of ["default-src 'none'", "script-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
      assert.ok(policy.includes(directive), `the policy has ${directive}: ${policy}`);
    }
    assert.ok(!/unsafe-(eval|inline)/.test(policy), 'the policy allows neither eval nor inline code');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    await heading(page, 'Sign in').waitFor();

    const ran = await evaluate(
      page,
      `(() => { const script = document.createElement('script'); script.textContent = 'window.__inlineScriptRan = true'; document.head.append(script); return window.__inlineScriptRan === true; })()`,
    );
    assert.equal(ran, false, 'an inline script does not run');
    await reported(reports, /inline script[\s\S]*Content Security Policy directive[\s\S]*script-src/i, 'the browser to report the blocked inline script');

    const outcome = await evaluate(page, `fetch('https://example.invalid/never').then(() => 'allowed', () => 'refused')`);
    assert.equal(outcome, 'refused', 'a request to an origin the policy does not name is refused');
    await reported(reports, /example\.invalid[\s\S]*Content Security Policy directive[\s\S]*connect-src/i, 'the browser to report the blocked connection');

    const recorded = caught.filter((problem) => problem.kind === 'console' && /Content Security Policy/.test(problem.detail));
    assert.ok(recorded.length >= 2, `the page watcher recorded both violations as problems: ${JSON.stringify(caught)}`);
    await page.close();
  });

  step('the interactive API reference renders every operation of the contract', async () => {
    const page = await need(context, 'the browser context').newPage();
    watchPage(page, 'reference', problems);
    await page.goto('/reference/');
    assert.equal(await page.title(), 'Resolve API reference');
    const title = page.locator('.swagger-ui .info .title');
    await title.waitFor();
    assert.match(await textOf(title), /Resolve API/);

    const expected = loadContract()
      .operations.map((operation) => operation.operationId)
      .toSorted();
    assert.ok(expected.length > 0, 'the contract defines operations');
    await eventuallyEquals(
      'every operation to be listed',
      async () => {
        const ids = await evaluateStrings(page, `Array.from(document.querySelectorAll('.swagger-ui .opblock')).map((block) => block.id)`);
        return [...new Set(ids.map((id) => id.split('-').pop() ?? ''))].toSorted();
      },
      expected,
      30_000,
    );
    await page.close();
  });

  step('the browser reported no unexpected errors', () => {
    assertNoProblems(problems);
  });
});
