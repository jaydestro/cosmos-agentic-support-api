import type { Container, JSONObject, OperationInput, OperationResponse, SqlParameter } from '@azure/cosmos';
import { CASE_LIMITS, RECOVERABLE_GRACE_MS } from '../config/limits.ts';
import { projection } from '../data/documents.ts';
import { isStatus } from '../data/errors.ts';
import { stripSystemFields } from '../data/system.ts';
import type { OutboxDoc } from '../outbox/types.ts';
import { recordCharge } from '../telemetry/ru.ts';
import type {
  AdmissionDoc,
  CaseDoc,
  CaseStatus,
  CaseSummarySource,
  CreditResultDoc,
  IdempotencyDoc,
  ProposalDoc,
  RunDoc,
  StoredDoc,
  TimelineDoc,
  UsageEventDoc,
  WorkState,
} from './documents.ts';
import { WORK_FIELDS, type WorkRow, type WorkType } from './work.ts';

/** Cosmos DB transactional batches hold at most 100 operations. */
export const MAX_BATCH_OPERATIONS = 100;

export interface Versioned<T> {
  doc: T;
  /** The ETag to pass to the next conditional write of this document. */
  etag: string;
}

/** Document kinds that can be point-read; the key is the stored `type` discriminator. */
export interface DocKinds {
  case: CaseDoc;
  idempotency: IdempotencyDoc;
  run: RunDoc;
  usage: UsageEventDoc;
  proposal: ProposalDoc;
  credit_result: CreditResultDoc;
  outbox: OutboxDoc;
  admission: AdmissionDoc;
}

export type CaseOp = { op: 'create'; doc: StoredDoc } | { op: 'replace'; doc: StoredDoc; etag: string };

export interface Page<T, C> {
  items: T[];
  /** Cursor of the last returned item when more remain, otherwise `null`. */
  next: C | null;
}

export type CaseListRow = CaseSummarySource & { sortKey: string };

/**
 * Persistence of the case aggregate. Every write is one transactional batch inside a single
 * `[tenantId, caseId]` logical partition, so a state change, its timeline items and its outbox
 * work either all commit or none does. Every read is scoped to the tenant by construction.
 */
export interface CaseStore {
  get<K extends keyof DocKinds>(kind: K, tenantId: string, caseId: string, id: string): Promise<Versioned<DocKinds[K]> | null>;
  /**
   * Applies every operation atomically and returns the new ETags in operation order.
   * Throws `CaseWriteError` when a create finds its id taken (`exists`), a replace carries a stale
   * ETag (`stale`) or replaces a missing document (`missing`); nothing is written in those cases.
   */
  commit(tenantId: string, caseId: string, ops: readonly CaseOp[]): Promise<string[]>;
  /** Oldest run first. A case holds at most `CASE_LIMITS.maxRuns` runs. */
  listRuns(tenantId: string, caseId: string): Promise<RunDoc[]>;
  /** Lowest version first. A case holds at most `CASE_LIMITS.maxRuns` proposals. */
  listProposals(tenantId: string, caseId: string): Promise<ProposalDoc[]>;
  /** Oldest first by sequence number, strictly after `afterSeq`. */
  listTimeline(tenantId: string, caseId: string, afterSeq: number, limit: number): Promise<Page<TimelineDoc, number>>;
  listUsage(tenantId: string, caseId: string, runId: string, afterSeq: number, limit: number): Promise<Page<UsageEventDoc, number>>;
  /** Calls that were reserved but never settled, which only a crashed handler leaves behind. */
  listReservedUsage(tenantId: string, caseId: string, runId: string): Promise<Versioned<UsageEventDoc>[]>;
  /**
   * Newest case first, one tenant only. `status` is the derived status: a pending approval whose
   * expiry has passed counts as `expired` even though no writer has materialised it yet.
   */
  listCases(tenantId: string, status: CaseStatus | null, limit: number, after: string | null, now: Date): Promise<Page<CaseListRow, string>>;
  /**
   * Operator work in one state, newest first, one tenant only. The state is derived from the stored
   * documents (`workStateOf`) and `after` is the `workKey` of the last item of the previous page.
   */
  listWork(tenantId: string, state: WorkState, limit: number, after: string | null, now: Date): Promise<Page<WorkRow, string>>;
}

