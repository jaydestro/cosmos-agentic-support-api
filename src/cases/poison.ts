import type { OutboxProcessorDeps } from '../outbox/processor.ts';
import type { OutboxKind } from '../outbox/types.ts';
import type { Clock } from '../domain/time.ts';
import { appendTimeline, CASE_DOC_ID, SYSTEM_ACTOR, type CaseStatus } from './documents.ts';
import { withRetries } from './retry.ts';
import type { CaseOp, CaseStore } from './store.ts';
import { workIdOf } from './work.ts';

/** Work whose failure stalls a case; a diagnostic item belongs to no case. */
const CASE_WORK: ReadonlySet<OutboxKind> = new Set<OutboxKind>(['credit.execute', 'investigation.start']);

/** Statuses that are still waiting for this work to finish. Anything else already says what happened. */
const WAITING_FOR_WORK: ReadonlySet<CaseStatus> = new Set<CaseStatus>(['approved', 'queued', 'investigating']);

/**
 * The processor's poison hook. Work that moved to poison stops on its own, but the case it belongs to would
 * still read as moving, so this parks the case as `needs_attention` and puts the fact on its timeline. An
 * operator's requeue restores the status. Nothing here retries or resolves the work.
 */
export function createPoisonNotifier(deps: { readonly cases: CaseStore; readonly clock: Clock }): NonNullable<OutboxProcessorDeps['onPoisoned']> {
  const { cases, clock } = deps;

  return async (item, code) => {
    if (!CASE_WORK.has(item.kind)) return;
    await withRetries(
      async () => {
        const caseRow = await cases.get('case', item.tenantId, item.caseId, CASE_DOC_ID);
        if (caseRow === null) return;
        const parked = WAITING_FOR_WORK.has(caseRow.doc.status);
        const { caseDoc, docs } = appendTimeline(
          parked ? { ...caseRow.doc, status: 'needs_attention' } : caseRow.doc,
          [
            {
              kind: 'work_poisoned',
              actor: SYSTEM_ACTOR,
              summary: `${item.kind} work moved to poison after ${String(item.attempts)} attempt(s).`,
              data: { workId: workIdOf(item.caseId, item.id), workKind: item.kind, errorCode: code, attempts: item.attempts },
            },
          ],
          clock.now(),
        );
        const ops: CaseOp[] = [{ op: 'replace', doc: caseDoc, etag: caseRow.etag }, ...docs.map((doc): CaseOp => ({ op: 'create', doc }))];
        await cases.commit(item.tenantId, item.caseId, ops);
      },
      () => undefined,
    );
  };
}
