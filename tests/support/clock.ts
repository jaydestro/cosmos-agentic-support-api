import type { Clock } from '../../src/domain/time.ts';

export interface TestClock extends Clock {
  advance(ms: number): void;
  set(at: Date | string): void;
}

/** A clock that only moves when the test says so. */
export function createTestClock(start: Date | string): TestClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
    set(at) {
      current = new Date(at).getTime();
    },
  };
}
