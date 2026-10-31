import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { CosmosClient } from '@azure/cosmos';
import type { Api, Identity } from '../support/api.ts';
import { BOREALIS, DUPLICATE, newKey, representative, stranger, type Paged, type Schemas } from '../support/case-flow.ts';
import { creditFlow } from '../support/credit-flow.ts';
import { connectApi, openEmulator, readStackConnection, type StackConnection } from '../support/env.ts';

/**
 * What a continuation token promises, through the real host and the Cosmos DB emulator. A token names a position in
 * a list, so a reader that keeps it can read the same page again, and a reader that reached the end of a list that
 * has grown since can carry on from the page it read last. A token carries no authority of its own.
 */

let stack: StackConnection;
let api: Api;
let cosmos: CosmosClient;

before(() => {
  stack = readStackConnection();
  api = connectApi(stack);
  cosmos = openEmulator(stack);
});

after(() => {
  cosmos.dispose();
});

const { awaitCase, awaitCompletedOutbox, awaitingApproval, createCase, credited, timelineOf } = creditFlow(() => ({ stack, api, cosmos }));

const EMBER = 'acct_aurora_0006';
const RUN = 'run-1';

const continuation = (token: string | undefined): { continuationToken?: string } => (token === undefined ? {} : { continuationToken: token });

interface Walked<T> {
  /** The token the page was requested with; undefined for the first page of a list. */
  readonly via: string | undefined;
  readonly items: T[];
  readonly next: string | null;
}

/** Reads pages one after another from `from`, remembering the token each was requested with, until the list ends or `maxPages` were read. */
async function walk<T>(fetchPage: (token: string | undefined) => Promise<Paged<T>>, maxPages: number, from?: string): Promise<Walked<T>[]> {
  const pages: Walked<T>[] = [];
  let token = from;
  do {
    const page = await fetchPage(token);
    pages.push({ via: token, items: page.items, next: page.continuationToken });
    token = page.continuationToken ?? undefined;
  } while (token !== undefined && pages.length < maxPages);
  return pages;
}

const asRead = <T>(page: Walked<T>): Paged<T> => ({ items: page.items, continuationToken: page.next });

async function invoicePage(token: string | undefined, limit: number): Promise<Paged<Schemas['Invoice']>> {
  const { data, response } = await api.client(representative).GET('/accounts/{accountId}/invoices', {
    params: { path: { accountId: EMBER }, query: { limit, ...continuation(token) } },
  });
  assert.equal(response.status, 200);
  assert.ok(data);
  return data;
}

async function casePage(who: Identity, token: string | undefined, limit: number): Promise<Paged<Schemas['CaseSummary']>> {
  const { data, response } = await api.client(who).GET('/cases', { params: { query: { limit, ...continuation(token) } } });
  assert.equal(response.status, 200);
  assert.ok(data);
  return data;
}

async function timelinePage(caseId: string, token: string | undefined, limit: number): Promise<Paged<Schemas['TimelineItem']>> {
  const { data, response } = await api
    .client(representative)
    .GET('/cases/{caseId}/timeline', { params: { path: { caseId }, query: { limit, ...continuation(token) } } });
  assert.equal(response.status, 200);
  assert.ok(data);
  return data;
}

async function usagePage(caseId: string, token: string | undefined, limit: number): Promise<Paged<Schemas['UsageEvent']>> {
  const { data, response } = await api
    .client(representative)
    .GET('/cases/{caseId}/runs/{runId}/usage', { params: { path: { caseId, runId: RUN }, query: { limit, ...continuation(token) } } });
  assert.equal(response.status, 200);
  assert.ok(data);
  return data;
}

const caseIds = (page: Paged<Schemas['CaseSummary']>): string[] => page.items.map((item) => item.caseId);

