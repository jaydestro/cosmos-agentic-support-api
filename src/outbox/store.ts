import type { Container } from '@azure/cosmos';
import { isStatus } from '../data/errors.ts';
import { stripSystemFields } from '../data/system.ts';
import { recordCharge } from '../telemetry/ru.ts';
import { parseOutboxDoc, type OutboxDoc } from './types.ts';

export interface OutboxStore {
  read(tenantId: string, caseId: string, id: string): Promise<OutboxDoc | null>;
  /** Create-only. Returns `false` when the deterministic id already exists. */
  create(doc: OutboxDoc): Promise<boolean>;
  /** Conditional on the ETag. Returns `null` when the precondition fails or the item is gone. */
  replace(doc: OutboxDoc, etag: string): Promise<OutboxDoc | null>;
}

/** Outbox items live in the `cases` container, in the logical partition of their case. */
export function createOutboxStore(cases: Container): OutboxStore {
  return {
    async read(tenantId, caseId, id) {
      try {
        const response = await cases.item(id, [tenantId, caseId]).read<OutboxDoc>();
        recordCharge(response.requestCharge);
        return response.resource === undefined ? null : parseOutboxDoc(response.resource);
      } catch (error) {
        if (isStatus(error, 404)) return null;
        throw error;
      }
    },

    async create(doc) {
      try {
        const response = await cases.items.create(stripSystemFields(doc));
        recordCharge(response.requestCharge);
        return true;
      } catch (error) {
        if (isStatus(error, 409)) return false;
        throw error;
      }
    },

    async replace(doc, etag) {
      try {
        const response = await cases
          .item(doc.id, [doc.tenantId, doc.caseId])
          .replace<OutboxDoc>(stripSystemFields(doc), { accessCondition: { type: 'IfMatch', condition: etag } });
        recordCharge(response.requestCharge);
        return response.resource === undefined ? null : parseOutboxDoc(response.resource);
      } catch (error) {
        if (isStatus(error, 412) || isStatus(error, 404)) return null;
        throw error;
      }
    },
  };
}
