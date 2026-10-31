import { isTransientDependencyError } from '../../src/data/errors.ts';
import { REFERENCE_DOC_TYPES, type ReferenceDoc } from '../../src/data/documents.ts';
import { stripSystemFields } from '../../src/data/system.ts';
import { canonicalJson } from '../../src/domain/canonical.ts';

/** The only operations the seeder may perform: create-only writes and reads. No replace, upsert or delete. */
export interface SeedStore {
  create(doc: ReferenceDoc): Promise<'created' | 'exists'>;
  read(tenantId: string, id: string): Promise<Record<string, unknown> | null>;
  listIds(tenantId: string, type: ReferenceDoc['type']): Promise<string[]>;
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: Omit<RetryOptions, 'sleep'> = { attempts: 5, baseDelayMs: 500, maxDelayMs: 8000 };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 0;
  const hinted = (error as { retryAfterInMs?: unknown }).retryAfterInMs;
  return typeof hinted === 'number' && Number.isFinite(hinted) && hinted > 0 ? hinted : 0;
}

/** Retries only transient failures, a bounded number of times, honouring a server retry hint. */
export async function withRetry<T>(operation: () => Promise<T>, retry: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retry.attempts || !isTransientDependencyError(error)) throw error;
      const backoff = retry.baseDelayMs * 2 ** (attempt - 1);
      await retry.sleep(Math.min(retry.maxDelayMs, Math.max(retryAfterMs(error), backoff)));
    }
  }
}

export interface DriftEntry {
  tenantId: string;
  id: string;
}

export interface ReadBackResult {
  checked: number;
  missing: string[];
  mismatched: string[];
  notListed: string[];
}

export interface SeedResult {
  documents: number;
  created: number;
  unchanged: number;
  /** Stored documents that differ from the fixtures. They are reported and never overwritten. */
  drift: DriftEntry[];
  readBack: ReadBackResult;
  readBackOk: boolean;
}

export interface SeedRun {
  docs: readonly ReferenceDoc[];
  writer: SeedStore;
  /** A reader built on its own client, so the check does not reuse the writer's connection or cache. */
  verifier: SeedStore;
  retry?: Partial<RetryOptions>;
  log?: (line: string) => void;
}

const ALLOWED_TYPES: ReadonlySet<string> = new Set(REFERENCE_DOC_TYPES);

const sameDocument = (stored: Record<string, unknown>, desired: ReferenceDoc): boolean =>
  canonicalJson(stripSystemFields(stored)) === canonicalJson(desired);

const label = (doc: Pick<ReferenceDoc, 'tenantId' | 'id'>): string => `${doc.tenantId}/${doc.id}`;

export class SeedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SeedError';
    this.code = code;
  }
}

export async function runSeed(run: SeedRun): Promise<SeedResult> {
  const retry: RetryOptions = { ...DEFAULT_RETRY, sleep: defaultSleep, ...run.retry };
  const log = run.log ?? ((): void => undefined);

  for (const doc of run.docs) {
    if (!ALLOWED_TYPES.has(doc.type)) throw new SeedError('type_not_allowed', `Document ${label(doc)} has a type the seeder may not write.`);
  }

  let created = 0;
  let unchanged = 0;
  const drift: DriftEntry[] = [];

  for (const doc of run.docs) {
    const outcome = await withRetry(() => run.writer.create(doc), retry);
    if (outcome === 'created') {
      created += 1;
      continue;
    }
    const stored = await withRetry(() => run.writer.read(doc.tenantId, doc.id), retry);
    if (stored === null) throw new SeedError('conflict_without_document', `Document ${label(doc)} conflicted but could not be read back.`);
    if (sameDocument(stored, doc)) {
      unchanged += 1;
    } else {
      drift.push({ tenantId: doc.tenantId, id: doc.id });
      log(`drift: ${label(doc)} differs from the fixture and was left unchanged`);
    }
  }

  const driftKeys = new Set(drift.map(label));
  const readBack: ReadBackResult = { checked: 0, missing: [], mismatched: [], notListed: [] };
  for (const doc of run.docs) {
    readBack.checked += 1;
    const stored = await withRetry(() => run.verifier.read(doc.tenantId, doc.id), retry);
    if (stored === null) readBack.missing.push(label(doc));
    else if (!driftKeys.has(label(doc)) && !sameDocument(stored, doc)) readBack.mismatched.push(label(doc));
  }

  const groups = new Map<string, ReferenceDoc[]>();
  for (const doc of run.docs) {
    const key = `${doc.tenantId}\u0000${doc.type}`;
    groups.set(key, [...(groups.get(key) ?? []), doc]);
  }
  for (const docs of groups.values()) {
    const [first] = docs;
    if (first === undefined) continue;
    const listed = new Set(await withRetry(() => run.verifier.listIds(first.tenantId, first.type), retry));
    for (const doc of docs) if (!listed.has(doc.id)) readBack.notListed.push(label(doc));
  }

  return {
    documents: run.docs.length,
    created,
    unchanged,
    drift,
    readBack,
    readBackOk: readBack.missing.length === 0 && readBack.mismatched.length === 0 && readBack.notListed.length === 0,
  };
}
