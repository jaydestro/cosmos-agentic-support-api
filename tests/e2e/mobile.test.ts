import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { Api } from '../support/api.ts';
import {
  a11yViolations,
  assertNoProblems,
  awaitStatus,
  caseHeading,
  consoleUrl,
  evaluate,
  evaluateStrings,
  eventuallyEquals,
  fillDispute,
  heading,
  horizontalOverflow,
  KESTREL,
  launchBrowser,
  listedCaseIds,
  messages,
  need,
  newContext,
  openAs,
  openDisputeForm,
  panel,
  PERSONA,
  primaryNav,
  steps,
  submitDispute,
  tapOn,
  textOf,
  watchPage,
  type BrowserProblem,
} from '../support/browser.ts';
import { newKey, representative } from '../support/case-flow.ts';
import { creditFlow } from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';
import { waitFor } from '../support/wait.ts';

/**
 * The console on a phone-sized touch screen, driven by touch: a representative opens a dispute and an approver
 * approves it, each pressing with a tap. On every screen the journey passes through, nothing may scroll sideways,
 * every control the stylesheet gives a 44 px target must have one, and the basic accessibility checks must pass.
 * A last check shrinks the window to 320 px, the width at which a page has to reflow without scrolling sideways.
 *
 * The steps depend on each other, so they run in order and share the pages and the case they are about.
 */

const PHONE_WIDTH = 390;
const PHONE_HEIGHT = 844;
const NARROWEST = { width: 320, height: 640 } as const;
const PAGE_OF_FIVE = 5;
const WANTED_DISPUTES = 7;

// The controls the stylesheet gives a target of at least 2.75rem (44 px). Links inside running text are not among them.
const TOUCH_TARGETS = 'button, a.button, .site-nav a, .back a, .site-footer a, summary, input[type="text"], select, textarea, .check';

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
const { casePages, createCase, creditsOf } = flow;
const step = steps(() => need(context, 'the browser context'));

