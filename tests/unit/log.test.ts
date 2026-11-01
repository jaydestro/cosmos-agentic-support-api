import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger, createMemoryLogger, redact, type LogLevel } from '../../src/telemetry/log.ts';

const parse = (line: string | undefined): Record<string, unknown> => JSON.parse(line ?? '{}') as Record<string, unknown>;

describe('redact', () => {
  it('replaces the value of every credential-like key, whatever its type', () => {
    const keys = [
      'authorization', 'Authorization', 'accessToken', 'refresh_token', 'idToken', 'clientSecret', 'password', 'passwd',
      'credential', 'credentials', 'cookie', 'Set-Cookie', 'connectionString', 'connection_string', 'accountKey',
      'account-key', 'apiKey', 'api_key', 'key', 'signature', 'assertion', 'bearer',
    ];
    for (const key of keys) {
      assert.equal(redact('value', 0, key), '[redacted]', key);
      assert.equal(redact({ nested: 'value' }, 0, key), '[redacted]', key);
      assert.equal(redact(['a', 'b'], 0, key), '[redacted]', key);
    }
  });

  it('does not redact a key that only contains the word "key" or a counter that is named after tokens', () => {
    assert.equal(redact('abc', 0, 'keyName'), 'abc');
    assert.equal(redact('abc', 0, 'sortKey'), 'abc');
    assert.equal(redact(30000, 0, 'maxTokens'), 30000);
    assert.equal(redact(12, 0, 'inputTokens'), 12);
    assert.equal(redact(true, 0, 'hasToken'), true);
    assert.equal(redact('abc', 0, 'accessToken'), '[redacted]');
  });

  it('redacts credentials found at any depth of an object or array', () => {
    const value = { request: { headers: { authorization: 'secret-1', accept: 'json' } }, list: [{ password: 'secret-2', ok: 1 }] };
    const text = JSON.stringify(redact(value));
    assert.equal(text.includes('secret-1') || text.includes('secret-2'), false);
    assert.deepEqual(redact(value), { request: { headers: { authorization: '[redacted]', accept: 'json' } }, list: [{ password: '[redacted]', ok: 1 }] });
  });

  it('replaces free text by its length, for strings only', () => {
    for (const key of ['description', 'Reason', 'comment', 'explanation', 'note', 'notes', 'text', 'prompt', 'payload', 'body']) {
      assert.equal(redact('customer wrote this', 0, key), '[text:19 chars]', key);
    }
    assert.equal(redact('customer wrote this', 0, 'title'), 'customer wrote this');
    assert.equal(redact('customer wrote this', 0, 'descriptions'), 'customer wrote this');
    assert.equal(redact(5, 0, 'text'), 5);
  });

  it('keeps the free-text rule for strings inside arrays under that key', () => {
    assert.deepEqual(redact(['one', 'three'], 0, 'notes'), ['[text:3 chars]', '[text:5 chars]']);
  });

  it('truncates long strings with an ellipsis', () => {
    const long = 'x'.repeat(301);
    assert.equal(redact(long, 0, 'detail'), `${'x'.repeat(300)}…`);
    assert.equal(redact('x'.repeat(300), 0, 'detail'), 'x'.repeat(300));
  });

  it('passes scalars through and stringifies a bigint', () => {
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
    assert.equal(redact(7), 7);
    assert.equal(redact(false), false);
    assert.equal(redact(12345678901234567890n), '12345678901234567890');
    assert.equal(redact(new Date('2026-01-01T00:00:00.000Z')), '2026-01-01T00:00:00.000Z');
  });

  it('marks what it cannot represent', () => {
    assert.equal(redact(() => 1), '[unsupported]');
    assert.equal(redact(Symbol('s')), '[unsupported]');
  });

  it('keeps only the safe parts of an error and never its stack', () => {
    const error = Object.assign(new Error('boom'), { code: 'EFAIL', statusCode: 503, stack: 'secret stack', extra: 'secret extra' });
    const redacted = redact(error) as Record<string, unknown>;
    assert.deepEqual(redacted, { name: 'Error', message: 'boom', code: 'EFAIL', status: 503 });
    assert.equal(JSON.stringify(redacted).includes('secret'), false);
  });

  it('prefers status over statusCode and omits what is absent', () => {
    assert.deepEqual(redact(Object.assign(new Error('x'), { status: 429, statusCode: 500 })), { name: 'Error', message: 'x', status: 429 });
    assert.deepEqual(redact(new TypeError('x')), { name: 'TypeError', message: 'x' });
  });

  it('redacts and truncates an error message like any other text', () => {
    const redacted = redact(new Error('y'.repeat(400))) as { message: string };
    assert.equal(redacted.message, `${'y'.repeat(300)}…`);
  });

  it('truncates structures that are nested too deeply, but still shows scalars at that depth', () => {
    assert.deepEqual(redact({ a: { b: { c: { d: { e: 1 } } } } }), { a: { b: { c: { d: '[truncated]' } } } });
    assert.deepEqual(redact({ a: { b: { c: { d: 1 } } } }), { a: { b: { c: { d: 1 } } } });
  });

  it('keeps at most 20 array items and says how many were dropped', () => {
    const items = Array.from({ length: 25 }, (_, index) => index);
    const redacted = redact(items) as unknown[];
    assert.equal(redacted.length, 21);
    assert.deepEqual(redacted.slice(0, 20), items.slice(0, 20));
    assert.equal(redacted[20], '[+5 more]');
    assert.equal((redact(items.slice(0, 20)) as unknown[]).length, 20);
  });

  it('does not change the object it was given', () => {
    const original = { password: 'p', text: 'hello', list: [1, 2, 3] };
    const before = JSON.stringify(original);
    redact(original);
    assert.equal(JSON.stringify(original), before);
  });
});

