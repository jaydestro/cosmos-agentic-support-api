import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { Api } from '../support/api.ts';
import {
  a11yViolations, assertNoProblems, awaitStatus, consoleUrl, eventuallyEquals, heading, isRecord,
  launchBrowser, messages, need, newContext, openAs, openCase, PERSONA, steps, textOf,
  type BrowserProblem,
} from '../support/browser.ts';
import { approver, DUPLICATE, operator, representative, usd } from '../support/case-flow.ts';
import { creditFlow, creditOutboxId, expectOk, type Pending } from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
const problems: BrowserProblem[] = [];
const reason = 'Fictional operator recovery: the conflicting simulated ledger entry was removed.';
const flow = creditFlow(() => ({ stack, api, cosmos }));
const { approve, awaitingApproval, awaitWork, creditsOf, creditOf, dropFromProvider, holdCredit, recover, workIdOf } = flow;
const step = steps(() => need(context, 'the browser context'));
const cardOf = (view: Page, id: string) => view.locator('li.work-item').filter({ has: view.getByText(id, { exact: true }) });

before(async () => {
  stack = readStackConnection();
  api = connectApi(stack);
  cosmos = openEmulator(stack);
  browser = await launchBrowser();
  context = await newContext(browser, 'desktop', consoleUrl(stack.apiUrl));
  page = await openAs(context, problems, PERSONA.operator);
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    cosmos?.dispose();
  }
});

async function poison(label: string): Promise<{ pending: Pending; wrongId: string; workId: string }> {
  const pending = await awaitingApproval(representative, DUPLICATE, label);
  const wrong = await holdCredit(pending.caseId, 1, usd(100));
  expectOk(await approve(approver, pending), 202);
  const workId = workIdOf(pending.caseId, creditOutboxId());
  const work = await awaitWork(operator, 'poison', workId);
  assert.equal(work.lastError?.code, 'provider_key_conflict');
  return { pending, wrongId: wrong.id, workId };
}

async function openPoison(view: Page, workId: string): Promise<void> {
  await view.goto(`${consoleUrl(stack.apiUrl)}#/operator`);
  await heading(view, 'Operator recovery').waitFor();
  await view.getByLabel('Work state', { exact: true }).selectOption({ label: 'Poison' });
  await cardOf(view, workId).waitFor();
}

describe('operator requeue in the browser', () => {
  step('a poison credit can be repaired and requeued without another approval or a duplicate effect', async () => {
    const view = need(page, 'the operator page');
    const { pending, wrongId, workId } = await poison('e2e-requeue');
    await openPoison(view, workId);
    const card = cardOf(view, workId);
    assert.equal(await textOf(card.locator('h2')), `Background work for case ${pending.caseId.slice(0, 13)}`);
    assert.equal(await textOf(card.locator('.badge')), 'Poison');
    assert.match(await textOf(card.locator('.work-summary')), /^Credit execution/);
    assert.match(await textOf(card), /provider_key_conflict/);
    await card.getByRole('button', { name: /^Requeue for the background work/ }).click();
    const form = card.locator('form.recover-form');
    assert.equal(await textOf(form.locator('h3')), 'Requeue this work item');
    assert.equal(await form.locator('fieldset.allowance').count(), 0);
    await form.getByLabel('Reason', { exact: true }).fill(reason);
    assert.deepEqual(await a11yViolations(view), []);
    await dropFromProvider(wrongId);
    const [response] = await Promise.all([
      view.waitForResponse((candidate) => candidate.request().method() === 'POST' && new URL(candidate.url()).pathname.endsWith('/recover')),
      form.getByRole('button', { name: 'Requeue', exact: true }).click(),
    ]);
    assert.equal(response.status(), 202);
    const request: unknown = response.request().postDataJSON();
    assert.deepEqual(request, { action: 'requeue', reason });
    const accepted: unknown = await response.json();
    assert.deepEqual(accepted, { workId, action: 'requeue', state: 'poison', grantNumber: null });
    const banner = messages(view).locator('.banner-success');
    await banner.waitFor();
    assert.match(await textOf(banner), /^Requeue accepted The background work for case .* was “Poison” when the request was accepted\./);
    await eventuallyEquals('the poison work leaves the list', () => card.count(), 0);
    await banner.getByRole('link', { name: 'Open the case', exact: true }).click();
    await awaitStatus(view, 'Credited (simulated)');
    assert.deepEqual((await creditsOf(pending.caseId)).map((credit) => credit.amount), [usd(4900)]);
    const result = expectOk(await creditOf(representative, pending.caseId), 200);
    assert.equal(result.provider.reconciled, false);
  });

  step('a stale requeue form reports a conflict and refreshes instead of issuing another credit', async () => {
    const view = need(page, 'the operator page');
    const { pending, wrongId, workId } = await poison('e2e-stale-requeue');
    await openPoison(view, workId);
    const card = cardOf(view, workId);
    await card.getByRole('button', { name: /^Requeue for the background work/ }).click();
    const form = card.locator('form.recover-form');
    await form.getByLabel('Reason', { exact: true }).fill(reason);
    await dropFromProvider(wrongId);
    expectOk(await recover(operator, workId, { action: 'requeue', reason }), 202);
    await awaitWork(operator, 'completed', workId);
    const [response] = await Promise.all([
      view.waitForResponse((candidate) => candidate.request().method() === 'POST' && new URL(candidate.url()).pathname.endsWith('/recover')),
      form.getByRole('button', { name: 'Requeue', exact: true }).click(),
    ]);
    assert.equal(response.status(), 409);
    const problem: unknown = await response.json();
    assert.ok(isRecord(problem));
    assert.equal(problem['code'], 'recovery_not_applicable');
    const banner = messages(view).locator('.banner-error');
    await banner.waitFor();
    assert.match(await textOf(banner.locator('p.meta')), /^Code recovery_not_applicable · HTTP 409 · Correlation id /);
    await eventuallyEquals('stale work disappears after the conflict', () => card.count(), 0);
    await openCase(view, pending.caseId);
    await awaitStatus(view, 'Credited (simulated)');
    assert.deepEqual((await creditsOf(pending.caseId)).map((credit) => credit.amount), [usd(4900)]);
  });

  step('the browser reported no unexpected errors', () => {
    assertNoProblems(problems);
  });
});
