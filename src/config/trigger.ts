import { ConfigError } from './env.ts';

/**
 * Optional change-feed timer overrides. Unset values keep the platform defaults. The poll delay
 * also sets idle Cosmos DB request-unit consumption, so lowering it has a cost.
 */
export interface TriggerTuning {
  feedPollDelay?: number;
  leaseAcquireInterval?: number;
  leaseExpirationInterval?: number;
  leaseRenewInterval?: number;
}

const MIN_MS = 200;
const MAX_MS = 600_000;
const PLATFORM_DEFAULTS = { acquire: 13_000, expiration: 60_000, renew: 17_000 } as const;

const VARIABLES = [
  ['feedPollDelay', 'TRIGGER_FEED_POLL_MS'],
  ['leaseAcquireInterval', 'TRIGGER_LEASE_ACQUIRE_MS'],
  ['leaseExpirationInterval', 'TRIGGER_LEASE_EXPIRATION_MS'],
  ['leaseRenewInterval', 'TRIGGER_LEASE_RENEW_MS'],
] as const;

export function readTriggerTuning(env: Readonly<Record<string, string | undefined>>): TriggerTuning {
  const issues: string[] = [];
  const tuning: TriggerTuning = {};
  for (const [key, name] of VARIABLES) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const value = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(value >= MIN_MS && value <= MAX_MS)) {
      issues.push(`${name} must be an integer between ${String(MIN_MS)} and ${String(MAX_MS)}`);
      continue;
    }
    tuning[key] = value;
  }
  const expiration = tuning.leaseExpirationInterval ?? PLATFORM_DEFAULTS.expiration;
  if ((tuning.leaseRenewInterval ?? PLATFORM_DEFAULTS.renew) >= expiration) {
    issues.push('TRIGGER_LEASE_RENEW_MS must be lower than the lease expiration interval');
  }
  if ((tuning.leaseAcquireInterval ?? PLATFORM_DEFAULTS.acquire) >= expiration) {
    issues.push('TRIGGER_LEASE_ACQUIRE_MS must be lower than the lease expiration interval');
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return tuning;
}
