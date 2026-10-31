import type { Container } from '@azure/cosmos';
import type { Money } from '../cases/documents.ts';
import { SCHEMA_VERSION } from '../data/documents.ts';
import { isStatus } from '../data/errors.ts';
import { stripSystemFields } from '../data/system.ts';
import { sha256Hex } from '../domain/canonical.ts';
import { CASE_ID_PATTERN } from '../domain/ids.ts';
import { recordCharge } from '../telemetry/ru.ts';

/**
 * The simulated credit provider. It stands in for an external ledger: it keeps its own records in the
 * `provider` container, supports a stable idempotency key and result lookup, and takes part in no
 * transaction of the case aggregate. No real payment system is involved anywhere.
 */

/** The name the provider reports on every credit it records. */
export const PROVIDER_NAME = 'simulated-ledger';

/** Names the one credit an approved proposal may produce; it is also the id of the provider's record. */
export const creditKeyFor = (caseId: string, version: number): string => `credit-${caseId}-v${String(version)}`;

/** What the provider holds for one idempotency key. */
export interface ProviderCredit {
  readonly key: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly amount: Money;
  readonly reference: string;
  readonly createdAt: string;
}

export interface IssueRequest {
  readonly tenantId: string;
  readonly caseId: string;
  readonly key: string;
  readonly amount: Money;
  readonly now: Date;
}

export interface IssueOutcome {
  readonly credit: ProviderCredit;
  /** `false` when the key already held this credit, which means an earlier call took effect. */
  readonly created: boolean;
}

export interface CreditProvider {
  /** The credit recorded under `key`, or `null`. Never changes anything. */
  lookup(tenantId: string, key: string): Promise<ProviderCredit | null>;
  /** Records the credit unless the key already holds it. The same key never yields a second credit. */
  issue(request: IssueRequest): Promise<IssueOutcome>;
}

/** The key holds a different credit, or something that is not a credit. Retrying cannot fix this. */
export class ProviderKeyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderKeyConflictError';
  }
}

/** The provider did not answer. The credit may or may not have been recorded, so the caller must look it up. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

const CREDIT_TYPE = 'provider_credit';
const FAULT_PLAN_TYPE = 'fault_plan';

type ProviderRecord = { id: string; type: string } & Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const referenceFor = (key: string): string => `sim-${sha256Hex(key).slice(0, 16)}`;

function toCredit(value: unknown): ProviderCredit | null {
  if (!isRecord(value) || value['type'] !== CREDIT_TYPE) return null;
  const { id, tenantId, caseId, amount, reference, createdAt } = value;
  if (typeof id !== 'string' || typeof tenantId !== 'string' || typeof reference !== 'string') return null;
  if (typeof caseId !== 'string' || !CASE_ID_PATTERN.test(caseId)) return null;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null;
  if (!isRecord(amount)) return null;
  const amountMinor = amount['amountMinor'];
  const currency = amount['currency'];
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 1) return null;
  if (currency !== 'USD' && currency !== 'EUR') return null;
  return { key: id, tenantId, caseId, amount: { amountMinor, currency }, reference, createdAt };
}

const sameCredit = (credit: ProviderCredit, request: IssueRequest): boolean =>
  credit.caseId === request.caseId &&
  credit.amount.amountMinor === request.amount.amountMinor &&
  credit.amount.currency === request.amount.currency;

async function readRecord(
  container: Container,
  tenantId: string,
  id: string,
): Promise<{ record: ProviderRecord; etag: string | undefined } | null> {
  try {
    const response = await container.item(id, tenantId).read<ProviderRecord>();
    recordCharge(response.requestCharge);
    if (response.resource === undefined) return null;
    const etag = response.resource['_etag'];
    return { record: response.resource, etag: typeof etag === 'string' ? etag : undefined };
  } catch (error) {
    if (isStatus(error, 404)) return null;
    throw error;
  }
}

function cosmosProvider(container: Container): CreditProvider {
  async function lookup(tenantId: string, key: string): Promise<ProviderCredit | null> {
    const read = await readRecord(container, tenantId, key);
    if (read === null) return null;
    const credit = toCredit(read.record);
    if (credit === null) throw new ProviderKeyConflictError(`The provider holds something other than a credit under key ${key}.`);
    return credit;
  }

  return {
    lookup,

    async issue(request) {
      const record: ProviderRecord = {
        id: request.key,
        tenantId: request.tenantId,
        type: CREDIT_TYPE,
        schemaVersion: SCHEMA_VERSION,
        caseId: request.caseId,
        amount: { amountMinor: request.amount.amountMinor, currency: request.amount.currency },
        reference: referenceFor(request.key),
        createdAt: request.now.toISOString(),
      };
      try {
        const response = await container.items.create(record);
        recordCharge(response.requestCharge);
        const credit = toCredit(record);
        if (credit === null) throw new ProviderKeyConflictError('The provider could not record the credit.');
        return { credit, created: true };
      } catch (error) {
        if (!isStatus(error, 409)) throw error;
      }
      // Create-only conflict: the key already exists, so an earlier call took effect. It must be the same credit.
      const existing = await lookup(request.tenantId, request.key);
      if (existing === null) throw new ProviderUnavailableError('The provider reported a conflict for a key it could not read back.');
      if (!sameCredit(existing, request)) {
        throw new ProviderKeyConflictError(`The provider already holds key ${request.key} for a different credit.`);
      }
      return { credit: existing, created: false };
    },
  };
}

export const FAULT_MODES = ['unavailable', 'lose_response'] as const;
/**
 * `unavailable` fails before anything is recorded. `lose_response` records the credit and then fails, which is
 * how a provider that took effect looks to a caller that never saw the answer.
 */
