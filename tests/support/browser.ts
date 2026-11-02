import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { findPersona } from '../../web/src/personas.ts';
import { ROOT } from './stack.ts';
import { waitFor } from './wait.ts';

/** Failure screenshots go next to the other run diagnostics, which are not committed. */
export const SCREENSHOT_DIR = join(ROOT, '.artifacts', 'e2e');

export const PERSONA = {
  representative: 'aurora-representative',
  approver: 'aurora-approver',
  both: 'aurora-both',
  operator: 'aurora-operator',
  borealisRepresentative: 'borealis-representative',
  borealisApprover: 'borealis-approver',
} as const;

/** The console is served by the same host as the API, so the browser stays on one origin. */
export const consoleUrl = (apiUrl: string): string => `${new URL(apiUrl).origin}/`;

// Chrome is preinstalled on GitHub's Ubuntu runners; Edge ships with Windows.
const DEFAULT_CHANNELS: readonly string[] = ['chrome', 'msedge'];

/** Launches an installed Chromium-based browser. It never falls back to a silent pass: no browser means a failure. */
export async function launchBrowser(env: NodeJS.ProcessEnv = process.env): Promise<Browser> {
  const requested = env['RESOLVE_E2E_BROWSER'];
  const channels = requested === undefined || requested === '' ? DEFAULT_CHANNELS : [requested];
  const failures: string[] = [];
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: true, timeout: 60_000 });
    } catch (error) {
      failures.push(`${channel}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''}`);
    }
  }
  throw new Error(`No browser could be launched. Install Chrome or Edge, or set RESOLVE_E2E_BROWSER to a Playwright channel. ${failures.join(' | ')}`);
}

export type Form = 'desktop' | 'mobile';

export async function newContext(browser: Browser, form: Form, baseURL: string): Promise<BrowserContext> {
  const shared = { baseURL, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block' } as const;
  // Opt-in evidence: RESOLVE_E2E_VIDEO_DIR records one video per page, written when the context closes.
  const videoDir = process.env['RESOLVE_E2E_VIDEO_DIR'];
  const video = videoDir === undefined || videoDir === '' ? {} : { recordVideo: { dir: videoDir, size: form === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 } } };
  const context = await browser.newContext(
    form === 'mobile'
      ? { ...shared, ...video, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { ...shared, ...video, viewport: { width: 1280, height: 800 } },
  );
  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(30_000);
  return context;
}

export interface BrowserProblem {
  readonly page: string;
  readonly kind: 'console' | 'pageerror' | 'requestfailed' | 'status';
  readonly detail: string;
}

// An expected 4xx answer (an unknown account, a refused decision) makes the browser log this line itself.
const EXPECTED_CLIENT_ERROR = /^Failed to load resource: the server responded with a status of 4\d\d\b/;

/**
 * Collects what a person would never want to see: console errors and warnings other than expected 4xx answers,
 * uncaught exceptions, failed requests (a request the console cancelled itself when the person moved on is normal),
 * 5xx answers, and any answer that says the sign-in does not work (401, 403).
 */
export function watchPage(page: Page, label: string, problems: BrowserProblem[]): void {
  const note = (kind: BrowserProblem['kind'], detail: string): void => {
    problems.push({ page: label, kind, detail: `${detail} (page at ${page.url()})` });
  };
  page.on('console', (message) => {
    const type = message.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = message.text();
    if (EXPECTED_CLIENT_ERROR.test(text)) return;
    note('console', `${type}: ${text}`);
  });
  page.on('pageerror', (error) => {
    note('pageerror', error.message);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'unknown failure';
    if (failure === 'net::ERR_ABORTED') return;
    note('requestfailed', `${request.method()} ${request.url()}: ${failure}`);
  });
  page.on('response', (response) => {
    const status = response.status();
    if (status >= 500 || status === 401 || status === 403) note('status', `${String(status)} ${response.request().method()} ${response.url()}`);
  });
}

export function assertNoProblems(problems: readonly BrowserProblem[]): void {
  assert.deepEqual(
    problems.map((problem) => `${problem.page}: ${problem.kind}: ${problem.detail}`),
    [],
    'the browser reported errors',
  );
}

export const primaryNav = (page: Page): Locator => page.getByRole('navigation', { name: 'Primary', exact: true });

export const heading = (page: Page, name: string): Locator => page.getByRole('heading', { level: 1, name, exact: true });

/** A panel of the case page: a `section` named by its `h2`. */
export const panel = (page: Page, title: string): Locator => page.getByRole('region', { name: title, exact: true });

export type Press = (locator: Locator) => Promise<void>;

/** A click, or a tap on a touch screen. */
export const clickOn: Press = (locator) => locator.click();
export const tapOn: Press = (locator) => locator.tap();

/**
 * Signs in as a test persona on a new page of the context and waits for the signed-in shell. `prepare` runs before
 * the page is first loaded, for what has to be in place by then, such as a route. `press` is how the sign-in button
 * is operated: a click, or a tap on a touch screen.
 */
export async function openAs(
  context: BrowserContext,
  problems: BrowserProblem[],
  personaId: string,
  prepare?: (page: Page) => Promise<void>,
  press: Press = clickOn,
): Promise<Page> {
  const persona = findPersona(personaId);
  assert.ok(persona, `unknown persona ${personaId}`);
  const page = await context.newPage();
  watchPage(page, personaId, problems);
  await prepare?.(page);
  await page.goto('/');
  await press(page.getByRole('button', { name: `Sign in as ${persona.label}`, exact: true }));
  await primaryNav(page).waitFor();
  return page;
}

/** Evaluates a string expression in the page. The test code has no DOM types, so it never passes a function. */
export async function evaluate(page: Page, expression: string): Promise<unknown> {
  const value: unknown = await page.evaluate(expression);
  return value;
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** A value that an earlier step was to leave behind. */
export function need<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, `${what} is missing because an earlier step did not complete`);
  return value;
}