describe('using a token again', () => {
  it('returns the same invoice page every time, one after the other and all at once', async () => {
    const pages = await walk((token) => invoicePage(token, 10), 10);
    assert.deepEqual(
      pages.map((page) => page.items.length),
      [10, 10, 6],
    );
    assert.equal(pages.at(-1)?.next, null);
    for (const page of pages) {
      const reads = [await invoicePage(page.via, 10), ...(await Promise.all([invoicePage(page.via, 10), invoicePage(page.via, 10)]))];
      for (const read of reads) assert.deepEqual(read, asRead(page));
    }
  });

  it('keeps every page of the case list where it was while newer cases are submitted', async () => {
    const settled = await Promise.all(Array.from({ length: 6 }, (_, index) => awaitingApproval(representative, DUPLICATE, `page-${String(index)}`)));
    const mine = new Set(settled.map((pending) => pending.caseId));

    const read = await walk((token) => casePage(representative, token, 2), 3);
    assert.equal(read.length, 3);
    assert.deepEqual(new Set(read.flatMap((page) => caseIds(asRead(page)))), mine, 'the newest six cases of the tenant are the six that were just made');

    const newest = (await createCase(representative, newKey('page-newer'))).accepted.case.caseId;
    assert.deepEqual(caseIds(await casePage(representative, undefined, 2)).at(0), newest, 'the new case leads the list');
    for (const page of read.slice(1)) {
      assert.deepEqual(await casePage(representative, page.via, 2), asRead(page), 'a page reached by a token has not moved');
    }

    await awaitCase(representative, newest, 'awaiting_approval');
    await awaitCompletedOutbox(newest);
  });

  it('carries no authority: a token made for one tenant only ever lists the tenant of the caller', async () => {
    const foreign = (await createCase(stranger, newKey('page-foreign'), BOREALIS)).accepted.case.caseId;
    const first = (await createCase(representative, newKey('page-own-1'))).accepted.case.caseId;
    const second = (await createCase(representative, newKey('page-own-2'))).accepted.case.caseId;

    const head = await casePage(representative, undefined, 1);
    assert.deepEqual(caseIds(head), [second]);
    assert.ok(head.continuationToken, 'the list goes on after the newest case');

    const theirs = await casePage(stranger, head.continuationToken, 50);
    assert.equal(caseIds(theirs).at(0), foreign, 'the position of the token is newer than the case of the other tenant, so it leads the list');
    assert.ok(!caseIds(theirs).includes(first) && !caseIds(theirs).includes(second), 'no case of the tenant the token was made for is listed');
    for (const item of theirs.items) assert.equal(item.tenantId, stranger.tenant);

    await Promise.all([
      awaitCase(stranger, foreign, 'awaiting_approval'),
      awaitCase(representative, first, 'awaiting_approval'),
      awaitCase(representative, second, 'awaiting_approval'),
    ]);
    await Promise.all([awaitCompletedOutbox(foreign, stranger.tenant), awaitCompletedOutbox(first), awaitCompletedOutbox(second)]);
  });
});

describe('a case that is read while it grows', () => {
  it('can be carried on from the last timeline page that was read, and what was read has not changed', async () => {
    const pending = await awaitingApproval(representative, DUPLICATE, 'page-grow');
    const before = await walk((token) => timelinePage(pending.caseId, token, 3), 50);
    assert.ok(before.length >= 2, 'the timeline spans pages of three');
    const last = before.at(-1);
    assert.ok(last);
    assert.equal(last.next, null, 'the timeline had ended');
    assert.ok(last.via, 'the last page was reached by a token');
    const read = before.flatMap((page) => page.items);

    await credited(pending);

    const resumed = await timelinePage(pending.caseId, last.via, 3);
    assert.deepEqual(resumed.items.slice(0, last.items.length), last.items, 'the entries that were read are unchanged');
    assert.ok(resumed.items.length > last.items.length || resumed.continuationToken !== null, 'the timeline has grown past the end that was read');

    const rest = resumed.continuationToken === null ? [] : await walk((token) => timelinePage(pending.caseId, token, 3), 50, resumed.continuationToken);
    const carried = [...before.slice(0, -1).flatMap((page) => page.items), ...resumed.items, ...rest.flatMap((page) => page.items)];
    const whole = await timelineOf(representative, pending.caseId);
    assert.deepEqual(carried, whole, 'carrying on from the last page reads the whole timeline once');
    assert.deepEqual(whole.slice(0, read.length), read, 'what was read before the growth is still the start of the timeline');
    assert.ok(whole.length > read.length);
    assert.ok(whole.some((item) => item.kind === 'credit_executed'));
    for (let index = 1; index < whole.length; index += 1) {
      assert.ok((whole[index - 1]?.seq ?? Infinity) < (whole[index]?.seq ?? 0), `entry ${String(index)} follows its predecessor`);
    }
  });

  it('lists the calls of a finished run once each, in order, none left reserved, the same way every time', async () => {
    const { caseId } = await awaitingApproval(representative, DUPLICATE, 'page-usage');
    const { data: run, response } = await api.client(representative).GET('/cases/{caseId}/runs/{runId}', { params: { path: { caseId, runId: RUN } } });
    assert.equal(response.status, 200);
    assert.ok(run);
    assert.equal(run.state, 'completed');

    const pages = await walk((token) => usagePage(caseId, token, 2), 50);
    assert.equal(pages.at(-1)?.next, null);
    const events = pages.flatMap((page) => page.items);
    assert.ok(events.length >= 3, 'the run made enough calls to span pages of two');
    assert.equal(events.length, run.usage.toolCalls + run.usage.modelCalls, 'every call that was made is listed');
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );
    assert.equal(new Set(events.map((event) => event.eventId)).size, events.length, 'no call is listed twice');
    for (const event of events) {
      assert.equal(event.runId, RUN);
      assert.notEqual(event.outcome, 'reserved', `${event.name} was left reserved`);
    }
    for (const page of pages) {
      assert.deepEqual(await usagePage(caseId, page.via, 2), asRead(page));
    }
  });
});
