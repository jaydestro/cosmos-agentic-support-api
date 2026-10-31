import { OUTBOX_LIMITS } from '../config/limits.ts';
import { workKeyOf } from '../domain/ids.ts';

export const OUTBOX_KINDS = ['investigation.start', 'credit.execute', 'diagnostic.echo'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export const OUTBOX_STATES = ['pending', 'claimed', 'completed', 'poison'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export type OutboxPayload = Readonly<Record<string, string | number | boolean | null>>;

/** Case partition value used by diagnostic items, which belong to no case. */
export const DIAGNOSTICS_PARTITION = '_diagnostics';

export interface OutboxDoc {
  /** Deterministic, so a retried enqueue is a create-only conflict instead of a duplicate. */
  id: string;
  tenantId: string;
  caseId: string;
  type: 'outbox';
  schemaVersion: 1;
  /** Immutable sort key of the operator work listing; see `workKeyOf`. */
  workKey: string;
  kind: OutboxKind;
  state: OutboxState;
  attempts: number;
  maxAttempts: number;
  /** ISO time before which the item must not be claimed (retry backoff). */
  notBefore: string;
  claimedUntil: string | null;
  claimedBy: string | null;
  payload: OutboxPayload;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: { code: string; at: string } | null;
  _etag?: string;
}

const OUTBOX_ID = /^out-[a-z0-9_-]{1,70}$/;
const TENANT_ID = /^[a-z][a-z0-9_-]{2,63}$/;
const CASE_PARTITION = /^(case_[0-9a-f]{32}|_diagnostics)$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{2,60}$/;

export function outboxId(kind: OutboxKind, key: string): string {
  return `out-${kind.replace('.', '-')}-${key}`;
}

export interface NewOutbox {
  tenantId: string;
  caseId: string;
  kind: OutboxKind;
  key: string;
  payload: OutboxPayload;
  now: Date;
}

export function newOutboxDoc(input: NewOutbox): OutboxDoc {
  const at = input.now.toISOString();
  const id = outboxId(input.kind, input.key);
  return {
    id,
    tenantId: input.tenantId,
    caseId: input.caseId,
    type: 'outbox',
    schemaVersion: 1,
    workKey: workKeyOf(at, input.caseId, id),
    kind: input.kind,
    state: 'pending',
    attempts: 0,
    maxAttempts: OUTBOX_LIMITS.maxAttempts,
    notBefore: at,
    claimedUntil: null,
    claimedBy: null,
    payload: input.payload,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    lastError: null,
  };
}

const isIso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The change feed carries every document type of the container. Only a document that is
 * unmistakably an outbox item with sane fields is accepted; anything else returns `null`.
 */
export function parseOutboxDoc(value: unknown): OutboxDoc | null {
  if (!isRecord(value) || value['type'] !== 'outbox' || value['schemaVersion'] !== 1) return null;
  const { id, tenantId, caseId, kind, state, attempts, maxAttempts, notBefore, claimedUntil, claimedBy, payload } = value;
  if (typeof id !== 'string' || !OUTBOX_ID.test(id)) return null;
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) return null;
  if (typeof caseId !== 'string' || !CASE_PARTITION.test(caseId)) return null;
  if (typeof value['workKey'] !== 'string') return null;
  if (!OUTBOX_KINDS.includes(kind as OutboxKind) || !OUTBOX_STATES.includes(state as OutboxState)) return null;
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) return null;
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts)) return null;
  if (maxAttempts < 1 || maxAttempts > OUTBOX_LIMITS.maxAttempts) return null;
  if (!isIso(notBefore) || !isIso(value['createdAt']) || !isIso(value['updatedAt'])) return null;
  if (claimedUntil !== null && !isIso(claimedUntil)) return null;
  if (claimedBy !== null && typeof claimedBy !== 'string') return null;
  if (!isRecord(payload) || Object.keys(payload).length > 10) return null;
  for (const entry of Object.values(payload)) {
    if (entry !== null && !['string', 'number', 'boolean'].includes(typeof entry)) return null;
    if (typeof entry === 'string' && entry.length > 200) return null;
  }
  const completedAt = value['completedAt'];
  if (completedAt !== null && !isIso(completedAt)) return null;
  const lastError = value['lastError'];
  if (lastError !== null) {
    if (!isRecord(lastError) || typeof lastError['code'] !== 'string' || !ERROR_CODE.test(lastError['code'])) return null;
    if (!isIso(lastError['at'])) return null;
  }
  return value as unknown as OutboxDoc;
}

/** Marks an outbox failure that retrying cannot fix; the item becomes poison immediately. */
export class PermanentOutboxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PermanentOutboxError';
    this.code = code;
  }
}

/** Marks a failure that is expected to pass on a later attempt; `code` is what the item records as its last error. */
export class RetryableOutboxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RetryableOutboxError';
    this.code = code;
  }
}
