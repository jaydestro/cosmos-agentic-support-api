import { parseOutboxDoc, type OutboxDoc } from '../outbox/types.ts';
import type { ProposalDoc, RunDoc, WorkItem } from './documents.ts';
import type { CaseStore, Versioned } from './store.ts';
import { toWorkItem, workStateOf, type WorkTarget } from './work.ts';

/** The stored document a work id names, read with its ETag. */
export type WorkTargetRow =
  | { type: 'outbox'; row: Versioned<OutboxDoc> }
  | { type: 'run'; row: Versioned<RunDoc> }
  | { type: 'proposal'; row: Versioned<ProposalDoc> };

/**
 * Point-reads the document of `tenantId` that `target` names. A document of another tenant is
 * unreachable (the tenant is part of the partition key), and a stored outbox document that does not
 * parse is not work an operator can act on, so both read as absent.
 */
export async function readWorkTarget(cases: CaseStore, tenantId: string, target: WorkTarget): Promise<WorkTargetRow | null> {
  switch (target.type) {
    case 'outbox': {
      const row = await cases.get('outbox', tenantId, target.caseId, target.docId);
      const doc = row === null ? null : parseOutboxDoc(row.doc);
      return row === null || doc === null ? null : { type: 'outbox', row: { doc, etag: row.etag } };
    }
    case 'run': {
      const row = await cases.get('run', tenantId, target.caseId, target.docId);
      return row === null ? null : { type: 'run', row };
    }
    case 'proposal': {
      const row = await cases.get('proposal', tenantId, target.caseId, target.docId);
      return row === null ? null : { type: 'proposal', row };
    }
  }
}

/** One work item as an operator sees it, or `null` when the document does not exist or is not operator work. */
export async function inspectWork(cases: CaseStore, tenantId: string, target: WorkTarget, now: Date): Promise<WorkItem | null> {
  const found = await readWorkTarget(cases, tenantId, target);
  if (found === null) return null;
  const state = workStateOf(found.row.doc, now);
  return state === null ? null : toWorkItem(found.row.doc, state);
}
