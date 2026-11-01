import type { ReferenceDoc } from '../../src/data/documents.ts';
import type { SeedStore } from '../../tools/seed/seeder.ts';

export type SeedOperation = 'create' | 'read' | 'listIds';

export interface MemorySeedStore extends SeedStore {
  /** Backing storage, keyed by `tenantId/id`. Share one map between stores to model one container. */
  readonly docs: Map<string, Record<string, unknown>>;
  readonly counts: Record<SeedOperation, number>;
  /** Runs before every operation; throw from it to inject a failure. */
  before?: (operation: SeedOperation, tenantId: string, id: string) => void | Promise<void>;
}

const keyOf = (tenantId: string, id: string): string => `${tenantId}/${id}`;

/** Mimics the system properties Cosmos DB adds, so comparisons must ignore them as the real store requires. */
function stored(doc: ReferenceDoc, sequence: number): Record<string, unknown> {
  return { ...structuredClone(doc), _rid: `rid${String(sequence)}`, _etag: `"etag-${String(sequence)}"`, _ts: 1_700_000_000 + sequence };
}

export function createMemorySeedStore(docs: Map<string, Record<string, unknown>> = new Map()): MemorySeedStore {
  const store: MemorySeedStore = {
    docs,
    counts: { create: 0, read: 0, listIds: 0 },
    async create(doc) {
      store.counts.create += 1;
      await store.before?.('create', doc.tenantId, doc.id);
      const key = keyOf(doc.tenantId, doc.id);
      if (docs.has(key)) return 'exists';
      docs.set(key, stored(doc, docs.size + 1));
      return 'created';
    },
    async read(tenantId, id) {
      store.counts.read += 1;
      await store.before?.('read', tenantId, id);
      const found = docs.get(keyOf(tenantId, id));
      return found === undefined ? null : structuredClone(found);
    },
    async listIds(tenantId, type) {
      store.counts.listIds += 1;
      await store.before?.('listIds', tenantId, type);
      return [...docs.values()]
        .filter((doc) => doc['tenantId'] === tenantId && doc['type'] === type)
        .map((doc) => doc['id'] as string);
    },
  };
  return store;
}

/** A transient dependency failure shaped like the SDK's, so retry logic treats it as retryable. */
export function transientError(retryAfterInMs?: number): Error {
  return Object.assign(new Error('service unavailable'), { code: 503, ...(retryAfterInMs === undefined ? {} : { retryAfterInMs }) });
}
