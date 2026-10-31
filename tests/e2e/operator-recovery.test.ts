import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import type { Browser, BrowserContext, Locator, Page, Request as BrowserRequest } from 'playwright-core';
import type { Api } from '../support/api.ts';
import {
  a11yViolations,
  announced,
  assertNoProblems,
  awaitStatus,
  caseHeading,
  consoleUrl,
  eventuallyEquals,
  factOf,
  fieldErrorOf,
  focused,
  goTo,
  heading,
  isRecord,
  launchBrowser,
  loadAll,
  loadWholeTimeline,
  messages,
  need,
  newContext,
  openAs,
  openCase,
  panel,
  PERSONA,
  primaryNav,
  steps,
  textOf,
  usageOf,
  type BrowserProblem,
} from '../support/browser.ts';
import { DUPLICATE, newKey, operator, representative } from '../support/case-flow.ts';
import { restartHost } from '../support/control.ts';
import { creditFlow, expectOk, type Run, type WorkItem } from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';
import { sleep } from '../support/wait.ts';

/**
 * A run that spent its allowance, recovered by an operator through the console and then decided by an approver.
 *
 * The host is restarted with a step limit of three, so the investigation of one dispute stops before it can finish and
 * the case needs attention. An operator finds the stopped run, is refused for an allowance that would not let it
 * continue, resumes it with one that does, and an approver then approves the proposal the resumed run made. The
 * service is read directly to compare what the page shows with what was recorded, to prove that a resume issues no
 * credit and that approval issues exactly one, and to prove that the recorded calls survive the resume.
 *
 * The steps depend on each other, so they run in order and share the case they are about. The host goes back to its
 * normal limits when the file is done, and the only case made while the small limit holds is the one this file uses.
 */

const STEP_LIMIT = 3;
const RUN_ID = 'run-1';
const REASON_TEXT = 'Fictional recovery reason: the first allowance was too small for this dispute.';
const ALLOWANCE_LABELS = ['Steps', 'Tool calls', 'Model calls', 'Tokens', 'Cost (micro-USD)', 'Active time (milliseconds)'];

/** The calls the demo investigator makes for a dispute that cites two invoices: three spend the first allowance. */
const CALLS_BEFORE: readonly string[] = ['get_account', 'get_policy', 'get_invoice'];
/** The resumed run plays its plan again with the counters carried over, so the first three calls stay and five follow. */
const CALLS_AFTER: readonly string[] = [...CALLS_BEFORE, 'get_account', 'get_policy', 'get_invoice', 'get_invoice', 'submit_proposal'];

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
const problems: BrowserProblem[] = [];

let representativePage: Page | undefined;
let operatorPage: Page | undefined;
let caseId: string | undefined;
let workId: string | undefined;
let callsListedBefore: string[] | undefined;

const flow = creditFlow(() => ({ stack, api, cosmos }));
const { allWork, awaitCase, awaitCompletedOutbox, createCase, creditsOf, inspect, timelineOf, usagePages, workIdOf } = flow;
const step = steps(() => need(context, 'the browser context'));

async function runOf(id: string): Promise<Run> {
  const { data, response } = await api.client(representative).GET('/cases/{caseId}/runs/{runId}', { params: { path: { caseId: id, runId: RUN_ID } } });
  assert.equal(response.status, 200);
  assert.ok(data);
  return data;
}

// The hooks of a file start together, so the restart and the case that needs it share one.
before(
  async () => {
    stack = readStackConnection();
    api = connectApi(stack);
    cosmos = openEmulator(stack);
    await restartHost(process.env, undefined, { settings: { RESOLVE_LIMIT_RUN_STEPS: String(STEP_LIMIT) } });

    const { accepted } = await createCase(representative, newKey('e2e-recover'), DUPLICATE);
    const id = accepted.case.caseId;
    const { limits } = await runOf(id);
    assert.equal(limits.steps, STEP_LIMIT, `the restarted host did not give the new run its step limit (limits ${JSON.stringify(limits)})`);
    await awaitCase(representative, id, 'needs_attention', 150_000);
    await awaitCompletedOutbox(id);
    caseId = id;
    workId = workIdOf(id, RUN_ID);

    browser = await launchBrowser();
    context = await newContext(browser, 'desktop', consoleUrl(stack.apiUrl));
  },
  { timeout: 600_000 },
);

after(
  async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await restartHost(process.env, undefined, { settings: {} });
      } finally {
        cosmos?.dispose();
      }
    }
  },
  { timeout: 360_000 },
);

