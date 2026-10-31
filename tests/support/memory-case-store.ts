import type { CaseDoc, CaseStatus, ProposalDoc, RunDoc, StoredDoc, TimelineDoc, UsageEventDoc } from '../../src/cases/documents.ts';
import {
  CASE_LIST_FIELDS,
  CaseWriteError,
  assertBatch,
  byRevision,
  byVersion,
  pageOf,
  type CaseListRow,
  type CaseOp,
  type CaseStore,
  type DocKinds,
  type Versioned,
} from '../../src/cases/store.ts';
import { WORK_FIELDS, WORK_STATE_TYPE, workStateOf, type WorkRow } from '../../src/cases/work.ts';
import { stripSystemFields } from '../../src/data/system.ts';
import { parseOutboxDoc, type OutboxDoc } from '../../src/outbox/types.ts';
import type { OutboxStore } from '../../src/outbox/store.ts';

interface Row {
  doc: StoredDoc;
  etag: string;
}

export interface BatchRecord {
  tenantId: string;
  caseId: string;
  ops: { op: CaseOp['op']; type: string; id: string }[];
}

export interface CaseCall {
  method: keyof CaseStore;
  tenantId: string;
  caseId: string | null;
}

export interface MemoryCases {
  store: CaseStore;
  /** The outbox facade over the same rows, as the `cases` container serves both. */
  outbox: OutboxStore;
  /** Every tenant-scoped call, in order, so a test can prove which partition was used. */
  calls: CaseCall[];
  /** Every committed batch, in order, so a test can prove what was written atomically. */
  batches: BatchRecord[];
  /**
   * Fault injection. `beforeCommit` may throw to simulate a failure with nothing written;
   * `afterCommit` may throw to simulate a lost response after the batch was applied.
   */
  hooks: { beforeCommit?: (batch: BatchRecord) => void; afterCommit?: (batch: BatchRecord) => void };
  /** Stored documents of one partition, optionally of one type, in insertion order. */
  docs(tenantId: string, caseId: string, type?: string): StoredDoc[];
  doc<K extends keyof DocKinds>(kind: K, tenantId: string, caseId: string, id: string): DocKinds[K];
  outboxDocs(): OutboxDoc[];
}

const keyOf = (tenantId: string, caseId: string, id: string): string => `${tenantId}|${caseId}|${id}`;

const matchesStatus = (doc: CaseDoc, status: CaseStatus | null, now: Date): boolean => {
  if (status === null) return true;
  const expiry = doc.latestProposal?.approvalExpiresAt ?? null;
  const nowIso = now.toISOString();
  if (status === 'awaiting_approval') return doc.status === 'awaiting_approval' && expiry !== null && expiry > nowIso;
  if (status === 'expired') {
    return doc.status === 'expired' || (doc.status === 'awaiting_approval' && expiry !== null && expiry <= nowIso);
  }
  return doc.status === status;
};

/**
 * Mirrors the Cosmos DB case store: batches are atomic per `[tenantId, caseId]` partition, creates
 * are create-only, replaces are ETag-conditional, every write issues a new ETag, and reads are
 * scoped to one tenant. Unit tests and the integration conformance suite run the same checks on it.
 */