/** The message a control points at as its error. */
export async function fieldErrorOf(page: Page, control: Locator): Promise<Locator> {
  const describedBy = (await control.getAttribute('aria-describedby')) ?? '';
  const id = describedBy.split(/\s+/).find((part) => part.endsWith('-error'));
  assert.ok(id, `the control names its error message (aria-describedby is "${describedBy}")`);
  return page.locator(`[id="${id}"]`);
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

export async function evaluateStrings(page: Page, expression: string): Promise<string[]> {
  const value = await evaluate(page, expression);
  assert.ok(isStrings(value), 'the expression returns a list of strings');
  return value;
}

export async function evaluateNumber(page: Page, expression: string): Promise<number> {
  const value = await evaluate(page, expression);
  assert.equal(typeof value, 'number', 'the expression returns a number');
  return value as number;
}

/** Moves to a route the way typing the address does: only the hash changes, which the console routes. */
export async function goTo(page: Page, hash: string): Promise<void> {
  const target = new URL(page.url());
  target.hash = hash;
  await page.goto(target.href);
}

export const caseHeading = (caseId: string): string => `Case ${caseId.slice(0, 13)}`;

export async function openCase(page: Page, caseId: string): Promise<void> {
  await goTo(page, `#/cases/${caseId}`);
  await heading(page, caseHeading(caseId)).waitFor();
}

/** The id of the case a route (the part of an address from the "#") names, if it names one. */
export const caseIdFromHash = (hash: string): string | undefined => /^#\/cases\/(case_[0-9a-f]{32})$/.exec(hash)?.[1];

/** The id of the case an address names, if it names one. */
export const caseIdOf = (url: string): string | undefined => caseIdFromHash(new URL(url).hash);

/** The ids of the cases the list shows, in the order it shows them. */
export async function listedCaseIds(page: Page): Promise<string[]> {
  const hrefs = await evaluateStrings(page, `Array.from(document.querySelectorAll('.list-region ul.cards li.card h2 a')).map((link) => link.getAttribute('href') || '')`);
  return hrefs.map((href) => need(caseIdFromHash(href), `a case id in the list link "${href}"`));
}

export function currentCaseId(page: Page): string {
  const id = caseIdOf(page.url());
  assert.ok(id, `the page is on a case, not at ${page.url()}`);
  return id;
}

export interface Focus {
  readonly tag: string;
  readonly id: string;
  readonly className: string;
  readonly text: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** What has keyboard focus right now. */
export async function focused(page: Page): Promise<Focus> {
  const value = await evaluate(
    page,
    `(() => {
      const e = document.activeElement;
      if (e === null) return null;
      return { tag: e.tagName.toLowerCase(), id: e.id, className: typeof e.className === 'string' ? e.className : '', text: (e.textContent || '').trim().slice(0, 80) };
    })()`,
  );
  assert.ok(isRecord(value), 'something has keyboard focus');
  return { tag: str(value['tag']), id: str(value['id']), className: str(value['className']), text: str(value['text']) };
}

/** Reads until the value is the expected one, and says what it last was when it never is. */
export async function eventuallyEquals<T>(description: string, read: () => Promise<T>, expected: T, timeoutMs = 20_000): Promise<void> {
  const seen: T[] = [];
  try {
    await waitFor(
      description,
      async () => {
        const value = await read();
        seen[0] = value;
        return isDeepStrictEqual(value, expected) || undefined;
      },
      { timeoutMs, intervalMs: 150 },
    );
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; expected ${JSON.stringify(expected)}, last read ${JSON.stringify(seen[0])}`, { cause: error });
  }
}

/** Reads the visible text of an element on one line. */
export async function textOf(locator: Locator): Promise<string> {
  return (await locator.innerText()).replace(/\s+/g, ' ').trim();
}

/** The accessibility problems a person using a keyboard or a screen reader would hit on the page as drawn now. */
export function a11yViolations(page: Page): Promise<string[]> {
  return evaluateStrings(
    page,
    `(() => {
      const found = [];
      const count = (selector) => document.querySelectorAll(selector).length;
      if (count('h1') !== 1) found.push('expected one h1, found ' + count('h1'));
      if (count('main') !== 1) found.push('expected one main landmark, found ' + count('main'));
      if (!document.documentElement.lang) found.push('html has no lang');
      for (const control of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
        const named = (control.labels && control.labels.length > 0) || control.getAttribute('aria-label') || control.getAttribute('aria-labelledby');
        if (!named) found.push('unlabelled ' + control.tagName.toLowerCase() + ' ' + (control.name || control.id));
      }
      for (const button of document.querySelectorAll('button')) {
        const name = (button.getAttribute('aria-label') || button.textContent || '').trim();
        if (!name) found.push('a button has no accessible name');
      }
      for (const link of document.querySelectorAll('a')) {
        const name = (link.getAttribute('aria-label') || link.textContent || '').trim();
        if (!name) found.push('a link has no accessible name');
      }
      const ids = new Set();
      for (const element of document.querySelectorAll('[id]')) {
        if (ids.has(element.id)) found.push('duplicate id ' + element.id);
        ids.add(element.id);
      }
      return found;
    })()`,
  );
}

/** Pixels by which the page is wider than the window. Anything above zero means a horizontal scroll bar. */
export const horizontalOverflow = (page: Page): Promise<number> =>
  evaluateNumber(page, 'document.documentElement.scrollWidth - document.documentElement.clientWidth');

/** Everything a person fills in on the "New dispute" form. */
export interface DisputeForm {
  readonly account: { readonly id: string; readonly name: string };
  readonly invoices: readonly string[];
  readonly category: 'Duplicate charge' | 'Incorrect amount' | 'Service outage' | 'Other';
  readonly requested?: string;
  readonly description: string;
  /** Replaces the key the form generated. */
  readonly key?: string;
}

export const KESTREL: DisputeForm = {
  account: { id: 'acct_aurora_0001', name: 'Kestrel Freight (fictional)' },
  invoices: ['inv_aurora_0001_a', 'inv_aurora_0001_b'],
  category: 'Duplicate charge',
  requested: '49.00',
  description: 'Fictional browser journey: the September invoice was charged twice.',
};

export const FJORD: DisputeForm = {
  account: { id: 'acct_borealis_0001', name: 'Fjord Robotics (fictional)' },
  invoices: ['inv_borealis_0001_a', 'inv_borealis_0001_b'],
  category: 'Duplicate charge',
  description: 'Fictional browser journey: the September invoice was charged twice.',
};

/** Opens the form from the navigation, as a person would. */
export async function openDisputeForm(page: Page, press: Press = clickOn): Promise<void> {
  await press(primaryNav(page).getByRole('link', { name: 'New dispute', exact: true }));
  await heading(page, 'New dispute').waitFor();
}

/** Chooses a seeded account from the suggestions, ticks the invoices and fills the other fields. Nothing is submitted. */
export async function fillDispute(page: Page, form: DisputeForm, press: Press = clickOn): Promise<void> {
  const hints = page.locator('details.hints');
  if ((await hints.getAttribute('open')) === null) await press(hints.locator('summary'));
  await press(page.getByRole('button', { name: `Use ${form.account.name}`, exact: true }));
  for (const invoice of form.invoices) {
    await page.getByRole('checkbox', { name: new RegExp(`\\(${invoice}\\)`) }).check();
  }
  await page.getByLabel('Category', { exact: true }).selectOption({ label: form.category });
  if (form.requested !== undefined) await page.getByLabel('Requested credit (optional)', { exact: true }).fill(form.requested);
  await page.getByLabel('What happened?', { exact: true }).fill(form.description);
  if (form.key !== undefined) await page.getByLabel('Idempotency key', { exact: true }).fill(form.key);
}

/** Submits the form and returns the id of the case the console opens. */
export async function submitDispute(page: Page, press: Press = clickOn): Promise<string> {
  await press(page.getByRole('button', { name: 'Submit dispute', exact: true }));
  // The address is read from the test, not from the page: the console's CSP does not let a page evaluate strings from a timer.
  return waitFor('the console to open the new case', () => Promise.resolve(caseIdOf(page.url())), { timeoutMs: 30_000, intervalMs: 100 });
}

/** The status badge in "Where this case stands". */
export const caseStatus = (page: Page, label: string): Locator => panel(page, 'Where this case stands').locator('.status-line').getByText(label, { exact: true });

export async function awaitStatus(page: Page, label: string, timeoutMs = 90_000): Promise<void> {
  await caseStatus(page, label).waitFor({ state: 'visible', timeout: timeoutMs });
}

/** The area where the page says what an action did. It takes focus when the action ends. */
export const messages = (page: Page): Locator => page.locator('.messages');

/** What the page has just said to a screen reader. */
export async function announced(page: Page): Promise<string> {
  return ((await page.locator('div.visually-hidden[role="status"]').textContent()) ?? '').trim();
}

/** Presses "Load more" in a list until it says that is all of it. The feeds also say "There are more." while pages remain. */
export async function loadAll(scope: Locator): Promise<void> {
  const more = scope.getByRole('button', { name: 'Load more', exact: true });
  const end = scope.locator('p.end-note');
  await waitFor(
    'every page of the list',
    async () => {
      if ((await end.count()) > 0 && /That is (everything|all of them)/.test(await end.innerText())) return true;
      if ((await more.count()) > 0) await more.click({ timeout: 2_000 });
      return undefined;
    },
    { timeoutMs: 30_000, intervalMs: 200 },
  );
}

/** Pages through the timeline of the case page until it says that is everything. */
export const loadWholeTimeline = (page: Page): Promise<void> => loadAll(panel(page, 'Timeline'));

const exactly = (text: string): RegExp => {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`);
};

/** The value a panel shows for a labelled fact, such as "Allowances granted". */
export const factOf = (scope: Locator, label: string): Locator =>
  scope
    .locator('div.fact')
    .filter({ has: scope.page().locator('dt', { hasText: exactly(label) }) })
    .locator('dd');

/** What a usage table shows for each measure, by the measure's name. */
export async function usageOf(scope: Locator): Promise<Record<string, string>> {
  const rows = scope.locator('table.usage tbody tr');
  const labels = await rows.locator('th').allInnerTexts();
  const values = await rows.locator('td:nth-child(2)').allInnerTexts();
  assert.equal(values.length, labels.length, 'every measure has a value');
  return Object.fromEntries(labels.map((label, index): [string, string] => [label.trim(), (values[index] ?? '').trim()]));
}

async function capture(context: BrowserContext, name: string): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const slug = name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
  for (const [index, page] of context.pages().entries()) {
    await page.screenshot({ path: join(SCREENSHOT_DIR, `${slug}-${String(index + 1)}.png`), fullPage: true, timeout: 10_000 });
  }
}

/** Runs a step and, if it fails, keeps a screenshot of every open page before the failure is reported. */
export async function guard(context: BrowserContext, name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    await capture(context, name).catch(() => undefined);
    throw error;
  }
  // Opt-in evidence: RESOLVE_E2E_CAPTURE_DIR keeps a screenshot after every passing step.
  const keep = process.env['RESOLVE_E2E_CAPTURE_DIR'];
  if (keep !== undefined && keep !== '') {
    mkdirSync(keep, { recursive: true });
    const slug = name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
    for (const [index, page] of context.pages().entries()) {
      await page.screenshot({ path: join(keep, `${slug}-${String(index + 1)}.png`), timeout: 10_000 }).catch(() => undefined);
    }
  }
}

/** Defines the steps of one journey. They run in order and share what the test file keeps in variables. */
export function steps(context: () => BrowserContext): (name: string, body: () => void | Promise<void>, timeoutMs?: number) => void {
  return (name, body, timeoutMs = 120_000) => {
    it(name, { timeout: timeoutMs }, () => guard(context(), name, body));
  };
}
