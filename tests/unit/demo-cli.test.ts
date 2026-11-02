import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CliError, parseArgs, validateBaseUrl, validateScope } from '../../tools/demo/args.ts';
import { runCli } from '../../tools/demo/cli.ts';
import { createDemoClient, apiValue } from '../../tools/demo/transport.ts';
import {
  CASE_ID, COMMON, DIGEST, KEY, NOW, decision, event, harness, json, liveCase, liveProposal, usageEvent,
} from '../demo/fixtures.ts';
import { caseDetail, creditResult, run, session } from '../support/web-fixtures.ts';

const start = ['start', ...COMMON, '--idempotency-key', KEY, '--wait-ms', '0'];
const inspect = ['inspect', ...COMMON, '--case-id', CASE_ID];
const approve = ['approve', ...COMMON, '--case-id', CASE_ID, '--version', '1', '--wait-ms', '0'];
const reject = ['reject', ...COMMON, '--case-id', CASE_ID, '--version', '1', '--reason', 'Fictional invoice requires review.'];
const mutationCount = (requests: Request[]): number => requests.filter((request) => request.method === 'POST').length;

describe('Resolve demo CLI argument validation', () => {
  it('defaults to live and preserves the caller-selected stable key', () => {
    const command = parseArgs(start);
    assert.equal(command.command, 'start');
    if (command.command !== 'start') assert.fail('Expected start');
    assert.equal(command.mode, 'live');
    assert.equal(command.idempotencyKey, KEY);
    assert.equal(command.timeoutMs, 15000);
    assert.equal(parseArgs(['start', ...COMMON, '--idempotency-key', KEY]).command, 'start');
    assert.deepEqual(parseArgs(['--help']), { command: 'help' });
  });

  it('rejects missing, duplicate, misplaced, unsafe and unknown values without echoing them', () => {
    const invalid = [
      [], ['start'], ['start', ...COMMON], [...start, '--token', 'secret'],
      [...start, '--scope', 'duplicate'], [...start, 'unexpected'],
      [...start, '--version', '1'], [...start, '--mode', 'automatic'],
      [...start, '--timeout-ms', '0'], [...start, '--timeout-ms', '60001'],
      [...start, '--timeout-ms', '1e3'], [...start, '--wait-ms', '300001'],
      [...start, '--poll-ms', '99'], [...start, '--poll-ms', '10001'],
      ['start', ...COMMON, '--idempotency-key', 'short'],
      ['start', ...COMMON, '--idempotency-key', 'x'.repeat(65)],
      ['start', ...COMMON, '--idempotency-key', 'not/a/safe/key/value'],
      ['approve', ...COMMON, '--case-id', CASE_ID],
      [...approve, '--version', '2'], [...approve, '--comment', '\nsecret'],
      ['approve', ...COMMON, '--case-id', CASE_ID, '--version', '5'],
      ['approve', ...COMMON, '--case-id', CASE_ID, '--version', '01'],
      ['inspect', ...COMMON, '--case-id', '../outside'],
      ['inspect', ...COMMON, '--case-id', `case_${'A'.repeat(32)}`],
      ['reject', ...COMMON, '--case-id', CASE_ID, '--version', '1'],
      [...reject, '--comment', 'unexpected'],
      ['reject', ...COMMON, '--case-id', CASE_ID, '--version', '1', '--reason', ' '],
      ['reject', ...COMMON, '--case-id', CASE_ID, '--version', '1', '--reason', 'x'.repeat(501)],
    ];
    for (const args of invalid) assert.throws(() => parseArgs(args), CliError);
  });

  it('accepts only explicit trusted HTTPS API roots and delegated Resolve scopes', () => {
    assert.equal(validateBaseUrl('https://resolve.test/api/'), 'https://resolve.test/api');
    for (const url of [
      'http://resolve.test/api', 'https://user:secret@resolve.test/api', 'https://resolve.test/api?token=secret',
      'https://resolve.test/api#secret', 'https://resolve.test/a/../api', 'https://resolve.test/%61pi',
      'https://resolve.test/api\\', ' https://resolve.test/api', 'https://resolve.test/other', 'https://[invalid/api',
    ]) assert.throws(() => validateBaseUrl(url), CliError);
    assert.equal(validateScope('api://fictional-app/.default'), 'api://fictional-app/.default');
    assert.equal(validateScope('https://resolve.test/.default'), 'https://resolve.test/.default');
    for (const scope of [
      'api://app/access_as_user', 'access_as_user', 'api://user:secret@app/.default',
      'api://app/.default?secret', 'api://app/a/../.default', 'https://app/%2f/.default',
      'api://app/.default another', 'http://app/.default',
    ]) assert.throws(() => validateScope(scope), CliError);
  });

  it('help and invalid arguments never acquire credentials or call the API', async () => {
    const h = harness();
    assert.equal(await h.run(['--help']), 0);
    assert.equal(await h.run(['start']), 1);
    assert.equal(h.requests.length, 0);
    assert.equal(h.scopes.length, 0);
  });
});

