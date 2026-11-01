import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planFeedUpdate, type ShownEntries } from '../../web/src/feed-plan.ts';
import type { UsageEvent } from '../../web/src/types.ts';

const NOTHING: ShownEntries = { newest: null, revisions: new Map() };

const revisionOf = (event: UsageEvent): string => JSON.stringify(event);

function call(seq: number, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventId: `usage-run-1-${String(seq)}`,
    runId: 'run-1',
    seq,
    kind: 'model',
    name: 'chat',
    outcome: 'succeeded',
    attempt: 1,
    at: '2026-10-29T10:00:00.000Z',
    inputTokens: 120,
    outputTokens: 40,
    tokenQuality: 'measured',
    costMicroUsd: 900,
    costQuality: 'estimated',
    latencyMs: 640,
    errorCode: null,
    ...overrides,
  };
}

/** What a list holds once it has drawn these entries. */
function drawn(...events: readonly UsageEvent[]): ShownEntries {
  return {
    newest: events.reduce<number | null>((newest, event) => (newest === null || event.seq > newest ? event.seq : newest), null),
    revisions: new Map(events.map((event) => [event.seq, revisionOf(event)])),
  };
}

/** A call as it is while in flight: reserved, with nothing measured yet. */
const inFlight = (seq: number): UsageEvent =>
  call(seq, { outcome: 'reserved', inputTokens: null, outputTokens: null, tokenQuality: 'unknown', costMicroUsd: null, costQuality: 'unknown', latencyMs: null });

describe('planFeedUpdate', () => {
  it('treats every entry of the first page as new, in the order read', () => {
    const page = [call(1), call(2), call(3)];
    const plan = planFeedUpdate(page, NOTHING, revisionOf);
    assert.deepEqual(plan.fresh, page);
    assert.deepEqual(plan.changed, []);
  });

  it('has nothing to do for an empty page', () => {
    assert.deepEqual(planFeedUpdate([], NOTHING, revisionOf), { fresh: [], changed: [] });
    assert.deepEqual(planFeedUpdate([], drawn(call(1)), revisionOf), { fresh: [], changed: [] });
  });

  it('has nothing to do when the page it re-reads is exactly what is shown', () => {
    const page = [call(1), call(2)];
    assert.deepEqual(planFeedUpdate(page, drawn(...page), revisionOf), { fresh: [], changed: [] });
    assert.deepEqual(planFeedUpdate(page, drawn(...page)), { fresh: [], changed: [] });
  });

  it('adds only the entries after the newest one shown', () => {
    const plan = planFeedUpdate([call(1), call(2), call(3), call(4)], drawn(call(1), call(2)), revisionOf);
    assert.deepEqual(
      plan.fresh.map((event) => event.seq),
      [3, 4],
    );
    assert.deepEqual(plan.changed, []);
  });

  it('treats a newest of 0 as something shown, not as nothing shown', () => {
    assert.deepEqual(
      planFeedUpdate([call(1)], { newest: 0, revisions: new Map() }).fresh.map((event) => event.seq),
      [1],
    );
    assert.deepEqual(planFeedUpdate([{ seq: 0 }], { newest: 0, revisions: new Map() }).fresh, []);
  });

  describe('a call that was in flight when it was read', () => {
    it('is drawn again once it has settled, and the calls after it are added', () => {
      const shown = drawn(call(1), inFlight(2));
      const settled = call(2, { name: 'submit_proposal', kind: 'tool', tokenQuality: 'not_applicable', costQuality: 'not_applicable', inputTokens: null, outputTokens: null, costMicroUsd: null });
      const plan = planFeedUpdate([call(1), settled, inFlight(3)], shown, revisionOf);
      assert.deepEqual(plan.changed, [settled]);
      assert.deepEqual(plan.fresh, [inFlight(3)]);
    });

    it('is drawn again when it settles as failed, ambiguous or refused', () => {
      for (const outcome of ['failed', 'ambiguous', 'rejected_by_code'] as const) {
        const plan = planFeedUpdate([call(1, { outcome, errorCode: 'x' })], drawn(inFlight(1)), revisionOf);
        assert.deepEqual(
          plan.changed.map((event) => event.outcome),
          [outcome],
          outcome,
        );
        assert.deepEqual(plan.fresh, [], outcome);
      }
    });

    it('is left as it is while it is still in flight', () => {
      assert.deepEqual(planFeedUpdate([inFlight(1)], drawn(inFlight(1)), revisionOf), { fresh: [], changed: [] });
    });

    it('is not drawn again by a list that has no way to tell an entry changed', () => {
      assert.deepEqual(planFeedUpdate([call(1)], drawn(inFlight(1))), { fresh: [], changed: [] });
    });
  });

  it('lists changed entries in the order read', () => {
    const shown = drawn(inFlight(1), inFlight(2), inFlight(3));
    const plan = planFeedUpdate([call(1), inFlight(2), call(3)], shown, revisionOf);
    assert.deepEqual(
      plan.changed.map((event) => event.seq),
      [1, 3],
    );
  });

  it('skips an entry behind the newest one that was never shown', () => {
    const shown = drawn(call(1), call(4));
    assert.deepEqual(planFeedUpdate([call(1), call(2), call(4)], shown, revisionOf), { fresh: [], changed: [] });
  });

  it('treats an empty revision as a revision', () => {
    const plan = planFeedUpdate([{ seq: 1 }], { newest: 1, revisions: new Map([[1, '']]) }, () => 'now');
    assert.deepEqual(plan.changed, [{ seq: 1 }]);
  });

  it('does not ask for a revision of an entry it is adding', () => {
    const asked: number[] = [];
    planFeedUpdate([call(1), call(2)], drawn(call(1)), (event) => {
      asked.push(event.seq);
      return revisionOf(event);
    });
    assert.deepEqual(asked, [1]);
  });

  it('leaves what it is given alone', () => {
    const page = Object.freeze([Object.freeze(call(1)), Object.freeze(call(2))]);
    const shown: ShownEntries = Object.freeze({ newest: 1, revisions: Object.freeze(new Map([[1, 'old']])) });
    const plan = planFeedUpdate(page, shown, revisionOf);
    assert.equal(plan.fresh.length, 1);
    assert.equal(plan.changed.length, 1);
    assert.equal(shown.revisions.get(1), 'old');
  });
});
