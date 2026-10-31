import { isTransientDependencyError } from '../data/errors.ts';
import { CaseWriteError } from './store.ts';

/** A lost race re-reads and re-evaluates every rule, which is also how a repeated request is recognised. */
export const MAX_ATTEMPTS = 3;

/**
 * Runs `attempt` again when it lost a write race or met a transient dependency error. Each run starts
 * from fresh reads, so nothing decided by an earlier run is trusted. When the race is lost every
 * time, `onConflict` supplies the answer; a transient error that never clears is rethrown.
 */
export async function withRetries<T>(attempt: () => Promise<T>, onConflict: () => T): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      const conflict = error instanceof CaseWriteError;
      if (!conflict && !isTransientDependencyError(error)) throw error;
      if (tries >= MAX_ATTEMPTS) {
        if (conflict) return onConflict();
        throw error;
      }
    }
  }
}
