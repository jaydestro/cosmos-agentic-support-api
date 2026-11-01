import { AsyncLocalStorage } from 'node:async_hooks';

export interface RuTotals {
  /** Cosmos DB operations that reported a request charge. */
  measuredOperations: number;
  /** Sum of the reported charges in request units. */
  requestUnits: number;
  /** Operations that returned no charge. Unknown is not zero, so these are counted apart. */
  unmeasuredOperations: number;
}

const storage = new AsyncLocalStorage<RuTotals>();

export const newRuTotals = (): RuTotals => ({ measuredOperations: 0, requestUnits: 0, unmeasuredOperations: 0 });

/** Runs `fn` so that every data-layer call inside it adds to `totals`, even when `fn` throws. */
export function runWithRuMeter<T>(totals: RuTotals, fn: () => Promise<T>): Promise<T> {
  return storage.run(totals, fn);
}

export function recordCharge(charge: number | undefined): void {
  const totals = storage.getStore();
  if (totals === undefined) return;
  if (typeof charge === 'number' && Number.isFinite(charge)) {
    totals.measuredOperations += 1;
    totals.requestUnits += charge;
  } else {
    totals.unmeasuredOperations += 1;
  }
}