before(
  async () => {
    stack = readStackConnection();
    api = connectApi(stack);
    cosmos = openEmulator(stack);
    browser = await launchBrowser();
    context = await newContext(browser, 'mobile', consoleUrl(stack.apiUrl));
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

/** The controls on the page that are drawn lower than 44 px. */
function tooSmall(page: Page): Promise<string[]> {
  return evaluateStrings(
    page,
    `(() => {
      const found = [];
      for (const element of document.querySelectorAll('${TOUCH_TARGETS}')) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (box.height < 43.5) {
          const name = (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 40);
          found.push(element.tagName.toLowerCase() + ' "' + name + '" is ' + Math.round(box.height * 10) / 10 + ' px high');
        }
      }
      return found;
    })()`,
  );
}

/** Fails, naming the elements that stick out, when the page scrolls sideways. */
async function assertFits(page: Page, what: string): Promise<void> {
  const excess = await horizontalOverflow(page);
  if (excess <= 0) return;
  const wide = await evaluateStrings(
    page,
    `Array.from(document.querySelectorAll('body *'))
      .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
      .slice(0, 8)
      .map((element) => element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + '.' + String(element.className).split(' ').join('.') + ' ends at ' + Math.round(element.getBoundingClientRect().right))`,
  );
  assert.fail(`${what} scrolls sideways by ${String(excess)} px; the elements that stick out: ${wide.join('; ')}`);
}

/** What has to hold on every screen of a phone. */
async function assertPhoneScreen(page: Page, what: string): Promise<void> {
  await assertFits(page, what);
  assert.deepEqual(await tooSmall(page), [], `${what}: controls drawn lower than 44 px`);
  assert.deepEqual(await a11yViolations(page), [], `${what}: accessibility`);
}

/** Opens every closed disclosure on the page by touch, so that what is hidden by default is checked as well. */
async function openDisclosures(page: Page): Promise<void> {
  const closed = page.locator('main details:not([open]) > summary');
  for (let attempt = 0; attempt < 25 && (await closed.count()) > 0; attempt += 1) await tapOn(closed.first());
  await eventuallyEquals('what the disclosures load to be shown', () => page.locator('main p.loading').count(), 0);
}

describe('the console on a phone: touch, layout and reflow', () => {
  step('the screen is a touch screen of the size the layout is designed for, and the sign-in screen fits it', async () => {
    const page = await need(context, 'the browser context').newPage();
    watchPage(page, 'signed-out', problems);
    await page.goto('/');
    await heading(page, 'Sign in').waitFor();
    assert.equal(await evaluate(page, `matchMedia('(pointer: coarse)').matches`), true, 'the screen reports a coarse pointer, so the touch rules apply');
    assert.equal(await evaluate(page, 'window.innerWidth'), PHONE_WIDTH);
    assert.equal(await evaluate(page, `document.querySelector('meta[name="viewport"]').getAttribute('content')`), 'width=device-width, initial-scale=1');
    await assertPhoneScreen(page, 'the sign-in screen');
    await page.close();
  });

  step('the checks used on the phone catch a page that scrolls sideways, a control that is too small and controls without a name', async () => {
    const page = await need(context, 'the browser context').newPage();
    watchPage(page, 'instruments', problems);
    await page.goto('/');
    await heading(page, 'Sign in').waitFor();
    await assertPhoneScreen(page, 'the sign-in screen before anything is added');

    await evaluate(
      page,
      `(() => { const bar = document.createElement('div'); bar.id = 'probe-wide'; bar.style.width = '900px'; bar.style.height = '4px'; document.body.append(bar); return true; })()`,
    );
    await assert.rejects(() => assertFits(page, 'the page with a wide element'), /scrolls sideways by \d+ px.*div#probe-wide/s);
    await evaluate(page, `(document.getElementById('probe-wide').remove(), true)`);
    await assertFits(page, 'the page once the wide element is removed');

    await evaluate(
      page,
      `(() => { const small = document.createElement('button'); small.id = 'probe-small'; small.textContent = 'Tiny'; small.style.minHeight = '0'; small.style.height = '20px'; document.body.append(small); return true; })()`,
    );
    const small = await tooSmall(page);
    assert.equal(small.length, 1, `exactly the small button is reported: ${JSON.stringify(small)}`);
    assert.match(small[0] ?? '', /^button "Tiny" is [\d.]+ px high$/);
    await evaluate(page, `(document.getElementById('probe-small').remove(), true)`);
    assert.deepEqual(await tooSmall(page), [], 'nothing is reported once the small button is removed');

    await evaluate(
      page,
      `(() => {
        const add = (tag, id, text) => { const element = document.createElement(tag); element.id = id; element.textContent = text; document.body.append(element); };
        add('h1', 'probe-title', 'A second title');
        add('input', 'probe-input', '');
        add('button', 'probe-button', '');
        add('a', 'probe-link', '');
        add('p', 'probe-twin', 'one');
        add('p', 'probe-twin', 'two');
        return true;
      })()`,
    );
    assert.deepEqual(await a11yViolations(page), [
      'expected one h1, found 2',
      'unlabelled input probe-input',
      'a button has no accessible name',
      'a link has no accessible name',
      'duplicate id probe-twin',
    ]);
    await page.close();
  });

  step('a representative opens a dispute by touch and the proposal is shown', async () => {
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.representative, undefined, tapOn);
    representativePage = page;
    await openDisputeForm(page, tapOn);
    await fillDispute(page, KESTREL, tapOn);
    await assertPhoneScreen(page, 'the new dispute form, filled in');

    caseId = await submitDispute(page, tapOn);
    await awaitStatus(page, 'Awaiting approval');
    assert.equal(await textOf(panel(page, 'Proposal').locator('p.amount')), 'USD 49.00 (a simulated credit)');
    await openDisclosures(page);
    await assertPhoneScreen(page, 'a dispute waiting for approval, as its representative sees it');
  });

  step('an approver finds the dispute in the list, approves it by touch, and the credit is shown', async () => {
    const id = need(caseId, 'the case');
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.approver, undefined, tapOn);
    approverPage = page;
    await tapOn(page.getByRole('link', { name: caseHeading(id), exact: true }));
    await heading(page, caseHeading(id)).waitFor();
    await awaitStatus(page, 'Awaiting approval');

    const decision = panel(page, 'Your decision');
    const approve = decision.getByRole('button', { name: 'Approve proposal', exact: true });
    await approve.waitFor();
    await openDisclosures(page);
    await assertPhoneScreen(page, 'a dispute waiting for a decision, with the decision forms');

    await tapOn(approve);
    const done = messages(page).locator('.banner-success');
    await done.waitFor();
    assert.equal(await textOf(done), 'Approved. The simulated credit is being issued.');
    await awaitStatus(page, 'Credited (simulated)', 60_000);

    const credit = await textOf(panel(page, 'Credit'));
    assert.match(credit, /USD 49\.00 credited for proposal version 1\. No real money moved\./);
    const credits = await creditsOf(id);
    assert.equal(credits.length, 1, 'the simulated provider holds exactly one credit for the case');
    const [issued] = credits;
    assert.deepEqual(issued?.amount, { amountMinor: 4900, currency: 'USD' });
    assert.ok(credit.includes(issued?.reference ?? 'no reference'), 'the page shows the provider reference the provider holds');
    await openDisclosures(page);
    await assertPhoneScreen(page, 'a credited dispute');
  });

  step(
    'the list pages by touch',
    async () => {
      const page = need(representativePage, 'the representative page');
      const have = (await casePages(representative, 50)).flat().length;
      for (let index = 0; index < WANTED_DISPUTES - have; index += 1) await createCase(representative, newKey(`e2e-phone-${String(index)}`));
      const ordered = (await casePages(representative, 50)).flat().map((item) => item.caseId);
      assert.ok(ordered.length >= WANTED_DISPUTES && ordered.length <= 50, `between ${String(WANTED_DISPUTES)} and 50 disputes, found ${String(ordered.length)}`);

      await tapOn(primaryNav(page).getByRole('link', { name: 'Cases', exact: true }));
      await heading(page, 'Cases').waitFor();
      await page.getByLabel('Per page', { exact: true }).selectOption(String(PAGE_OF_FIVE));
      await eventuallyEquals('the first five disputes', () => listedCaseIds(page), ordered.slice(0, PAGE_OF_FIVE));
      await assertPhoneScreen(page, 'the case list');

      await tapOn(page.locator('.more-region').getByRole('button', { name: 'Load more', exact: true }));
      const next = Math.min(2 * PAGE_OF_FIVE, ordered.length);
      await eventuallyEquals('the next disputes', () => listedCaseIds(page), ordered.slice(0, next));
      await assertPhoneScreen(page, 'the case list after loading more');

      // The disputes opened above are still being investigated; leave the stack quiet for whatever runs next.
      await waitFor(
        'every dispute to have been investigated',
        async () => {
          const all = (await casePages(representative, 50)).flat();
          return all.some((item) => item.status === 'queued' || item.status === 'investigating') ? undefined : all;
        },
        { timeoutMs: 120_000, intervalMs: 1_000 },
      );
    },
    240_000,
  );

  step('an operator finds the completed work by touch', async () => {
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.operator, undefined, tapOn);
    await tapOn(primaryNav(page).getByRole('link', { name: 'Operator recovery', exact: true }));
    await heading(page, 'Operator recovery').waitFor();
    await page.getByLabel('Work state', { exact: true }).selectOption({ label: 'Completed' });
    await page.locator('ul.cards li.card.work-item').first().waitFor();
    await openDisclosures(page);
    await assertPhoneScreen(page, 'operator recovery, with completed work');

    await page.setViewportSize(NARROWEST);
    await assertFits(page, 'operator recovery at 320 px');
    await page.close();
  });

  step('the dispute screens reflow at 320 px', async () => {
    const credited = need(approverPage, 'the approver page');
    await credited.setViewportSize(NARROWEST);
    await assertFits(credited, 'a credited dispute at 320 px');
    await credited.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });

    const form = need(representativePage, 'the representative page');
    await form.setViewportSize(NARROWEST);
    await openDisputeForm(form, tapOn);
    await fillDispute(form, KESTREL, tapOn);
    await assertFits(form, 'the new dispute form at 320 px');
    await form.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });
  });

  step('the browser reported no unexpected errors', () => {
    assertNoProblems(problems);
  });
});
