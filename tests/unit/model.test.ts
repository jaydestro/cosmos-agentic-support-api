import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  MAX_RESPONSE_BYTES,
  MAX_RETRY_AFTER_MS,
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_CALLS_PER_RESPONSE,
  ModelFailure,
  createModelClient,
  parseCompletion,
  retryAfterMs,
  statusFailure,
  transportFailure,
  type ModelClient,
  type ModelCredential,
  type ModelErrorCode,
  type ModelFailureOutcome,
  type ModelMessage,
} from '../../src/agent/model.ts';
import { TOOL_DEFINITIONS } from '../../src/agent/tools.ts';
import { DEFAULT_LIVE_MODEL_TOKEN_SCOPE, type LiveModelConfig } from '../../src/config/env.ts';
import {
  closedLoopbackOrigin,
  completionBody,
  completionReply,
  errorReply,
  jsonReply,
  startFakeModel,
  type FakeModel,
} from '../support/fake-model.ts';

const PRICING = { inputMicroUsdPerMillionTokens: 2_500_000, outputMicroUsdPerMillionTokens: 10_000_000, asOf: '2026-10-01' };

function configFor(baseUrl: string, overrides: Partial<LiveModelConfig> = {}): LiveModelConfig {
  return {
    baseUrl,
    deployment: 'resolve-unit-test',
    auth: 'none',
    tokenScope: DEFAULT_LIVE_MODEL_TOKEN_SCOPE,
    maxOutputTokens: 512,
    requestTimeoutMs: 2_000,
    pricing: PRICING,
    ...overrides,
  };
}

const MESSAGES: readonly ModelMessage[] = [
  { role: 'system', content: 'You are a unit test.' },
  { role: 'user', content: 'Hello.' },
];

async function failureOf(promise: Promise<unknown>): Promise<ModelFailure> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ModelFailure, `expected a ModelFailure, got ${String(error)}`);
    return error;
  }
  return assert.fail('the call should have failed');
}