export function createMemoryCases(): MemoryCases {
  const rows = new Map<string, Row>();
  const calls: CaseCall[] = [];
  const batches: BatchRecord[] = [];
  const hooks: MemoryCases['hooks'] = {};
  let counter = 0;
  const nextEtag = (): string => {
    counter += 1;
    return `"etag-${String(counter)}"`;
  };

  const partition = (tenantId: string, caseId: string): Row[] =>
    [...rows.values()].filter((row) => row.doc.tenantId === tenantId && row.doc.caseId === caseId);
  const ofType = <T extends StoredDoc>(tenantId: string, caseId: string, type: T['type']): Row[] =>
    partition(tenantId, caseId).filter((row) => row.doc.type === type);
  const versioned = <T extends StoredDoc>(row: Row): Versioned<T> => ({ doc: structuredClone(row.doc) as T, etag: row.etag });
  const call = (method: CaseCall['method'], tenantId: string, caseId: string | null): void => {
    calls.push({ method, tenantId, caseId });
  };

  const store: CaseStore = {
    get(kind, tenantId, caseId, id) {
      call('get', tenantId, caseId);
      const row = rows.get(keyOf(tenantId, caseId, id));
      return Promise.resolve(row !== undefined && row.doc.type === kind ? versioned<DocKinds[typeof kind]>(row) : null);
    },

    commit(tenantId, caseId, ops) {
      call('commit', tenantId, caseId);
      try {
        assertBatch(tenantId, caseId, ops);
        const record: BatchRecord = {
          tenantId,
          caseId,
          ops: ops.map((op) => ({ op: op.op, type: op.doc.type, id: op.doc.id })),
        };
        hooks.beforeCommit?.(record);
        const staged = new Map<string, Row>();
        const etags = ops.map((op, index) => {
          const key = keyOf(tenantId, caseId, op.doc.id);
          const existing = staged.get(key) ?? rows.get(key);
          if (op.op === 'create') {
            if (existing !== undefined) throw new CaseWriteError('exists', index);
          } else {
            if (existing === undefined) throw new CaseWriteError('missing', index);
            if (existing.etag !== op.etag) throw new CaseWriteError('stale', index);
          }
          const etag = nextEtag();
          staged.set(key, { doc: structuredClone(stripSystemFields(op.doc)), etag });
          return etag;
        });
        for (const [key, row] of staged) rows.set(key, row);
        batches.push(record);
        hooks.afterCommit?.(record);
        return Promise.resolve(etags);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    listRuns(tenantId, caseId) {
      call('listRuns', tenantId, caseId);
      const runs = ofType<RunDoc>(tenantId, caseId, 'run').map((row) => structuredClone(row.doc as RunDoc));
      return Promise.resolve(runs.sort(byRevision));
    },

    listProposals(tenantId, caseId) {
      call('listProposals', tenantId, caseId);
      const proposals = ofType<ProposalDoc>(tenantId, caseId, 'proposal').map((row) => structuredClone(row.doc as ProposalDoc));
      return Promise.resolve(proposals.sort(byVersion));
    },

    listTimeline(tenantId, caseId, afterSeq, limit) {
      call('listTimeline', tenantId, caseId);
      const items = ofType<TimelineDoc>(tenantId, caseId, 'timeline')
        .map((row) => structuredClone(row.doc as TimelineDoc))
        .filter((doc) => doc.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq);
      return Promise.resolve(pageOf(items.slice(0, limit + 1), limit, (doc) => doc.seq));
    },

    listUsage(tenantId, caseId, runId, afterSeq, limit) {
      call('listUsage', tenantId, caseId);
      const items = ofType<UsageEventDoc>(tenantId, caseId, 'usage')
        .map((row) => structuredClone(row.doc as UsageEventDoc))
        .filter((doc) => doc.runId === runId && doc.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq);
      return Promise.resolve(pageOf(items.slice(0, limit + 1), limit, (doc) => doc.seq));
    },

    listReservedUsage(tenantId, caseId, runId) {
      call('listReservedUsage', tenantId, caseId);
      const reserved = ofType<UsageEventDoc>(tenantId, caseId, 'usage').filter(
        (row) => (row.doc as UsageEventDoc).runId === runId && (row.doc as UsageEventDoc).outcome === 'reserved',
      );
      return Promise.resolve(reserved.map((row) => versioned<UsageEventDoc>(row)));
    },

    listCases(tenantId, status, limit, after, now) {
      call('listCases', tenantId, null);
      const cases = [...rows.values()]
        .filter((row) => row.doc.tenantId === tenantId && row.doc.type === 'case')
        .map((row) => row.doc as CaseDoc)
        .filter((doc) => matchesStatus(doc, status, now) && (after === null || doc.sortKey < after))
        .sort((a, b) => (a.sortKey === b.sortKey ? 0 : a.sortKey < b.sortKey ? 1 : -1))
        .slice(0, limit + 1)
        .map((doc) => {
          const projected: Record<string, unknown> = {};
          for (const field of CASE_LIST_FIELDS) projected[field] = doc[field];
          return structuredClone(projected) as unknown as CaseListRow;
        });
      return Promise.resolve(pageOf(cases, limit, (row) => row.sortKey));
    },

    listWork(tenantId, state, limit, after, now) {
      call('listWork', tenantId, null);
      const type = WORK_STATE_TYPE[state];
      const found = [...rows.values()]
        .filter((row) => row.doc.tenantId === tenantId && row.doc.type === type)
        .map((row) => row.doc as unknown as WorkRow)
        .filter((doc) => workStateOf(doc, now) === state && (after === null || doc.workKey < after))
        .sort((a, b) => (a.workKey === b.workKey ? 0 : a.workKey < b.workKey ? 1 : -1))
        .slice(0, limit + 1)
        .map((doc) => {
          const projected: Record<string, unknown> = {};
          for (const field of WORK_FIELDS[type]) projected[field] = (doc as unknown as Record<string, unknown>)[field];
          return structuredClone(projected) as unknown as WorkRow;
        });
      return Promise.resolve(pageOf(found, limit, (row) => row.workKey));
    },
  };

  const outbox: OutboxStore = {
    read(tenantId, caseId, id) {
      const row = rows.get(keyOf(tenantId, caseId, id));
      if (row === undefined || row.doc.type !== 'outbox') return Promise.resolve(null);
      return Promise.resolve(parseOutboxDoc({ ...structuredClone(row.doc), _etag: row.etag }));
    },
    create(doc) {
      const key = keyOf(doc.tenantId, doc.caseId, doc.id);
      if (rows.has(key)) return Promise.resolve(false);
      rows.set(key, { doc: structuredClone(stripSystemFields(doc)), etag: nextEtag() });
      return Promise.resolve(true);
    },
    replace(doc, etag) {
      const key = keyOf(doc.tenantId, doc.caseId, doc.id);
      const current = rows.get(key);
      if (current === undefined || current.etag !== etag) return Promise.resolve(null);
      const next: Row = { doc: structuredClone(stripSystemFields(doc)), etag: nextEtag() };
      rows.set(key, next);
      return Promise.resolve(parseOutboxDoc({ ...structuredClone(next.doc), _etag: next.etag }));
    },
  };

  return {
    store,
    outbox,
    calls,
    batches,
    hooks,
    docs: (tenantId, caseId, type) =>
      partition(tenantId, caseId)
        .filter((row) => type === undefined || row.doc.type === type)
        .map((row) => structuredClone(row.doc)),
    doc(kind, tenantId, caseId, id) {
      const row = rows.get(keyOf(tenantId, caseId, id));
      if (row === undefined || row.doc.type !== kind) throw new Error(`no ${kind} document ${id} in ${tenantId}/${caseId}`);
      return structuredClone(row.doc) as DocKinds[typeof kind];
    },
    outboxDocs: () => [...rows.values()].filter((row) => row.doc.type === 'outbox').map((row) => structuredClone(row.doc) as OutboxDoc),
  };
}
