import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatMinor } from '../../src/domain/money.ts';

describe('formatMinor', () => {
  it('formats two minor-unit digits for both supported currencies', () => {
    assert.equal(formatMinor(4900, 'USD'), 'USD 49.00');
    assert.equal(formatMinor(5, 'EUR'), 'EUR 0.05');
    assert.equal(formatMinor(0, 'USD'), 'USD 0.00');
    assert.equal(formatMinor(10_000_000, 'EUR'), 'EUR 100000.00');
    assert.equal(formatMinor(1234, 'USD'), 'USD 12.34');
  });
});