describe('the model client over HTTP', () => {
  let fake: FakeModel;
  let client: ModelClient;

  before(async () => {
    fake = await startFakeModel();
    client = createModelClient({ config: configFor(fake.baseUrl) });
  });
  after(async () => {
    await fake.close();
  });

  it('posts one minimal chat-completions request with only the allowlisted tools', async () => {
    fake.reset();
    fake.reply(completionReply({ content: 'ok' }));
    await client.complete(MESSAGES);

    assert.equal(fake.requests.length, 1);
    const [request] = fake.requests;
    assert.equal(request?.method, 'POST');
    assert.equal(request?.path, '/openai/v1/chat/completions');
    assert.equal(request?.headers['content-type'], 'application/json');
    assert.equal(request?.headers.authorization, undefined);

    const body = request?.json as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['max_completion_tokens', 'messages', 'model', 'tools']);
    assert.equal(body.model, 'resolve-unit-test');
    assert.equal(body.max_completion_tokens, 512);
    const tools = body.tools as { type: string; function: { name: string; description: string; parameters: unknown } }[];
    assert.deepEqual(
      tools.map((tool) => tool.function.name),
      TOOL_DEFINITIONS.map((tool) => tool.name),
    );
    for (const tool of tools) assert.equal(tool.type, 'function');
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'You are a unit test.' },
      { role: 'user', content: 'Hello.' },
    ]);
  });

  it('sends tool calls and tool results in the documented message shape', async () => {
    fake.reset();
    fake.reply(completionReply({ content: 'done' }));
    await client.complete([
      ...MESSAGES,
      { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'get_account', arguments: '{"x":1}' }] },
      { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      { role: 'assistant', content: 'thinking aloud', toolCalls: [] },
    ]);
    const body = fake.requests[0]?.json as { messages: unknown[] };
    assert.deepEqual(body.messages.slice(2), [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_account', arguments: '{"x":1}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      { role: 'assistant', content: 'thinking aloud' },
    ]);
  });

  it('returns the content, tool calls and measured usage of a completion', async () => {
    fake.reset();
    fake.reply(
      completionReply({
        toolCalls: [
          { id: 'call_a', name: 'get_account', arguments: { accountId: 'acct-x' } },
          { id: 'call_b', name: 'list_invoices', arguments: '{"accountId": "acct-x"}' },
        ],
        usage: { prompt: 812, completion: 37 },
      }),
    );
    const completion = await client.complete(MESSAGES);
    assert.equal(completion.content, null);
    assert.equal(completion.refusal, null);
    assert.equal(completion.finishReason, 'tool_calls');
    assert.deepEqual(completion.usage, { promptTokens: 812, completionTokens: 37 });
    assert.deepEqual(completion.toolCalls, [
      { id: 'call_a', name: 'get_account', arguments: '{"accountId":"acct-x"}' },
      { id: 'call_b', name: 'list_invoices', arguments: '{"accountId": "acct-x"}' },
    ]);
  });

  const statuses: readonly [number, ModelErrorCode, ModelFailureOutcome, boolean][] = [
    [400, 'model_bad_request', 'failed', false],
    [401, 'model_unauthorized', 'failed', false],
    [403, 'model_unauthorized', 'failed', false],
    [404, 'model_bad_request', 'failed', false],
    [408, 'model_unavailable', 'ambiguous', true],
    [422, 'model_bad_request', 'failed', false],
    [429, 'model_rate_limited', 'failed', true],
    [500, 'model_unavailable', 'failed', true],
    [502, 'model_unavailable', 'failed', true],
    [503, 'model_unavailable', 'failed', true],
    [504, 'model_unavailable', 'ambiguous', true],
  ];
  for (const [status, code, outcome, retryable] of statuses) {
    it(`classifies HTTP ${String(status)} as ${code} (${outcome}, ${retryable ? 'retryable' : 'not retryable'})`, async () => {
      fake.reset();
      fake.reply(errorReply(status));
      const failure = await failureOf(client.complete(MESSAGES));
      assert.equal(failure.code, code);
      assert.equal(failure.outcome, outcome);
      assert.equal(failure.retryable, retryable);
    });
  }

  it('passes a Retry-After back to the caller, capped', async () => {
    fake.reset();
    fake.reply(errorReply(429, { 'retry-after': '3' }), errorReply(429, { 'retry-after': '3600' }), errorReply(429));
    assert.equal((await failureOf(client.complete(MESSAGES))).retryAfterMs, 3_000);
    assert.equal((await failureOf(client.complete(MESSAGES))).retryAfterMs, MAX_RETRY_AFTER_MS);
    assert.equal((await failureOf(client.complete(MESSAGES))).retryAfterMs, null);
  });

  it('keeps the response body of a failure out of the error', async () => {
    fake.reset();
    fake.reply(jsonReply({ error: { code: 'x', message: 'echo of the prompt: SECRET-PROMPT-TEXT' } }, { status: 400 }));
    const failure = await failureOf(client.complete(MESSAGES));
    assert.doesNotMatch(String(failure), /SECRET-PROMPT-TEXT/);
    assert.doesNotMatch(JSON.stringify(failure), /SECRET-PROMPT-TEXT/);
    assert.equal(failure.message, 'The model call failed: model_bad_request.');
  });

  it('does not follow a redirect, so a credential cannot be replayed to another host', async () => {
    fake.reset();
    fake.reply({ kind: 'redirect', location: 'http://127.0.0.1:9/elsewhere' });
    const failure = await failureOf(client.complete(MESSAGES));
    assert.equal(failure.code, 'model_bad_request');
    assert.equal(failure.retryable, false);
    assert.equal(fake.requests.length, 1);
  });

  it('reports a call that outlives its timeout as ambiguous and retryable', async () => {
    const quick = createModelClient({ config: configFor(fake.baseUrl, { requestTimeoutMs: 150 }) });
    fake.reset();
    fake.reply({ kind: 'hang' });
    const failure = await failureOf(quick.complete(MESSAGES));
    assert.equal(failure.code, 'model_timeout');
    assert.equal(failure.outcome, 'ambiguous');
    assert.equal(failure.retryable, true);
  });

  it('reports a slow answer as a timeout too', async () => {
    const quick = createModelClient({ config: configFor(fake.baseUrl, { requestTimeoutMs: 150 }) });
    fake.reset();
    fake.reply(jsonReply(completionBody({ content: 'late' }), { delayMs: 600 }));
    const failure = await failureOf(quick.complete(MESSAGES));
    assert.equal(failure.code, 'model_timeout');
    assert.equal(failure.outcome, 'ambiguous');
  });

  it('reports a connection dropped after the request was sent as ambiguous', async () => {
    fake.reset();
    fake.reply({ kind: 'drop' });
    const failure = await failureOf(client.complete(MESSAGES));
    assert.equal(failure.code, 'model_connection_failed');
    assert.equal(failure.outcome, 'ambiguous');
    assert.equal(failure.retryable, true);
  });

  it('reports a connection that was never made as failed, not ambiguous', async () => {
    const refused = createModelClient({ config: configFor(`${await closedLoopbackOrigin()}/openai/v1`) });
    const failure = await failureOf(refused.complete(MESSAGES));
    assert.equal(failure.code, 'model_connection_failed');
    assert.equal(failure.outcome, 'failed');
    assert.equal(failure.retryable, true);
  });

  it('treats a 200 that is not a completion as ambiguous and not retryable', async () => {
    const bodies: { name: string; reply: Parameters<FakeModel['reply']>[0] }[] = [
      { name: 'text that is not JSON', reply: { kind: 'text', text: 'not json' } },
      { name: 'an empty body', reply: { kind: 'text', text: '' } },
      { name: 'no choices', reply: jsonReply({ choices: [] }) },
      { name: 'an oversized body', reply: { kind: 'text', text: 'x'.repeat(MAX_RESPONSE_BYTES + 1) } },
    ];
    for (const { name, reply } of bodies) {
      fake.reset();
      fake.reply(reply);
      const failure = await failureOf(client.complete(MESSAGES));
      assert.equal(failure.code, 'model_response_invalid', name);
      assert.equal(failure.outcome, 'ambiguous', name);
      assert.equal(failure.retryable, false, name);
    }
  });
});