export type WriteFailure = 'exists' | 'stale' | 'missing';

export class CaseWriteError extends Error {
  readonly reason: WriteFailure;
  /** Position in the batch of the operation that failed. */
  readonly index: number;
  constructor(reason: WriteFailure, index: number) {
    super(`case write rejected: ${reason} (operation ${String(index)})`);
    this.name = 'CaseWriteError';
    this.reason = reason;
    this.index = index;
  }
}

/** A batch failed for a reason other than a precondition. `statusCode` feeds the transient-error check. */
export class CaseBatchError extends Error {
  readonly statusCode: number;
  readonly index: number;
  constructor(statusCode: number, index: number) {
    super(`case batch failed with status ${String(statusCode)} (operation ${String(index)})`);
    this.name = 'CaseBatchError';
    this.statusCode = statusCode;
    this.index = index;
  }
}

/** Splits one over-fetched row off a keyset page: fetch `limit + 1`, and the extra row proves there is more. */
export function pageOf<T, C>(rows: readonly T[], limit: number, cursorOf: (row: T) => C): Page<T, C> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, next: rows.length > limit && last !== undefined ? cursorOf(last) : null };
}

export const byRevision = (a: RunDoc, b: RunDoc): number => a.revision - b.revision;
export const byVersion = (a: ProposalDoc, b: ProposalDoc): number => a.version - b.version;

/** Checks shared by every implementation: size, and that each document belongs to the batch partition. */
export function assertBatch(tenantId: string, caseId: string, ops: readonly CaseOp[]): void {
  if (ops.length === 0 || ops.length > MAX_BATCH_OPERATIONS) {
    throw new RangeError(`a batch holds 1 to ${String(MAX_BATCH_OPERATIONS)} operations, got ${String(ops.length)}`);
  }
  for (const { doc } of ops) {
    if (doc.tenantId !== tenantId || doc.caseId !== caseId) {
      throw new RangeError(`document ${doc.id} does not belong to the batch partition`);
    }
  }
}

/** The only case fields a listing reads. The free-text `description` is never projected. */
export const CASE_LIST_FIELDS = [
  'caseId',
  'tenantId',
  'status',
  'category',
  'accountId',
  'createdAt',
  'updatedAt',
  'createdBy',
  'revision',
  'latestProposal',
  'sortKey',
] as const;

/** Derived-status predicate, as SQL over a case document. Timestamps are fixed-width UTC ISO strings. */
function statusPredicate(status: CaseStatus | null, nowIso: string): { sql: string; parameters: SqlParameter[] } {
  if (status === null) return { sql: '', parameters: [] };
  const now = { name: '@now', value: nowIso };
  if (status === 'awaiting_approval') {
    return { sql: "AND c.status = 'awaiting_approval' AND c.latestProposal.approvalExpiresAt > @now", parameters: [now] };
  }
  if (status === 'expired') {
    return {
      sql: "AND (c.status = 'expired' OR (c.status = 'awaiting_approval' AND c.latestProposal.approvalExpiresAt <= @now))",
      parameters: [now],
    };
  }
  return { sql: 'AND c.status = @status', parameters: [{ name: '@status', value: status }] };
}