describe('createLogger', () => {
  const capture = (base?: Record<string, unknown>) => {
    const records: { level: LogLevel; record: Record<string, unknown> }[] = [];
    const logger = createLogger((level, line) => records.push({ level, record: parse(line) }), base);
    return { logger, records };
  };

  it('writes one JSON record per call with level, message, fields and a time', () => {
    const { logger, records } = capture();
    logger.info('started', { count: 2 });
    logger.warn('slow', { ms: 900 });
    logger.error('failed', { code: 'x' });
    assert.deepEqual(records.map((entry) => entry.level), ['info', 'warn', 'error']);
    assert.deepEqual(records.map((entry) => entry.record['message']), ['started', 'slow', 'failed']);
    assert.deepEqual(records.map((entry) => entry.record['level']), ['info', 'warn', 'error']);
    assert.equal(records[0]?.record['count'], 2);
    for (const entry of records) assert.ok(!Number.isNaN(Date.parse(String(entry.record['time']))));
  });

  it('redacts fields before they reach the sink', () => {
    const { logger, records } = capture();
    logger.info('call', { authorization: 'secret-value', description: 'private words', maxTokens: 500 });
    const text = JSON.stringify(records[0]?.record);
    assert.equal(text.includes('secret-value') || text.includes('private words'), false);
    assert.equal(records[0]?.record['authorization'], '[redacted]');
    assert.equal(records[0]?.record['description'], '[text:13 chars]');
    assert.equal(records[0]?.record['maxTokens'], 500);
  });

  it('redacts the base fields too', () => {
    const { logger, records } = capture({ token: 'secret-base', service: 'resolve' });
    logger.info('hello');
    assert.equal(records[0]?.record['token'], '[redacted]');
    assert.equal(records[0]?.record['service'], 'resolve');
  });

  it('merges child fields, lets a call override them, and leaves the parent alone', () => {
    const { logger, records } = capture({ service: 'resolve' });
    const child = logger.child({ tenantId: 'aurora', attempt: 1 });
    child.info('one', { attempt: 2 });
    logger.info('two');
    assert.equal(records[0]?.record['service'], 'resolve');
    assert.equal(records[0]?.record['tenantId'], 'aurora');
    assert.equal(records[0]?.record['attempt'], 2);
    assert.equal('tenantId' in (records[1]?.record ?? {}), false);
  });

  it('chains children', () => {
    const { logger, records } = capture();
    logger.child({ a: 1 }).child({ b: 2 }).info('x');
    assert.equal(records[0]?.record['a'], 1);
    assert.equal(records[0]?.record['b'], 2);
  });

  it('puts the time last so a field cannot forge it', () => {
    const { logger, records } = capture();
    logger.info('x', { time: 'yesterday' });
    assert.notEqual(records[0]?.record['time'], 'yesterday');
  });

  it('serialises an error field without its stack', () => {
    const { logger, records } = capture();
    logger.error('failed', { error: Object.assign(new Error('bad thing'), { code: 'EBAD' }) });
    assert.deepEqual(records[0]?.record['error'], { name: 'Error', message: 'bad thing', code: 'EBAD' });
  });
});

describe('createMemoryLogger', () => {
  it('collects JSON lines and shares them with children', () => {
    const { logger, lines } = createMemoryLogger();
    logger.info('one');
    logger.child({ x: 1 }).warn('two');
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => parse(line)['message']), ['one', 'two']);
  });
});