describe('the model client credential', () => {
  let fake: FakeModel;
  before(async () => {
    fake = await startFakeModel();
  });
  after(async () => {
    await fake.close();
  });

  it('sends a bearer token for the configured scope when the endpoint uses Entra ID', async () => {
    const scopes: string[] = [];
    const credential: ModelCredential = {
      getToken: (scope) => {
        scopes.push(scope);
        return Promise.resolve({ token: 'unit-token' });
      },
    };
    const client = createModelClient({ config: configFor(fake.baseUrl, { auth: 'entra', tokenScope: 'https://ai.azure.com/.default' }), credential });
    fake.reset();
    fake.reply(completionReply({ content: 'ok' }));
    await client.complete(MESSAGES);
    assert.deepEqual(scopes, ['https://ai.azure.com/.default']);
    assert.equal(fake.requests[0]?.headers.authorization, ['Bear', 'er unit-token'].join(''));
  });

  it('fails before sending anything when no token can be obtained, without echoing the reason', async () => {
    const throwing = createModelClient({
      config: configFor(fake.baseUrl, { auth: 'entra' }),
      credential: { getToken: () => Promise.reject(new Error('credential detail that must not leak')) },
    });
    const empty = createModelClient({ config: configFor(fake.baseUrl, { auth: 'entra' }), credential: { getToken: () => Promise.resolve(null) } });
    fake.reset();
    for (const client of [throwing, empty]) {
      const failure = await failureOf(client.complete(MESSAGES));
      assert.equal(failure.code, 'model_auth_failed');
      assert.equal(failure.outcome, 'failed');
      assert.equal(failure.retryable, true);
      assert.doesNotMatch(String(failure), /must not leak/);
    }
    assert.equal(fake.requests.length, 0);
  });

  it('refuses to be built for Entra ID without a credential', () => {
    assert.throws(() => createModelClient({ config: configFor(fake.baseUrl, { auth: 'entra' }) }), /credential is required/);
  });
});

describe('estimating and pricing a call', () => {
  const client = createModelClient({ config: configFor('http://127.0.0.1:9/openai/v1') });

  it('bounds the prompt by its bytes and adds the whole output allowance', () => {
    const one = client.estimate(MESSAGES);
    const more = client.estimate([...MESSAGES.slice(0, 1), { role: 'user', content: `Hello.${'b'.repeat(10_000)}` }]);
    assert.equal(more.tokens - one.tokens, 10_000);
    assert.ok(one.tokens > 512, 'the output allowance is included in full');
  });

  it('counts UTF-8 bytes, not characters', () => {
    const ascii = client.estimate([{ role: 'user', content: 'x'.repeat(100) }]);
    const accented = client.estimate([{ role: 'user', content: 'é'.repeat(100) }]);
    const emoji = client.estimate([{ role: 'user', content: '😀'.repeat(100) }]);
    assert.equal(accented.tokens - ascii.tokens, 100);
    assert.equal(emoji.tokens - ascii.tokens, 300);
  });

  it('counts the tool calls and results of a conversation', () => {
    const base = client.estimate(MESSAGES);
    const longer = client.estimate([
      ...MESSAGES,
      { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'get_account', arguments: '{"accountId":"a"}' }] },
      { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
    ]);
    assert.ok(longer.tokens > base.tokens + 20);
  });

  it('prices the estimate at the configured prices, rounded up', () => {
    const estimate = client.estimate(MESSAGES);
    const prompt = estimate.tokens - 512;
    assert.equal(estimate.costMicroUsd, Math.ceil((prompt * 2_500_000 + 512 * 10_000_000) / 1_000_000));
  });

  it('prices measured usage in whole micro-USD, rounded up', () => {
    assert.equal(client.priceOf({ promptTokens: 1_000, completionTokens: 500 }), 7_500);
    assert.equal(client.priceOf({ promptTokens: 1, completionTokens: 1 }), 13);
    assert.equal(client.priceOf({ promptTokens: 0, completionTokens: 0 }), 0);
    assert.equal(client.priceOf({ promptTokens: 1_000_000, completionTokens: 0 }), 2_500_000);
  });

  it('never prices a huge count with rounding error', () => {
    const big = createModelClient({ config: configFor('http://127.0.0.1:9/openai/v1', { pricing: { ...PRICING, inputMicroUsdPerMillionTokens: 9_999_999_999 } }) });
    assert.equal(big.priceOf({ promptTokens: 1_000_000_000, completionTokens: 0 }), 9_999_999_999_000);
  });

  it('exposes the deployment and the dated prices it charges at', () => {
    assert.equal(client.deployment, 'resolve-unit-test');
    assert.deepEqual(client.pricing, PRICING);
  });
});

