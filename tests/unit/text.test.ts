import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clip } from '../../src/domain/text.ts';

describe('clip', () => {
  it('returns text that already fits, unchanged', () => {
    assert.equal(clip('abc', 3), 'abc');
    assert.equal(clip('abc', 10), 'abc');
    assert.equal(clip('', 0), '');
  });

  it('ends a clipped text with an ellipsis inside the limit', () => {
    assert.equal(clip('abcdef', 4), 'abc…');
    assert.equal(clip('abcdef', 1), '…');
  });

  it('returns nothing when there is no room', () => {
    assert.equal(clip('abc', 0), '');
    assert.equal(clip('abc', -5), '');
  });

  it('never leaves half of a surrogate pair', () => {
    const text = '😀'.repeat(10);
    for (let max = 1; max < text.length; max += 1) {
      const clipped = clip(text, max);
      assert.ok(clipped.length <= max, `max ${String(max)} gave ${String(clipped.length)}`);
      assert.ok(!/\p{Cs}/u.test(clipped), `lone surrogate at max ${String(max)}`);
    }
  });
});