const shortOf = (id: string): string => id.slice(0, 13);

/** What the page calls each kind of work, written out here so a change to the page's wording is caught. */
function kindLabel(kind: WorkItem['kind']): string {
  switch (kind) {
    case 'proposal_approval':
      return 'Proposal approval';
    case 'investigation_run':
      return 'Investigation run';
    case 'outbox':
      return 'Background work';
  }
}

/** The card of one work item, found by the work id it shows. */
const workCard = (page: Page, id: string): Locator => page.locator('li.work-item').filter({ has: page.getByText(id, { exact: true }) });

/** Runs an action and returns what it returned with the recovery requests the page sent while it ran and just after. */
async function recording<T>(page: Page, action: () => Promise<T>): Promise<{ readonly sent: readonly string[]; readonly result: T }> {
  const sent: string[] = [];
  const onRequest = (request: BrowserRequest): void => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/recover')) sent.push(request.url());
  };
  page.on('request', onRequest);
  try {
    const result = await action();
    // A second request from the same press would come moments later.
    await sleep(300);
    return { sent, result };
  } finally {
    page.off('request', onRequest);
  }
}

/** Presses the submit button and reads the recovery request it sent and the answer to it. */
async function submitRecovery(page: Page, submit: Locator) {
  const { sent, result } = await recording(page, async () => {
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => candidate.request().method() === 'POST' && new URL(candidate.url()).pathname.endsWith('/recover')),
      submit.click(),
    ]);
    return response;
  });
  const sentBody: unknown = result.request().postDataJSON();
  const body: unknown = await result.json();
  return { requests: sent.length, status: result.status(), sentBody, body, correlationHeader: result.headers()['x-correlation-id'] };
}

/** The details a timeline entry shows, by their names. */
async function detailsOf(entry: Locator): Promise<Record<string, string>> {
  const rows = entry.locator('dl.timeline-data > div');
  const names = await rows.locator('dt').allInnerTexts();
  const values = await rows.locator('dd').allInnerTexts();
  assert.equal(values.length, names.length, 'every detail has a value');
  return Object.fromEntries(names.map((name, index): [string, string] => [name.trim(), (values[index] ?? '').trim()]));
}

/** The timeline entry that says the run was resumed. */
const resumedEntry = (page: Page): Locator =>
  panel(page, 'Timeline')
    .locator('li.timeline-item')
    .filter({ has: page.locator('strong', { hasText: /^Investigation resumed$/ }) });