describe('parseCompletion', () => {
  const wrap = (message: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ choices: [{ finish_reason: 'stop', message, ...extra }] });

  it('reads a plain answer', () => {
    assert.deepEqual(parseCompletion(JSON.stringify(completionBody({ content: 'Hi.', usage: { prompt: 5, completion: 2 } }))), {
      content: 'Hi.',
      refusal: null,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 2 },
    });
  });

  it('reads a refusal and a missing finish reason', () => {
    const completion = parseCompletion(JSON.stringify({ choices: [{ message: { content: null, refusal: 'No.' } }] }));
    assert.equal(completion.refusal, 'No.');
    assert.equal(completion.finishReason, 'unknown');
    assert.equal(completion.usage, null);
  });

  it('maps every documented finish reason and anything else to unknown', () => {
    for (const reason of ['stop', 'length', 'tool_calls', 'content_filter']) {
      assert.equal(parseCompletion(wrap({ content: 'x' }, { finish_reason: reason })).finishReason, reason);
    }
    assert.equal(parseCompletion(wrap({ content: 'x' }, { finish_reason: 'function_call' })).finishReason, 'unknown');
    assert.equal(parseCompletion(wrap({ content: 'x' }, { finish_reason: 7 })).finishReason, 'unknown');
  });

  it('treats null tool calls as none and usage that is not whole counts as unknown, not as an error', () => {
    assert.deepEqual(parseCompletion(wrap({ content: 'x', tool_calls: null })).toolCalls, []);
    for (const usage of [undefined, null, 5, {}, { prompt_tokens: '1', completion_tokens: 2 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1.5, completion_tokens: 2 }]) {
      const text = JSON.stringify({ choices: [{ message: { content: 'x' } }], usage });
      assert.equal(parseCompletion(text).usage, null, JSON.stringify(usage));
    }
  });

  const call = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'call_1',
    type: 'function',
    function: { name: 'get_account', arguments: '{}' },
    ...overrides,
  });
  const invalid: [string, string][] = [
    ['an array', '[]'],
    ['a string', '"x"'],
    ['no choices', '{}'],
    ['an empty choice list', '{"choices":[]}'],
    ['a choice that is not an object', '{"choices":[1]}'],
    ['a message that is not an object', wrap('x')],
    ['numeric content', wrap({ content: 5 })],
    ['a refusal that is not text', wrap({ content: null, refusal: 5 })],
    ['tool calls that are not a list', wrap({ content: null, tool_calls: {} })],
    ['too many tool calls', wrap({ content: null, tool_calls: Array.from({ length: MAX_TOOL_CALLS_PER_RESPONSE + 1 }, () => call()) })],
    ['a tool call that is not an object', wrap({ content: null, tool_calls: ['x'] })],
    ['a tool call of another type', wrap({ content: null, tool_calls: [call({ type: 'custom' })] })],
    ['a tool call without a function', wrap({ content: null, tool_calls: [call({ function: undefined })] })],
    ['a tool call without an id', wrap({ content: null, tool_calls: [call({ id: undefined })] })],
    ['an empty tool call id', wrap({ content: null, tool_calls: [call({ id: '' })] })],
    ['a tool call id over 128 characters', wrap({ content: null, tool_calls: [call({ id: 'i'.repeat(129) })] })],
    ['an empty tool name', wrap({ content: null, tool_calls: [call({ function: { name: '', arguments: '{}' } })] })],
    ['a tool name over 64 characters', wrap({ content: null, tool_calls: [call({ function: { name: 'n'.repeat(65), arguments: '{}' } })] })],
    ['arguments that are an object, not text', wrap({ content: null, tool_calls: [call({ function: { name: 'get_account', arguments: {} } })] })],
    ['arguments over the size limit', wrap({ content: null, tool_calls: [call({ function: { name: 'get_account', arguments: 'a'.repeat(MAX_TOOL_ARGUMENT_CHARS + 1) } })] })],
  ];
  for (const [name, text] of invalid) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => parseCompletion(text),
        (error: unknown) => error instanceof ModelFailure && error.code === 'model_response_invalid' && error.outcome === 'ambiguous' && !error.retryable,
      );
    });
  }

  it('accepts the limits themselves', () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_RESPONSE }, (_, index) =>
      call({ id: `call_${String(index)}`, function: { name: 'get_account', arguments: 'a'.repeat(MAX_TOOL_ARGUMENT_CHARS) } }),
    );
    assert.equal(parseCompletion(wrap({ content: null, tool_calls: calls })).toolCalls.length, MAX_TOOL_CALLS_PER_RESPONSE);
  });

  it('passes tool arguments through as text without parsing them', () => {
    const completion = parseCompletion(wrap({ content: null, tool_calls: [call({ function: { name: 'get_account', arguments: '{not json' } })] }));
    assert.equal(completion.toolCalls[0]?.arguments, '{not json');
  });
});

