import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { PolicyDoc } from '../../src/data/documents.ts';
import { canonicalJson, digestOf, sha256Hex } from '../../src/domain/canonical.ts';
import {
  CASE_ID_PATTERN,
  ID_PATTERN,
  IDEMPOTENCY_KEY_PATTERN,
  deriveCaseId,
  runIdFor,
  sortKeyOf,
  utcDay,
} from '../../src/domain/ids.ts';
import { derivePolicies, effectivePolicy } from '../../src/domain/policy.ts';
import { addMs, systemClock } from '../../src/domain/time.ts';

describe('canonicalJson', () => {
  it('sorts object keys at every depth and removes whitespace', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('gives the same text whatever the insertion order', () => {
    assert.equal(canonicalJson({ one: 1, two: 2, three: 3 }), canonicalJson({ three: 3, one: 1, two: 2 }));
  });

  it('drops undefined properties but keeps an undefined array item as null', () => {
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(canonicalJson([1, undefined, 3]), '[1,null,3]');
  });

  it('keeps explicit nulls and distinguishes them from missing properties', () => {
    assert.equal(canonicalJson({ a: null }), '{"a":null}');
    assert.notEqual(canonicalJson({ a: null }), canonicalJson({}));
  });

  it('writes scalars like JSON does', () => {
    assert.equal(canonicalJson('a"b\n'), '"a\\"b\\n"');
    assert.equal(canonicalJson(true), 'true');
    assert.equal(canonicalJson(-0), '0');
    assert.equal(canonicalJson(1.5e3), '1500');
    assert.equal(canonicalJson(null), 'null');
  });

  it('keeps array order, since order is meaningful', () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  it('refuses values that have no stable JSON form', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, () => 1, Symbol('x'), 10n, undefined]) {
      assert.throws(() => canonicalJson(bad), TypeError, String(typeof bad));
    }
    assert.throws(() => canonicalJson({ nested: [Number.NaN] }), TypeError);
  });
});