describe('operator recovery in the browser: a run stopped at its allowance is resumed, then decided', () => {
  step('a representative sees why the case stopped and that only an operator can recover it', async () => {
    const id = need(caseId, 'the case');
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.representative);
    representativePage = page;
    assert.deepEqual(await primaryNav(page).getByRole('link').allInnerTexts(), ['Cases', 'New dispute'], 'a representative is not offered operator recovery');

    const stopped = await runOf(id);
    assert.equal(stopped.state, 'budget_exhausted');
    assert.equal(stopped.stopReason, 'steps_exhausted');
    assert.equal(stopped.allowanceGrants, 0);

    await openCase(page, id);
    await awaitStatus(page, 'Needs attention');
    const attention = page.locator('div.banner-warning').filter({ hasText: 'This case needs attention' });
    assert.equal(
      await textOf(attention),
      'This case needs attention The run used its step allowance. An operator can recover it. Recovery keeps the recorded usage and any credit that was already issued.',
    );
    const runPanel = panel(page, 'Investigation run');
    assert.equal(await textOf(runPanel.locator('p.stop-reason')), 'The run used its step allowance.');
    assert.equal(await textOf(runPanel.locator('p.status-line strong')), 'Stopped: allowance used');
    assert.equal(await textOf(factOf(runPanel, 'Allowances granted')), '0');
    await eventuallyEquals(
      'the usage the first allowance bought',
      async () => {
        const usage = await usageOf(runPanel);
        return { steps: usage['Steps'], toolCalls: usage['Tool calls'] };
      },
      { steps: '3 of 3', toolCalls: '3 of 12' },
    );

    const calls = page.locator('details.usage-events');
    await calls.locator('summary').click();
    const entries = calls.locator('li.timeline-item');
    await eventuallyEquals('the three calls of the stopped run', () => entries.count(), CALLS_BEFORE.length);
    assert.deepEqual(
      await calls.locator('li.timeline-item strong').allInnerTexts(),
      CALLS_BEFORE.map((name) => `Tool call: ${name}`),
    );
    callsListedBefore = await entries.allInnerTexts();

    await goTo(page, '#/operator');
    await heading(page, 'Operator recovery').waitFor();
    assert.equal(
      await textOf(page.locator('div.banner-warning').filter({ hasText: 'Only operators' })),
      'Only operators can inspect and recover work. Your roles do not include Operator.',
    );
    assert.equal(await page.getByLabel('Work state', { exact: true }).count(), 0, 'no work is listed for someone who is not an operator');
  });

  step('an operator follows the case to its recovery work and sees what the service says about it', async () => {
    const id = need(caseId, 'the case');
    const work = need(workId, 'the work item');
    const page = await openAs(need(context, 'the browser context'), problems, PERSONA.operator);
    operatorPage = page;
    assert.deepEqual(await primaryNav(page).getByRole('link').allInnerTexts(), ['Cases', 'Operator recovery']);

    await openCase(page, id);
    await awaitStatus(page, 'Needs attention');
    const attention = page.locator('div.banner-warning').filter({ hasText: 'This case needs attention' });
    assert.equal(await textOf(attention), 'This case needs attention The run used its step allowance. Open operator recovery');
    await attention.getByRole('link', { name: 'Open operator recovery', exact: true }).click();
    await heading(page, 'Operator recovery').waitFor();
    assert.equal(new URL(page.url()).hash, '#/operator');

    const state = page.getByLabel('Work state', { exact: true });
    assert.equal(await state.inputValue(), 'failed', 'the list opens on failed work');
    assert.deepEqual(await allWork(operator, 'failed'), [], 'nothing has failed, so there is nothing to show');
    assert.equal(await textOf(page.locator('p.empty')), 'There is no work in the “Failed” state.');

    await state.selectOption({ label: 'Allowance used' });
    const card = workCard(page, work);
    await card.waitFor();

    const item = expectOk(await inspect(operator, work), 200);
    assert.equal(item.kind, 'investigation_run');
    assert.equal(item.state, 'budget_exhausted');
    assert.deepEqual(item.actions, ['resume']);
    assert.equal(item.claimedUntil, null);
    assert.ok(item.summary.includes('0 of 2 resume grants used'), item.summary);
    const lastError = need(item.lastError ?? undefined, 'the error the service recorded for the stopped run');
    assert.equal(lastError.code, 'steps_exhausted');
    const usage = need(item.usage ?? undefined, 'the usage the service recorded for the run');
    assert.deepEqual([usage.steps, usage.toolCalls], [3, 3]);

    const short = shortOf(id);
    assert.equal(await textOf(card.locator('h2.card-title')), `Investigation run for case ${short}`);
    assert.equal(await textOf(card.locator('span.badge')), 'Allowance used');
    assert.equal(await textOf(card.locator('p.work-summary')), item.summary);
    assert.equal(await textOf(factOf(card, 'Case')), short);
    assert.equal(await textOf(factOf(card, 'Attempts')), String(item.attempts));
    assert.equal(await textOf(factOf(card, 'Last error')), `${lastError.code}: ${lastError.message}`);
    assert.equal(await textOf(factOf(card, 'Claimed until')), 'not claimed');
    assert.equal(await textOf(factOf(card, 'Work id')), work);

    const recorded = card.locator('details.usage-details');
    await recorded.locator('summary', { hasText: 'Usage recorded so far' }).click();
    assert.equal(await textOf(factOf(recorded, 'Steps')), String(usage.steps));
    assert.equal(await textOf(factOf(recorded, 'Tool calls')), String(usage.toolCalls));

    const actions = card.locator('div.work-actions button');
    assert.equal(await actions.count(), 1, 'a stopped run offers exactly one way to recover');
    assert.equal(await textOf(actions), 'Resume with an allowance');
    assert.equal(await actions.getAttribute('aria-label'), `Resume with an allowance for the investigation run of case ${short}`);
    assert.deepEqual(await a11yViolations(page), []);
  });

  step('the form refuses what cannot be valid before sending it, gives focus back on Cancel, and shows the service its refusal', async () => {
    const id = need(caseId, 'the case');
    const work = need(workId, 'the work item');
    const page = need(operatorPage, 'the operator page');
    const card = workCard(page, work);
    const opener = card.locator('div.work-actions button');
    const form = card.locator('form.recover-form');
    const reason = form.getByLabel('Reason', { exact: true });
    const stepsInput = form.getByLabel('Steps', { exact: true });
    const submit = form.getByRole('button', { name: 'Resume run', exact: true });
    const allowanceError = form.locator('fieldset.allowance > p.field-error');

    await opener.click();
    await form.waitFor();
    assert.equal(await textOf(form.locator('h3')), 'Resume this run with an allowance');
    assert.equal(await textOf(form.locator('fieldset.allowance legend')), 'Allowance to grant');
    for (const label of ALLOWANCE_LABELS) assert.equal(await form.getByLabel(label, { exact: true }).count(), 1, `the form asks for ${label}`);
    const reasonId = await reason.getAttribute('id');
    assert.ok(reasonId, 'the reason field has an id');
    const opened = await focused(page);
    assert.deepEqual({ tag: opened.tag, id: opened.id }, { tag: 'textarea', id: reasonId }, 'opening the form puts the cursor in the reason');

    const empty = await recording(page, () => submit.click());
    assert.equal(empty.sent.length, 0, 'an empty form sends nothing');
    assert.equal(await textOf(await fieldErrorOf(page, reason)), 'Error: A reason is required.');
    assert.equal(await textOf(allowanceError), 'Error: A resume must grant at least one allowance. Nothing is reset and usage history is kept.');
    await eventuallyEquals('the count of what needs attention', () => announced(page), '2 fields need attention.');
    assert.equal((await focused(page)).id, reasonId, 'focus goes to the first field that needs attention');

    await reason.fill(REASON_TEXT);
    await stepsInput.fill('9');
    const tooMany = await recording(page, () => submit.click());
    assert.equal(tooMany.sent.length, 0, 'a number outside the allowed range sends nothing');
    assert.equal(await textOf(await fieldErrorOf(page, stepsInput)), 'Error: Enter a whole number from 1 to 8, or leave it empty.');
    assert.equal(await stepsInput.getAttribute('aria-invalid'), 'true');
    assert.equal(await reason.getAttribute('aria-invalid'), null, 'a reason that is now fine is no longer marked invalid');
    assert.ok(await (await fieldErrorOf(page, reason)).isHidden(), 'the reason error went away');
    assert.ok(await allowanceError.isHidden(), 'a number that was entered is not also called missing');
    await eventuallyEquals('the count of what needs attention', () => announced(page), '1 field needs attention.');
    assert.equal((await focused(page)).id, await stepsInput.getAttribute('id'), 'focus goes to the number that needs fixing');
    assert.deepEqual(await a11yViolations(page), [], 'the form with an error shown is accessible');

    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await form.waitFor({ state: 'detached' });
    const back = await focused(page);
    assert.deepEqual({ tag: back.tag, text: back.text }, { tag: 'button', text: 'Resume with an allowance' }, 'Cancel puts the cursor back on the button that opened the form');

    await opener.click();
    await form.waitFor();
    assert.equal(await reason.inputValue(), '', 'a form that was cancelled does not keep what was typed in it');
    await reason.fill(REASON_TEXT);
    await form.getByLabel('Tokens', { exact: true }).fill('100');
    const refused = await submitRecovery(page, submit);
    assert.equal(refused.requests, 1, 'the form sent one request');
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.sentBody, { action: 'resume', reason: REASON_TEXT, allowance: { tokens: 100 } });
    const problem = refused.body;
    assert.ok(isRecord(problem), 'the refusal is a problem document');
    assert.equal(problem['code'], 'allowance_does_not_cover_stop', 'tokens do not lift a step limit');
    const correlationId = problem['correlationId'];
    assert.equal(typeof correlationId, 'string');
    assert.equal(refused.correlationHeader, correlationId, 'the header and the body name the same request');

    const banner = messages(page).locator('.banner-error');
    await banner.waitFor();
    assert.equal(await textOf(banner.locator('p.meta')), `Code allowance_does_not_cover_stop · HTTP 409 · Correlation id ${String(correlationId)}`);
    await eventuallyEquals('focus on the area that says what happened', async () => (await focused(page)).className, 'messages');
    await eventuallyEquals('the list read again without the form', () => form.count(), 0);
    await eventuallyEquals('the work item listed again', () => card.count(), 1);
    assert.equal(await banner.count(), 1, 'the refusal stays on the page while the list is read again');
    assert.ok((await textOf(card.locator('p.work-summary'))).includes('0 of 2 resume grants used'));

    assert.equal(expectOk(await inspect(operator, work), 200).state, 'budget_exhausted');
    assert.equal((await runOf(id)).allowanceGrants, 0, 'a refused resume granted nothing');
    assert.equal((await timelineOf(representative, id)).filter((entry) => entry.kind === 'run_resumed').length, 0, 'and recorded nothing');
  });

  step('a valid resume is sent once, accepted, and says what it recorded', async () => {
    const id = need(caseId, 'the case');
    const work = need(workId, 'the work item');
    const page = need(operatorPage, 'the operator page');
    const card = workCard(page, work);
    const form = card.locator('form.recover-form');

    await card.locator('div.work-actions button').click();
    await form.waitFor();
    await form.getByLabel('Reason', { exact: true }).fill(REASON_TEXT);
    await form.getByLabel('Steps', { exact: true }).fill('8');
    const accepted = await submitRecovery(page, form.getByRole('button', { name: 'Resume run', exact: true }));
    assert.equal(accepted.requests, 1, 'the form sent one request');
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.sentBody, { action: 'resume', reason: REASON_TEXT, allowance: { steps: 8 } });
    assert.deepEqual(accepted.body, { workId: work, action: 'resume', state: 'budget_exhausted', grantNumber: 1 });

    const done = messages(page).locator('.banner-success');
    await done.waitFor();
    assert.equal(
      await textOf(done),
      `Resume accepted The investigation run for case ${shortOf(id)} was “Allowance used” when the request was accepted. Allowance grant 1 of 2 was recorded. Recorded usage and any credit already issued were kept. Open the case to follow it.`,
    );
    await eventuallyEquals('the resumed run has left the list of work that used its allowance', () => card.count(), 0);
    assert.equal(await done.count(), 1, 'the confirmation stays while the list is read again');
    assert.ok(!(await allWork(operator, 'budget_exhausted')).some((item) => item.workId === work), 'the service no longer lists it as out of allowance');
  });

  step(
    'the case the confirmation links to runs on to approval and keeps every call it already made',
    async () => {
      const id = need(caseId, 'the case');
      const page = need(operatorPage, 'the operator page');
      await messages(page).getByRole('link', { name: 'Open the case', exact: true }).click();
      await heading(page, caseHeading(id)).waitFor();
      await awaitStatus(page, 'Awaiting approval');

      const runPanel = panel(page, 'Investigation run');
      await eventuallyEquals(
        'the usage after the resume',
        async () => {
          const usage = await usageOf(runPanel);
          return { steps: usage['Steps'], toolCalls: usage['Tool calls'], granted: await textOf(factOf(runPanel, 'Allowances granted')) };
        },
        { steps: '8 of 11', toolCalls: '8 of 12', granted: '1' },
      );
      const current = await runOf(id);
      assert.equal(current.allowanceGrants, 1);
      assert.deepEqual({ steps: current.usage.steps, toolCalls: current.usage.toolCalls, stepLimit: current.limits.steps }, { steps: 8, toolCalls: 8, stepLimit: 11 });

      const calls = page.locator('details.usage-events');
      await calls.locator('summary').click();
      const entries = calls.locator('li.timeline-item');
      await eventuallyEquals('every call of the run', () => entries.count(), CALLS_AFTER.length, 30_000);
      const recorded = (await usagePages(representative, id, RUN_ID, 20)).flat();
      assert.deepEqual(
        recorded.map((event) => event.name),
        CALLS_AFTER,
      );
      assert.deepEqual(
        recorded.map((event) => event.seq),
        [1, 2, 3, 4, 5, 6, 7, 8],
      );
      assert.deepEqual(
        await calls.locator('.timeline-seq').allInnerTexts(),
        recorded.map((event) => `#${String(event.seq)}`),
      );
      assert.deepEqual(
        await calls.locator('li.timeline-item strong').allInnerTexts(),
        recorded.map((event) => `Tool call: ${event.name}`),
      );
      for (const text of await entries.allInnerTexts()) assert.match(text, /Outcome\s+Succeeded/);

      await loadWholeTimeline(page);
      const resumed = resumedEntry(page);
      assert.equal(await resumed.count(), 1, 'the resume is on the timeline once');
      assert.equal(await textOf(resumed.locator('p.timeline-summary')), 'Run run-1 resumed with allowance grant 1 of 2.');
      assert.equal(await textOf(resumed.locator('p.timeline-by')), 'By you');
      const entry = need(
        (await timelineOf(representative, id)).find((item) => item.kind === 'run_resumed'),
        'the resume entry the service recorded',
      );
      assert.equal(entry.actor.type, 'user');
      assert.deepEqual(entry.data, { runId: RUN_ID, grant: 1, reason: REASON_TEXT, grantedSteps: 8 });
      assert.deepEqual(await detailsOf(resumed), { runId: RUN_ID, grant: '1', reason: REASON_TEXT, grantedSteps: '8' });

      const decision = panel(page, 'Your decision');
      await decision.waitFor();
      assert.equal(
        await textOf(decision.locator('div.banner')),
        'This proposal is waiting for an Approver. Your sign-in does not have the Approver role, so you cannot decide it.',
      );
      assert.equal(await decision.getByRole('button').count(), 0, 'an operator is offered no way to decide the proposal');
      assert.equal((await creditsOf(id)).length, 0, 'the resume issued no credit');
    },
    240_000,
  );

  step(
    'an approver decides the proposal the resume produced, and exactly one simulated credit follows',
    async () => {
      const id = need(caseId, 'the case');
      const page = await openAs(need(context, 'the browser context'), problems, PERSONA.approver);
      await openCase(page, id);
      await awaitStatus(page, 'Awaiting approval');
      assert.match(await textOf(panel(page, 'Proposal').locator('p.amount')), /^USD 49\.00 \(a simulated credit\)$/);
      assert.match(await textOf(panel(page, 'Proposal')), /Policy credit-policy, version 2, clause dup-charge/);

      await panel(page, 'Your decision').getByRole('button', { name: 'Approve proposal', exact: true }).click();
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
    },
    240_000,
  );

  step('the representative sees the finished case with the earlier calls unchanged and the operator named', async () => {
    const id = need(caseId, 'the case');
    const page = need(representativePage, 'the representative page');
    await openCase(page, id);
    await awaitStatus(page, 'Credited (simulated)');

    const calls = page.locator('details.usage-events');
    await calls.locator('summary').click();
    const entries = calls.locator('li.timeline-item');
    await eventuallyEquals('every call of the run', () => entries.count(), CALLS_AFTER.length);
    assert.deepEqual(
      (await entries.allInnerTexts()).slice(0, CALLS_BEFORE.length),
      need(callsListedBefore, 'the calls listed before the resume'),
      'the calls made before the resume read as they did before it',
    );
    assert.equal(await textOf(calls.locator('p.end-note')), `${String(CALLS_AFTER.length)} calls shown. That is everything recorded so far.`);

    await loadWholeTimeline(page);
    const entry = need(
      (await timelineOf(representative, id)).find((item) => item.kind === 'run_resumed'),
      'the resume entry the service recorded',
    );
    assert.equal(await textOf(resumedEntry(page).locator('p.timeline-by')), `By user ${entry.actor.id.slice(0, 8).toLowerCase()}`);
  });

  step('finished work is listed as finished with nothing to recover, and each kind of work is named for what it is', async () => {
    const id = need(caseId, 'the case');
    const page = need(operatorPage, 'the operator page');
    const short = shortOf(id);

    await eventuallyEquals(
      'the finished background work of the case',
      async () => (await allWork(operator, 'completed')).filter((item) => item.caseId === id && item.kind === 'outbox').length,
      3,
      45_000,
    );
    const mine = (await allWork(operator, 'completed')).filter((item) => item.caseId === id);
    const background = mine.filter((item) => item.kind === 'outbox').map((item) => item.summary);
    assert.equal(background.filter((summary) => summary.startsWith('Investigation start')).length, 2, 'the first run and the resume each started once');
    assert.equal(background.filter((summary) => summary.startsWith('Credit execution')).length, 1, 'the approval queued one credit');

    await goTo(page, '#/operator');
    await heading(page, 'Operator recovery').waitFor();
    await page.getByLabel('Work state', { exact: true }).selectOption({ label: 'Completed' });
    await page.getByLabel('Per page', { exact: true }).selectOption('50');
    await loadAll(page.locator('div.more-region'));

    for (const item of mine) {
      const card = workCard(page, item.workId);
      assert.equal(await card.count(), 1, `the page lists ${item.workId} once`);
      assert.equal(await textOf(card.locator('h2.card-title')), `${kindLabel(item.kind)} for case ${short}`);
      assert.equal(await textOf(card.locator('span.badge')), 'Completed');
      assert.equal(await textOf(card.locator('p.work-summary')), item.summary);
      assert.equal(await textOf(card.locator('div.work-actions p.hint')), 'This work finished, so there is nothing to recover.');
      assert.equal(await card.locator('div.work-actions button').count(), 0, 'finished work offers no recovery');
    }
  });

  step('the browser reported no unexpected errors', () => {
    assertNoProblems(problems);
  });
});