describe('retryAfterMs', () => {
  const NOW = Date.parse('2026-10-29T12:00:00Z');

  it('prefers retry-after-ms, then reads retry-after as seconds', () => {
    assert.equal(retryAfterMs(new Headers({ 'retry-after-ms': '1500', 'retry-after': '9' }), NOW), 1_500);
    assert.equal(retryAfterMs(new Headers({ 'retry-after': '4' }), NOW), 4_000);
    assert.equal(retryAfterMs(new Headers({ 'retry-after': '0' }), NOW), 0);
  });

  it('reads an HTTP date relative to now and never returns a negative wait', () => {
    assert.equal(retryAfterMs(new Headers({ 'retry-after': new Date(NOW + 2_000).toUTCString() }), NOW), 2_000);
    assert.equal(retryAfterMs(new Headers({ 'retry-after': new Date(NOW - 60_000).toUTCString() }), NOW), 0);
  });

  it('caps every form so a retry stays inside the run time budget', () => {
    assert.equal(retryAfterMs(new Headers({ 'retry-after-ms': '999999' }), NOW), MAX_RETRY_AFTER_MS);
    assert.equal(retryAfterMs(new Headers({ 'retry-after': '999999' }), NOW), MAX_RETRY_AFTER_MS);
    assert.equal(retryAfterMs(new Headers({ 'retry-after': new Date(NOW + 3_600_000).toUTCString() }), NOW), MAX_RETRY_AFTER_MS);
  });

  it('ignores anything it cannot read', () => {
    assert.equal(retryAfterMs(new Headers(), NOW), null);
    assert.equal(retryAfterMs(new Headers({ 'retry-after': 'soon' }), NOW), null);
    assert.equal(retryAfterMs(new Headers({ 'retry-after': '-5' }), NOW), null);
    assert.equal(retryAfterMs(new Headers({ 'retry-after-ms': 'abc' }), NOW), null);
  });
});

describe('failure classification', () => {
  it('maps a status with no special meaning to a bad request', () => {
    for (const status of [300, 302, 400, 405, 409, 413, 415, 418]) {
      const failure = statusFailure(status, null);
      assert.equal(failure.code, 'model_bad_request', String(status));
      assert.equal(failure.retryable, false, String(status));
    }
  });

  it('keeps a ModelFailure as it is and treats anything else on the wire as a connection failure', () => {
    const original = new ModelFailure('model_timeout', 'ambiguous', true);
    assert.equal(transportFailure(original), original);
    const unknown = transportFailure(new TypeError('fetch failed'));
    assert.equal(unknown.code, 'model_connection_failed');
    assert.equal(unknown.outcome, 'ambiguous');
    assert.equal(transportFailure('not even an error').code, 'model_connection_failed');
  });

  it('recognises the errors that mean no connection was ever made', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      const failure = transportFailure(Object.assign(new TypeError('fetch failed'), { cause: { code } }));
      assert.equal(failure.outcome, 'failed', code);
    }
    assert.equal(transportFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })).outcome, 'ambiguous');
  });

  it('recognises a timeout and an abort by name', () => {
    assert.equal(transportFailure(new DOMException('x', 'TimeoutError')).code, 'model_timeout');
    assert.equal(transportFailure(new DOMException('x', 'AbortError')).code, 'model_timeout');
  });
});