describe('digests', () => {
  it('sha256Hex matches the platform hash and is lower-case hex', () => {
    assert.equal(sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.match(sha256Hex(''), /^[0-9a-f]{64}$/);
  });

  it('hashes the UTF-8 bytes, not UTF-16 units', () => {
    assert.equal(sha256Hex('é'), createHash('sha256').update(Buffer.from('é', 'utf8')).digest('hex'));
  });

  it('digestOf is stable across key order and differs when any value changes', () => {
    const a = { amount: 1200, currency: 'USD', refs: ['inv_1', 'inv_2'] };
    const b = { refs: ['inv_1', 'inv_2'], currency: 'USD', amount: 1200 };
    assert.equal(digestOf(a), digestOf(b));
    assert.match(digestOf(a), /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(digestOf(a), digestOf({ ...a, amount: 1201 }));
    assert.notEqual(digestOf(a), digestOf({ ...a, refs: ['inv_2', 'inv_1'] }));
  });
});

describe('identifier helpers', () => {
  const TENANT = 'aurora';
  const PRINCIPAL = '00000000-0000-4000-8000-000000000001';
  const KEY = 'unit-test-key-0001';

  it('derives a stable case id from the idempotency scope', () => {
    const id = deriveCaseId(TENANT, PRINCIPAL, KEY);
    assert.match(id, CASE_ID_PATTERN);
    assert.equal(deriveCaseId(TENANT, PRINCIPAL, KEY), id);
  });

  it('separates every part of the scope', () => {
    const base = deriveCaseId(TENANT, PRINCIPAL, KEY);
    assert.notEqual(deriveCaseId('borealis', PRINCIPAL, KEY), base);
    assert.notEqual(deriveCaseId(TENANT, '00000000-0000-4000-8000-000000000002', KEY), base);
    assert.notEqual(deriveCaseId(TENANT, PRINCIPAL, 'unit-test-key-0002'), base);
  });

  it('does not let a boundary shift between parts collide', () => {
    assert.notEqual(deriveCaseId('ab', 'c', KEY), deriveCaseId('a', 'bc', KEY));
  });

  it('relies on validated parts, none of which can carry the newline delimiter', () => {
    assert.doesNotMatch('aurora\n', ID_PATTERN);
    assert.doesNotMatch('au\nrora', ID_PATTERN);
    assert.doesNotMatch('unit-test-key-0001\n', IDEMPOTENCY_KEY_PATTERN);
    assert.doesNotMatch('unit-test\nkey-0001-xx', IDEMPOTENCY_KEY_PATTERN);
  });

  it('uses the first 128 bits of the scope hash', () => {
    assert.equal(deriveCaseId(TENANT, PRINCIPAL, KEY), `case_${sha256Hex(`${TENANT}\n${PRINCIPAL}\n${KEY}`).slice(0, 32)}`);
  });

  it('names runs and sort keys predictably', () => {
    assert.equal(runIdFor(1), 'run-1');
    assert.equal(runIdFor(12), 'run-12');
    assert.equal(sortKeyOf('2026-01-02T03:04:05.000Z', 'case_x'), '2026-01-02T03:04:05.000Z~case_x');
  });

  it('orders sort keys by time first and id second', () => {
    const keys = [
      sortKeyOf('2026-01-02T00:00:00.000Z', 'b'),
      sortKeyOf('2026-01-01T00:00:00.000Z', 'z'),
      sortKeyOf('2026-01-02T00:00:00.000Z', 'a'),
    ].sort();
    assert.deepEqual(keys, [
      '2026-01-01T00:00:00.000Z~z',
      '2026-01-02T00:00:00.000Z~a',
      '2026-01-02T00:00:00.000Z~b',
    ]);
  });

  it('formats the UTC day, not the local day', () => {
    assert.equal(utcDay(new Date('2026-03-04T23:59:59.999Z')), '2026-03-04');
    assert.equal(utcDay(new Date('2026-03-05T00:00:00.000Z')), '2026-03-05');
  });

  it('accepts and rejects the documented shapes', () => {
    for (const ok of ['abc', 'acct_aurora_0001', 'credit-policy', 'a'.repeat(64)]) assert.match(ok, ID_PATTERN);
    for (const bad of ['ab', 'Abc', '1abc', 'a'.repeat(65), 'a b c', 'abc/def', '']) assert.doesNotMatch(bad, ID_PATTERN);
    assert.doesNotMatch('case_' + 'A'.repeat(32), CASE_ID_PATTERN);
    assert.doesNotMatch('case_' + 'a'.repeat(31), CASE_ID_PATTERN);
    assert.doesNotMatch('case_' + 'a'.repeat(33), CASE_ID_PATTERN);
    for (const ok of ['unit-test-key-0001', 'A.b_c~d-e0123456789', 'x'.repeat(64)]) assert.match(ok, IDEMPOTENCY_KEY_PATTERN);
    for (const bad of ['short', 'x'.repeat(65), 'has space in it 1234', 'slash/in/key-123456', 'émoji-key-12345678']) {
      assert.doesNotMatch(bad, IDEMPOTENCY_KEY_PATTERN);
    }
  });
});

describe('time helpers', () => {
  it('adds milliseconds without mutating the date', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const later = addMs(start, 1500);
    assert.equal(later.toISOString(), '2026-01-01T00:00:01.500Z');
    assert.equal(start.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(addMs(start, -1000).toISOString(), '2025-12-31T23:59:59.000Z');
  });

  it('exposes the system clock', () => {
    const before = Date.now();
    const read = systemClock.now().getTime();
    assert.ok(read >= before && read <= Date.now());
  });
});

describe('policy versions', () => {
  const clause = { clauseId: 'duplicate-charge', title: 'Duplicate charge', text: 'Refund a duplicate.', appliesTo: 'duplicate_charge' as const, maxCreditMinor: 5000 };
  const doc = (policyId: string, version: number, effectiveFrom: string, extra: Partial<PolicyDoc> = {}): PolicyDoc => ({
    id: `${policyId}__v${String(version)}`,
    tenantId: 'aurora',
    schemaVersion: 1,
    type: 'policy',
    policyId,
    version,
    effectiveFrom,
    currency: 'USD',
    clauses: [clause],
    ...extra,
  });
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  it('marks the highest visible version effective and the rest superseded', () => {
    const policies = derivePolicies([doc('credit-policy', 1, '2026-01-01T00:00:00.000Z'), doc('credit-policy', 2, '2026-05-01T00:00:00.000Z')], NOW);
    assert.deepEqual(policies.map((p) => [p.policyId, p.version, p.status]), [
      ['credit-policy', 2, 'effective'],
      ['credit-policy', 1, 'superseded'],
    ]);
  });

  it('hides a version that is not effective yet and keeps the previous one effective', () => {
    const docs = [doc('credit-policy', 1, '2026-01-01T00:00:00.000Z'), doc('credit-policy', 2, '2026-07-01T00:00:00.000Z')];
    assert.deepEqual(derivePolicies(docs, NOW).map((p) => [p.version, p.status]), [[1, 'effective']]);
    assert.equal(derivePolicies(docs, new Date('2026-07-01T00:00:00.000Z')).find((p) => p.version === 2)?.status, 'effective');
    assert.equal(derivePolicies(docs, new Date('2026-06-30T23:59:59.999Z')).some((p) => p.version === 2), false);
  });

  it('is deterministic about input order and sorts by policy id then newest version', () => {
    const docs = [
      doc('zeta-policy', 1, '2026-01-01T00:00:00.000Z'),
      doc('alpha-policy', 1, '2026-01-01T00:00:00.000Z'),
      doc('alpha-policy', 3, '2026-01-01T00:00:00.000Z'),
      doc('alpha-policy', 2, '2026-01-01T00:00:00.000Z'),
    ];
    const expected = [['alpha-policy', 3], ['alpha-policy', 2], ['alpha-policy', 1], ['zeta-policy', 1]];
    assert.deepEqual(derivePolicies(docs, NOW).map((p) => [p.policyId, p.version]), expected);
    assert.deepEqual(derivePolicies([...docs].reverse(), NOW).map((p) => [p.policyId, p.version]), expected);
  });

  it('returns only the policy body, never storage fields', () => {
    const [policy] = derivePolicies([doc('credit-policy', 1, '2026-01-01T00:00:00.000Z')], NOW);
    assert.deepEqual(Object.keys(policy ?? {}).sort(), ['clauses', 'currency', 'effectiveFrom', 'policyId', 'status', 'version']);
  });

  it('resolves the effective policy, optionally by id', () => {
    const docs = [
      doc('credit-policy', 1, '2026-01-01T00:00:00.000Z'),
      doc('credit-policy', 2, '2026-05-01T00:00:00.000Z'),
      doc('goodwill-policy', 1, '2026-02-01T00:00:00.000Z'),
    ];
    assert.equal(effectivePolicy(docs, NOW, 'credit-policy')?.version, 2);
    assert.equal(effectivePolicy(docs, NOW, 'goodwill-policy')?.version, 1);
    assert.equal(effectivePolicy(docs, NOW)?.policyId, 'credit-policy');
    assert.equal(effectivePolicy(docs, NOW, 'missing-policy'), null);
    assert.equal(effectivePolicy([], NOW), null);
    assert.equal(effectivePolicy(docs, new Date('2025-01-01T00:00:00.000Z')), null);
  });
});