/** The documents in one work state, as SQL. It must select what `workStateOf` selects. */
function workPredicate(state: WorkState, now: Date): { type: WorkType; sql: string; parameters: SqlParameter[] } {
  const nowIso = { name: '@now', value: now.toISOString() };
  switch (state) {
    case 'waiting':
      return { type: 'proposal', sql: "c.status = 'pending_approval' AND c.approvalExpiresAt > @now", parameters: [nowIso] };
    case 'failed':
      return { type: 'run', sql: "c.state IN ('failed', 'blocked')", parameters: [] };
    case 'budget_exhausted':
      return { type: 'run', sql: "c.state = 'budget_exhausted'", parameters: [] };
    case 'poison':
      return { type: 'outbox', sql: "c.state = 'poison'", parameters: [] };
    case 'completed':
      return { type: 'outbox', sql: "c.state = 'completed'", parameters: [] };
    case 'recoverable':
      return {
        type: 'outbox',
        sql: "((c.state = 'claimed' AND c.claimedUntil <= @now) OR (c.state = 'pending' AND c.notBefore < @overdue))",
        parameters: [nowIso, { name: '@overdue', value: new Date(now.getTime() - RECOVERABLE_GRACE_MS).toISOString() }],
      };
  }
}

const chargeOf = (headers: Record<string, string | number | boolean>): number | undefined => {
  const charge = Number(headers['x-ms-request-charge']);
  return Number.isFinite(charge) ? charge : undefined;
};

const toBody = (doc: StoredDoc): JSONObject => stripSystemFields(doc) as unknown as JSONObject;

const toOperation = (op: CaseOp): OperationInput =>
  op.op === 'create'
    ? { operationType: 'Create', resourceBody: toBody(op.doc) }
    : { operationType: 'Replace', id: op.doc.id, resourceBody: toBody(op.doc), ifMatch: op.etag };

function failureOf(code: number | undefined, results: readonly OperationResponse[]): Error {
  // Operations that were rolled back because another one failed report 424 (failed dependency).
  const index = results.findIndex((result) => result.statusCode >= 400 && result.statusCode !== 424);
  const status = results[index]?.statusCode ?? code ?? 0;
  if (status === 409) return new CaseWriteError('exists', index);
  if (status === 412) return new CaseWriteError('stale', index);
  if (status === 404) return new CaseWriteError('missing', index);
  return new CaseBatchError(status, index);
}

type WithEtag<T> = T & { _etag?: string };

function versioned<T extends object>(resource: WithEtag<T>): Versioned<T> {
  const etag = resource._etag;
  if (etag === undefined) throw new Error('Cosmos DB returned a document without an ETag');
  return { doc: stripSystemFields(resource), etag };
}

/**
 * `partitionKey` is the full `[tenantId, caseId]` key of one logical partition. `null` is a tenant listing: the
 * query itself must filter `c.tenantId = @tenantId`, which the service routes by the first key path. A partial
 * (prefix) key in the request options is rejected by the Azure service with HTTP 400 although the emulator accepts it.
 */
async function queryResources<T>(
  container: Container,
  partitionKey: string[] | null,
  query: string,
  parameters: SqlParameter[],
): Promise<T[]> {
  const response = await container.items.query<T>({ query, parameters }, partitionKey === null ? {} : { partitionKey }).fetchAll();
  recordCharge(response.requestCharge);
  return response.resources;
}