describe('typed delegated transport', () => {
  it('uses the explicit scope and bounded auth, rejects redirects and declares exact JSON size', async () => {
    const h = harness();
    assert.equal(await h.run(start), 0);
    assert.ok(h.scopes.every((scope) => scope === 'api://fictional-resolve-app/.default'));
    assert.ok(h.signals.every((signal) => signal));
    const post = h.requests.find((request) => request.method === 'POST');
    assert.ok(post);
    assert.equal(post.redirect, 'error');
    assert.equal(post.headers.get('Authorization'), 'Bearer fictional-access-token');
    const body = await post.text();
    assert.equal(post.headers.get('Content-Length'), String(Buffer.byteLength(body)));
    assert.equal(post.headers.get('Idempotency-Key'), KEY);
    assert.deepEqual(JSON.parse(body), {
      accountId: 'acct_aurora_0001', invoiceIds: ['inv_aurora_0001_a', 'inv_aurora_0001_b'],
      category: 'duplicate_charge', requestedCredit: { amountMinor: 4900, currency: 'USD' },
      description: 'Fictional billing dispute: two paid invoices cover the same September subscription period.',
    });
  });

  it('sanitizes credential failures and expired tokens without a request', async () => {
    for (const credential of [
      { getToken: () => Promise.reject(new Error('Bearer secret-token oid=real-user-id')) },
      { getToken: () => Promise.resolve({ token: 'expired-secret', expiresOnTimestamp: 1 }) },
    ]) {
      const h = harness({ credential });
      assert.equal(await h.run(start), 1);
      assert.equal(h.requests.length, 0);
      assert.doesNotMatch(h.errors.join(''), /secret-token|real-user-id|expired-secret/);
    }
  });

  it('bounds auth even if an injected credential ignores abort', { timeout: 2000 }, async () => {
    const h = harness({ credential: { getToken: () => new Promise(() => {}) } });
    // AbortSignal.timeout is unref'ed; keep only a bounded test timer alive.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      assert.equal(await h.run([...start, '--timeout-ms', '100']), 1);
      assert.match(h.errors.join(''), /request_timeout/);
      assert.equal(h.requests.length, 0);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('bounds a stalled fetch with the request signal', { timeout: 2000 }, async () => {
    const h = harness();
    const client = createDemoClient({ baseUrl: 'https://resolve.test/api', scope: 'api://app/.default', timeoutMs: 100 }, {
      credential: h.credential,
      fetch: (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return new Promise((_resolve, rejectPromise) => {
          request.signal.addEventListener('abort', () => { rejectPromise(new Error('fictional fetch aborted')); }, { once: true });
        });

      },
    });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(apiValue(client.GET('/session')), /fictional fetch aborted/);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('keeps the request deadline active through response body reading', { timeout: 2000 }, async () => {
    const h = harness();
    const client = createDemoClient({ baseUrl: 'https://resolve.test/api', scope: 'api://app/.default', timeoutMs: 100 }, {
      credential: h.credential,
      fetch: (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            request.signal.addEventListener('abort', () => { controller.error(new Error('fictional body aborted')); }, { once: true });
          },
        });
        return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
      },
    });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(apiValue(client.GET('/session')), /fictional body aborted/);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('fails HTTP errors, redirects, invalid JSON and empty successes rather than inventing success', async () => {
    for (const response of [
      json({ detail: 'secret-api-detail' }, 401), json({ detail: 'secret-api-detail' }, 403),
      json({ detail: 'secret-api-detail' }, 409), json({ detail: 'secret-api-detail' }, 429),
      json({ detail: 'secret-api-detail' }, 503), new Response(null, { status: 302, headers: { Location: 'https://untrusted.test' } }),
      new Response(null, { status: 204 }), new Response('invalid json', { headers: { 'Content-Type': 'application/json' } }),
    ]) {
      const h = harness({ route: () => response.clone() });
      assert.equal(await h.run(start), 1);
      assert.equal(mutationCount(h.requests), 0);
      assert.doesNotMatch(h.errors.join(''), /secret-api-detail|untrusted/);
    }
  });
});

describe('public case journey and human decisions', () => {
  it('starts only through POST /cases and never auto-approves; reuses the supplied key', async () => {
    const h = harness();
    assert.equal(await h.run(start), 0);
    assert.equal(await h.run(start), 0);
    assert.equal(mutationCount(h.requests), 2);
    assert.ok(h.requests.filter((request) => request.method === 'POST').every((request) => new URL(request.url).pathname === '/api/cases'));
    assert.ok(h.requests.filter((request) => request.method === 'POST').every((request) => request.headers.get('Idempotency-Key') === KEY));
    assert.match(h.output.join(''), /"mode":"live"/);
    assert.match(h.output.join(''), /"status":"awaiting_approval"/);
    assert.doesNotMatch(h.output.join(''), /fictional-access-token|a1000000|a2000000|fictional-user-id/);
  });

  it('reports an idempotent replay without generating a replacement key', async () => {
    const h = harness({ route: (request) => request.method === 'POST'
      ? json({ case: liveCase(), runId: 'run-1', replayed: true }, 202) : undefined });
    assert.equal(await h.run(start), 0);
    assert.match(h.output.join(''), /"replayed":true/);
    assert.equal(mutationCount(h.requests), 1);
  });

  it('does not mutate on deployed mode mismatch, unavailable live or unsupported tenant', async () => {
    for (const value of [
      session(), session({ environment: { agentMode: 'live', liveAvailable: false } }),
      session({ tenantId: 'unsupported', environment: { agentMode: 'live', liveAvailable: true } }),
    ]) {
      const h = harness({ session: value });
      assert.equal(await h.run(start), 1);
      assert.equal(mutationCount(h.requests), 0);
    }
  });

  it('uses the authenticated borealis fixture and labels explicit deterministic demo mode', async () => {
    const h = harness({
      session: session({ tenantId: 'borealis' }), detail: caseDetail(),
    });
    assert.equal(await h.run([...start, '--mode', 'demo']), 0);
    const post = h.requests.find((request) => request.method === 'POST');
    assert.ok(post);
    assert.match(await post.text(), /acct_borealis_0001/);
    assert.match(h.output.join(''), /"mode":"demo"/);
  });

  it('rejects a replayed case whose persisted mode differs from the requested mode', async () => {
    const h = harness({ detail: caseDetail() });
    assert.equal(await h.run(start), 1);
    assert.match(h.errors.join(''), /run_mode_mismatch/);
    assert.equal(mutationCount(h.requests), 1);
  });

  it('binds an explicit human approval to the exact fetched digest and policy version', async () => {
    let caseReads = 0;
    const h = harness({
      route: (request) => {
        if (request.url.endsWith('/approve')) return json({ decision: decision('approved'), caseStatus: 'approved' }, 202);
        if (new URL(request.url).pathname === `/api/cases/${CASE_ID}`) {
          return json(++caseReads === 1 ? liveCase() : liveCase({ status: 'credited', creditResult: creditResult() }));
        }
        return undefined;
      },
    });
    assert.equal(await h.run([...approve, '--comment', 'Fictional duplicate evidence checked.']), 0);
    const post = h.requests.find((request) => request.method === 'POST');
    assert.ok(post);
    assert.ok(post.url.endsWith('/proposals/1/approve'));
    assert.deepEqual(await post.json(), { policyVersion: 2, proposalDigest: DIGEST, comment: 'Fictional duplicate evidence checked.' });
    assert.ok(h.requests.some((request) => request.url.endsWith('/proposals/1') && request.method === 'GET'));
    assert.ok(h.requests.some((request) => request.url.endsWith('/credit')));
    assert.match(h.output.join(''), /"simulated":true/);
    assert.doesNotMatch(h.output.join(''), /fictional-approver-id|sim-ref-0001|idem-0001/);
  });

  it('records only an explicit rejection reason with the same exact binding', async () => {
    let caseReads = 0;
    const h = harness({
      route: (request) => {
        if (request.url.endsWith('/reject')) return json(decision('rejected'));
        if (new URL(request.url).pathname === `/api/cases/${CASE_ID}`) {
          return json(++caseReads === 1 ? liveCase() : liveCase({ status: 'rejected' }));
        }
        return undefined;
      },
    });
    assert.equal(await h.run(reject), 0);
    const post = h.requests.find((request) => request.method === 'POST');
    assert.ok(post);
    assert.ok(post.url.endsWith('/proposals/1/reject'));
    assert.deepEqual(await post.json(), { policyVersion: 2, proposalDigest: DIGEST, reason: 'Fictional invoice requires review.' });
    assert.equal(mutationCount(h.requests), 1);
    assert.ok(h.requests.every((request) => !request.url.endsWith('/credit')));
  });

  it('refuses findings, expired/decided/superseded or malformed exact proposals before POST', async () => {
    for (const value of [
      liveProposal({ kind: 'finding', amount: null }),
      liveProposal({ status: 'approved' }), liveProposal({ status: 'superseded' }),
      liveProposal({ policyRef: null }), liveProposal({ digest: 'not-a-digest' }),
      liveProposal({ version: 2 }), liveProposal({ approvalExpiresAt: new Date(NOW - 1).toISOString() }),
      liveProposal({ approvalExpiresAt: 'invalid' }),
    ]) {
      const h = harness({ proposals: [value] });
      assert.equal(await h.run(approve), 1);
      assert.equal(mutationCount(h.requests), 0);
    }
    const h = harness({ detail: liveCase({ latestProposal: { ...liveCase().latestProposal, version: 2, kind: 'credit', status: 'pending_approval', amount: null, approvalExpiresAt: null } }) });
    assert.equal(await h.run(approve), 1);
    assert.match(h.errors.join(''), /stale_version/);
    assert.equal(mutationCount(h.requests), 0);
  });

  it('reports server race and role separation conflicts without retrying or refreshing the version', async () => {
    for (const status of [403, 409]) {
      const h = harness({ route: (request) => request.url.endsWith('/approve') ? json({ code: 'proposal_superseded' }, status) : undefined });
      assert.equal(await h.run(approve), 1);
      assert.equal(mutationCount(h.requests), 1);
      assert.match(h.errors.join(''), new RegExp(`http_${String(status)}`));
    }
  });

  it('rejects mismatched decision acknowledgements and does not claim a credit for a still-pending approval', async () => {
    const wrong = harness({ route: (request) => request.url.endsWith('/approve')
      ? json({ decision: { ...decision('approved'), proposalVersion: 2 }, caseStatus: 'approved' }, 202) : undefined });
    assert.equal(await wrong.run(approve), 1);
    assert.equal(mutationCount(wrong.requests), 1);
    assert.match(wrong.errors.join(''), /invalid_response/);
    const waiting = harness({ route: (request) => request.url.endsWith('/approve')
      ? json({ decision: decision('approved'), caseStatus: 'approved' }, 202) : undefined });
    assert.equal(await waiting.run(approve), 2);
    assert.match(waiting.output.join(''), /"status":"awaiting_approval"/);
    assert.doesNotMatch(waiting.output.join(''), /"status":"credited"/);
  });
});

describe('inspection, durable wait and persisted usage', () => {
  it('exhausts ordered timeline and usage pages with exact opaque cursors and preserves unknown usage', async () => {
    const h = harness({ route: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/timeline')) {
        assert.equal(url.searchParams.get('limit'), '50');
        const token = url.searchParams.get('continuationToken');
        return json(token === null ? { items: [event(1)], continuationToken: 'opaque_timeline' } : { items: [event(2)], continuationToken: null });
      }
      if (url.pathname.endsWith('/usage')) {
        const token = url.searchParams.get('continuationToken');
        return json(token === null
          ? { items: [usageEvent(1, { outcome: 'reserved' })], continuationToken: 'opaque_usage' }
          : { items: [usageEvent(2, { outcome: 'ambiguous' })], continuationToken: null });
      }
      return undefined;
    } });
    assert.equal(await h.run(inspect), 0);
    assert.ok(h.requests.some((request) => new URL(request.url).searchParams.get('continuationToken') === 'opaque_timeline'));
    assert.ok(h.requests.some((request) => new URL(request.url).searchParams.get('continuationToken') === 'opaque_usage'));
    const output = h.output.join('');
    assert.match(output, /"seq":1.*"seq":2/);
    assert.match(output, /"outcome":"reserved"/);
    assert.match(output, /"outcome":"ambiguous"/);
    assert.match(output, /"inputTokens":null/);
    assert.match(output, /"tokenQuality":"unknown"/);
    assert.equal(mutationCount(h.requests), 0);
  });

  it('rereads reserved usage events from the beginning on each inspection', async () => {
    let reads = 0;
    const h = harness({ route: (request) => request.url.endsWith('/usage?limit=50')
      ? json({ items: [usageEvent(1, { outcome: ++reads === 1 ? 'reserved' : 'succeeded' })], continuationToken: null }) : undefined });
    assert.equal(await h.run(inspect), 0);
    assert.equal(await h.run(inspect), 0);
    assert.match(h.output[0] ?? '', /"outcome":"reserved"/);
    assert.match(h.output[1] ?? '', /"outcome":"succeeded"/);
  });

  it('fails repeated cursors, out-of-order events and unbounded pagination without partial success', async () => {
    for (const scenario of ['repeated', 'unordered', 'endless']) {
      let page = 0;
      const h = harness({ route: (request) => {
        if (!new URL(request.url).pathname.endsWith('/timeline')) return undefined;
        page++;
        if (scenario === 'unordered') return json({ items: [event(2), event(1)], continuationToken: null });
        return json({ items: [event(page)], continuationToken: scenario === 'repeated' ? 'same_cursor' : `cursor_${String(page)}` });
      } });
      assert.equal(await h.run(inspect), 1);
      assert.equal(h.output.length, 0);
      assert.ok(page <= 100);
    }
  });

  it('omits every actor ID and untrusted API text, including future timeline kinds', async () => {
    const h = harness({
      detail: liveCase({ description: 'Bearer secret-text real-user-id' }),
      proposals: [liveProposal({ explanation: 'Bearer secret-text real-user-id' })],
      route: (request) => new URL(request.url).pathname.endsWith('/timeline')
        ? json({ items: [{ ...event(1), kind: 'secret-future-kind', summary: 'real-user-id', data: { reason: 'Bearer secret-text' } }], continuationToken: null }) : undefined,
    });

    assert.equal(await h.run(inspect), 0);
    assert.doesNotMatch(h.output.join(''), /real-user-id|secret-text|secret-future-kind|fictional-user-id/);
    assert.match(h.output.join(''), /"kind":"other"/);
  });

  it('does not forward unknown nested response properties into structured output', async () => {
    const detail = liveCase();
    const h = harness({ route: (request) => {
      const path = new URL(request.url).pathname;
      if (path === `/api/cases/${CASE_ID}`) return json({
        ...detail, latestProposal: { ...detail.latestProposal, principalId: 'private-principal' },
      });
      if (path.endsWith('/runs')) return json({ items: [{
        ...detail.latestRun, usage: { ...detail.latestRun?.usage, token: 'private-token' },
        limits: { ...detail.latestRun?.limits, token: 'private-token' },
      }] });
      if (path.endsWith('/proposals')) return json({ items: [{
        ...liveProposal(), amount: { amountMinor: 4900, currency: 'USD', token: 'private-token' },
        policyRef: { ...liveProposal().policyRef, token: 'private-token' },
        invoiceRefs: [{ invoiceId: 'inv_aurora_0001_b', lineIndex: null, token: 'private-token' }],
      }] });
      return undefined;
    } });
    assert.equal(await h.run(inspect), 0);
    assert.doesNotMatch(h.output.join(''), /private-principal|private-token/);
  });

  it('polls queued work to the durable human approval wait without a second mutation', async () => {
    let caseReads = 0;
    const h = harness({ route: (request) => new URL(request.url).pathname === `/api/cases/${CASE_ID}`
      ? json(++caseReads === 1 ? liveCase({ status: 'investigating' }) : liveCase()) : undefined });
    assert.equal(await h.run(['start', ...COMMON, '--idempotency-key', KEY, '--wait-ms', '1000', '--poll-ms', '100']), 0);
    assert.equal(mutationCount(h.requests), 1);
    assert.equal(caseReads, 3);
    assert.match(h.output.join(''), /"wait":"settled"/);
  });

  it('bounds polling and keeps the accepted ID visible when work is incomplete', async () => {
    const h = harness({ detail: liveCase({ status: 'investigating', latestRun: run({ mode: 'live', state: 'running' }), latestProposal: null }), proposals: [] });
    assert.equal(await h.run(['start', ...COMMON, '--idempotency-key', KEY, '--wait-ms', '200', '--poll-ms', '100']), 2);
    assert.match(h.output[0] ?? '', new RegExp(CASE_ID));
    assert.match(h.output.join(''), /"wait":"expired"/);
    assert.equal(mutationCount(h.requests), 1);
    assert.equal(h.requests.filter((request) => new URL(request.url).pathname === `/api/cases/${CASE_ID}`).length, 3);
  });

  it('also caps poll attempts when an injected clock does not advance', async () => {
    const h = harness({ detail: liveCase({ status: 'investigating' }), sleep: () => Promise.resolve() });
    assert.equal(await h.run(['start', ...COMMON, '--idempotency-key', KEY, '--wait-ms', '200', '--poll-ms', '100']), 2);
    assert.equal(h.requests.filter((request) => new URL(request.url).pathname === `/api/cases/${CASE_ID}`).length, 4);
  });

  it('does not stop an approved execution wait before the persisted credit result', async () => {
    let reads = 0;
    const h = harness({ route: (request) => {
      if (request.url.endsWith('/approve')) return json({ decision: decision('approved'), caseStatus: 'approved' }, 202);
      if (new URL(request.url).pathname === `/api/cases/${CASE_ID}`) {
        reads++;
        return json(reads === 1 ? liveCase() : liveCase({ status: reads === 2 ? 'approved' : 'credited', creditResult: reads >= 3 ? creditResult() : null }));
      }
      return undefined;
    } });
    assert.equal(await h.run(['approve', ...COMMON, '--case-id', CASE_ID, '--version', '1', '--wait-ms', '1000', '--poll-ms', '100']), 0);
    assert.match(h.output.join(''), /"status":"credited"/);
    assert.ok(h.requests.some((request) => request.url.endsWith('/credit')));
    assert.equal(mutationCount(h.requests), 1);
  });

  it('returns incomplete for operator-required work, not a live success default', async () => {
    const h = harness({ detail: liveCase({ status: 'needs_attention', latestRun: run({ mode: 'live', state: 'budget_exhausted' }) }) });
    assert.equal(await h.run(start), 2);
    assert.match(h.output.join(''), /budget_exhausted/);
  });

  it('top-level unexpected failures never print stack traces or raw authentication messages', async () => {
    const errors: string[] = [];
    const h = harness();
    const result = await runCli(inspect, {
      credential: h.credential,
      fetch: () => Promise.reject(new Error('Bearer private-token real-principal-id')),
      out: () => { assert.fail('Unexpected success'); }, err: (text) => { errors.push(text); },
    });
    assert.equal(result, 1);
    assert.doesNotMatch(errors.join(''), /private-token|real-principal-id|stack/);
  });
});