export type FaultMode = (typeof FAULT_MODES)[number];

/** Names the plan that applies to one case. Only a tenant partition and this id are needed to arm it. */
export const faultPlanId = (caseId: string): string => `fault-${caseId}`;

interface FaultPlan {
  mode: FaultMode;
  remaining: number;
  fired: number;
}

function toFaultPlan(value: unknown): FaultPlan | null {
  if (!isRecord(value) || value['type'] !== FAULT_PLAN_TYPE) return null;
  const { mode, remaining, fired } = value;
  if (!FAULT_MODES.includes(mode as FaultMode)) return null;
  if (typeof remaining !== 'number' || !Number.isInteger(remaining) || remaining < 0) return null;
  if (typeof fired !== 'number' || !Number.isInteger(fired) || fired < 0) return null;
  return { mode: mode as FaultMode, remaining, fired };
}

const MAX_PLAN_CLAIM_TRIES = 3;

/** Uses one remaining fault of the plan armed for the case, if any. A lost race re-reads the plan. */
async function takeFault(container: Container, tenantId: string, caseId: string): Promise<FaultMode | null> {
  const id = faultPlanId(caseId);
  for (let tries = 0; tries < MAX_PLAN_CLAIM_TRIES; tries += 1) {
    const read = await readRecord(container, tenantId, id);
    const plan = read === null ? null : toFaultPlan(read.record);
    if (read === null || plan === null || read.etag === undefined || plan.remaining < 1) return null;
    const next = { ...stripSystemFields(read.record), remaining: plan.remaining - 1, fired: plan.fired + 1 };
    try {
      const response = await container
        .item(id, tenantId)
        .replace(next, { accessCondition: { type: 'IfMatch', condition: read.etag } });
      recordCharge(response.requestCharge);
      return plan.mode;
    } catch (error) {
      if (!isStatus(error, 412)) throw error;
    }
  }
  return null;
}

/**
 * Local and CI only. Reads the fault plan armed for a case (a document a test writes) before each issue.
 * Configuration refuses `PROVIDER_FAULTS_ENABLED` when running in Azure, so a deployment never builds this.
 */
function withFaultPlan(provider: CreditProvider, container: Container): CreditProvider {
  return {
    lookup: (tenantId, key) => provider.lookup(tenantId, key),

    async issue(request) {
      const fault = await takeFault(container, request.tenantId, request.caseId);
      if (fault === 'unavailable') throw new ProviderUnavailableError('The provider is unavailable (injected fault).');
      const outcome = await provider.issue(request);
      if (fault === 'lose_response') throw new ProviderUnavailableError('The provider answer was lost (injected fault).');
      return outcome;
    },
  };
}

export interface ProviderOptions {
  readonly faultsEnabled: boolean;
}

export function createCreditProvider(container: Container, options: ProviderOptions): CreditProvider {
  const provider = cosmosProvider(container);
  return options.faultsEnabled ? withFaultPlan(provider, container) : provider;
}