export function createCaseStore(container: Container): CaseStore {
  return {
    async get(kind, tenantId, caseId, id) {
      try {
        const response = await container.item(id, [tenantId, caseId]).read<WithEtag<DocKinds[typeof kind]>>();
        recordCharge(response.requestCharge);
        const resource = response.resource;
        // A different type means the id belongs to another kind of document.
        return resource !== undefined && resource.type === kind ? versioned(resource) : null;
      } catch (error) {
        if (isStatus(error, 404)) return null;
        throw error;
      }
    },

    async commit(tenantId, caseId, ops) {
      assertBatch(tenantId, caseId, ops);
      const response = await container.items.batch(ops.map(toOperation), [tenantId, caseId]);
      recordCharge(chargeOf(response.headers));
      const results = response.result ?? [];
      if (response.code !== 200 || results.length !== ops.length) throw failureOf(response.code, results);
      return results.map((result) => {
        if (result.eTag === undefined) throw new Error('Cosmos DB returned a batch result without an ETag');
        return result.eTag;
      });
    },

    async listRuns(tenantId, caseId) {
      const rows = await queryResources<WithEtag<RunDoc>>(
        container,
        [tenantId, caseId],
        "SELECT TOP @top * FROM c WHERE c.type = 'run'",
        [{ name: '@top', value: CASE_LIMITS.maxRuns }],
      );
      return rows.map((row) => stripSystemFields(row)).sort(byRevision);
    },

    async listProposals(tenantId, caseId) {
      const rows = await queryResources<WithEtag<ProposalDoc>>(
        container,
        [tenantId, caseId],
        "SELECT TOP @top * FROM c WHERE c.type = 'proposal'",
        [{ name: '@top', value: CASE_LIMITS.maxRuns }],
      );
      return rows.map((row) => stripSystemFields(row)).sort(byVersion);
    },

    async listTimeline(tenantId, caseId, afterSeq, limit) {
      const rows = await queryResources<WithEtag<TimelineDoc>>(
        container,
        [tenantId, caseId],
        "SELECT TOP @top * FROM c WHERE c.type = 'timeline' AND c.seq > @after ORDER BY c.seq ASC",
        [
          { name: '@top', value: limit + 1 },
          { name: '@after', value: afterSeq },
        ],
      );
      return pageOf(rows.map((row) => stripSystemFields(row)), limit, (row) => row.seq);
    },

    async listUsage(tenantId, caseId, runId, afterSeq, limit) {
      const rows = await queryResources<WithEtag<UsageEventDoc>>(
        container,
        [tenantId, caseId],
        "SELECT TOP @top * FROM c WHERE c.type = 'usage' AND c.runId = @runId AND c.seq > @after ORDER BY c.seq ASC",
        [
          { name: '@top', value: limit + 1 },
          { name: '@runId', value: runId },
          { name: '@after', value: afterSeq },
        ],
      );
      return pageOf(rows.map((row) => stripSystemFields(row)), limit, (row) => row.seq);
    },

    async listReservedUsage(tenantId, caseId, runId) {
      const rows = await queryResources<WithEtag<UsageEventDoc>>(
        container,
        [tenantId, caseId],
        "SELECT TOP @top * FROM c WHERE c.type = 'usage' AND c.runId = @runId AND c.outcome = 'reserved'",
        [
          { name: '@top', value: MAX_BATCH_OPERATIONS },
          { name: '@runId', value: runId },
        ],
      );
      return rows.map((row) => versioned(row));
    },

    async listCases(tenantId, status, limit, after, now) {
      const predicate = statusPredicate(status, now.toISOString());
      const rows = await queryResources<CaseListRow>(
        container,
        null,
        `SELECT TOP @top ${projection(CASE_LIST_FIELDS)} FROM c
         WHERE c.tenantId = @tenantId AND c.type = 'case' ${predicate.sql}
         ${after === null ? '' : 'AND c.sortKey < @after'}
         ORDER BY c.sortKey DESC`,
        [
          { name: '@top', value: limit + 1 },
          { name: '@tenantId', value: tenantId },
          ...predicate.parameters,
          ...(after === null ? [] : [{ name: '@after', value: after }]),
        ],
      );
      return pageOf(rows, limit, (row) => row.sortKey);
    },

    async listWork(tenantId, state, limit, after, now) {
      const predicate = workPredicate(state, now);
      const rows = await queryResources<WorkRow>(
        container,
        null,
        `SELECT TOP @top ${projection(WORK_FIELDS[predicate.type])} FROM c
         WHERE c.tenantId = @tenantId AND c.type = @type AND ${predicate.sql}
         ${after === null ? '' : 'AND c.workKey < @after'}
         ORDER BY c.workKey DESC`,
        [
          { name: '@top', value: limit + 1 },
          { name: '@tenantId', value: tenantId },
          { name: '@type', value: predicate.type },
          ...predicate.parameters,
          ...(after === null ? [] : [{ name: '@after', value: after }]),
        ],
      );
      return pageOf(rows, limit, (row) => row.workKey);
    },
  };
}
