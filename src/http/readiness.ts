import type { Clock } from '../domain/time.ts';
import type { Logger } from '../telemetry/log.ts';

export interface Readiness {
  isReady(): Promise<boolean>;
}

export interface ReadinessOptions {
  ping: () => Promise<void>;
  clock: Clock;
  logger: Logger;
  okTtlMs?: number;
  failTtlMs?: number;
}

/**
 * `/ready` is anonymous, so the dependency probe is cached and concurrent callers share one
 * in-flight probe. That bounds the request units an unauthenticated caller can cause.
 */
export function createReadiness(options: ReadinessOptions): Readiness {
  const okTtlMs = options.okTtlMs ?? 15_000;
  const failTtlMs = options.failTtlMs ?? 3_000;
  let cached: { ready: boolean; until: number } | undefined;
  let inflight: Promise<boolean> | undefined;

  const probe = async (): Promise<boolean> => {
    let ready = false;
    try {
      await options.ping();
      ready = true;
    } catch (error) {
      options.logger.warn('readiness probe failed', { error });
    }
    cached = { ready, until: options.clock.now().getTime() + (ready ? okTtlMs : failTtlMs) };
    return ready;
  };

  return {
    isReady() {
      if (cached !== undefined && cached.until > options.clock.now().getTime()) return Promise.resolve(cached.ready);
      // `finally` runs after this assignment even if the probe settles immediately.
      inflight ??= probe().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
