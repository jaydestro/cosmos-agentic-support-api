import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { createDemoInvestigator } from './agent/demo.ts';
import type { Investigators } from './agent/investigator.ts';
import { createLiveInvestigator } from './agent/live.ts';
import { createModelClient, type ModelClient, type ModelCredential } from './agent/model.ts';
import { createAdmissionControl, type AdmissionControl } from './cases/admission.ts';
import { createCaseStore, type CaseStore } from './cases/store.ts';
import { createAuthenticator, type Authenticator } from './auth/verify.ts';
import type { Config } from './config/env.ts';
import { loadContract, type Contract } from './contract/load.ts';
import { createCreditProvider, type CreditProvider } from './credits/provider.ts';
import { createCosmosHandles, type CosmosHandles } from './data/cosmos.ts';
import { createReferenceStore, type ReferenceStore } from './data/reference.ts';
import { systemClock, type Clock } from './domain/time.ts';
import type { PipelineServices } from './http/pipeline.ts';
import { createReadiness, type Readiness } from './http/readiness.ts';
import { createOutboxStore, type OutboxStore } from './outbox/store.ts';
import type { Logger } from './telemetry/log.ts';

export interface Services extends PipelineServices {
  readonly cosmos: CosmosHandles;
  readonly reference: ReferenceStore;
  readonly cases: CaseStore;
  readonly admission: AdmissionControl;
  /** The live-model client, or `null` when no deployment is configured. */
  readonly model: ModelClient | null;
  readonly investigators: Investigators;
  readonly provider: CreditProvider;
  readonly outbox: OutboxStore;
  readonly readiness: Readiness;
}

export interface ServiceOverrides {
  contract?: Contract;
  clock?: Clock;
  authenticator?: Authenticator;
  cosmos?: CosmosHandles;
  reference?: ReferenceStore;
  cases?: CaseStore;
  admission?: AdmissionControl;
  model?: ModelClient | null;
  investigators?: Investigators;
  provider?: CreditProvider;
  outbox?: OutboxStore;
  readiness?: Readiness;
}

/**
 * In Azure the application's own managed identity calls the model, the one that reaches Cosmos DB (the
 * user-assigned identity is selected by `AZURE_CLIENT_ID`). Elsewhere the developer's own sign-in is used,
 * and a loopback test endpoint needs none.
 */
function modelCredentialFor(config: Config): ModelCredential | undefined {
  if (config.liveModel === null || config.liveModel.auth === 'none') return undefined;
  if (config.env !== 'azure') return new DefaultAzureCredential();
  const clientId = config.cosmos.auth === 'managed-identity' ? config.cosmos.clientId : undefined;
  return new ManagedIdentityCredential(clientId === undefined ? undefined : { clientId });
}

/** The live-model client the configuration describes, or `null` when it describes none. */
export function createConfiguredModel(config: Config): ModelClient | null {
  if (config.liveModel === null) return null;
  return createModelClient({ config: config.liveModel, credential: modelCredentialFor(config) });
}

/**
 * Builds the process-wide service graph. Everything expensive (contract compilation, the
 * Cosmos DB client, the key-set cache) is created here once; handlers only receive references.
 */
export function createServices(config: Config, logger: Logger, overrides: ServiceOverrides = {}): Services {
  const clock = overrides.clock ?? systemClock;
  const contract = overrides.contract ?? loadContract();
  const authenticator = overrides.authenticator ?? createAuthenticator(config.auth, config.tenants, { logger });
  const cosmos = overrides.cosmos ?? createCosmosHandles(config.cosmos);
  const reference = overrides.reference ?? createReferenceStore(cosmos.reference);
  const cases = overrides.cases ?? createCaseStore(cosmos.cases);
  const admission =
    overrides.admission ??
    createAdmissionControl({
      store: cases,
      limits: {
        concurrentRuns: config.tenantLimits.concurrentRuns,
        casesPerUtcDay: config.tenantLimits.casesPerUtcDay,
        liveCostMicroUsdPerUtcDay: config.tenantLimits.liveCostMicroUsdPerUtcDay,
      },
      clock,
    });
  // A run that asks for live mode is blocked, never answered by the demo plan, until a model is configured and approved.
  const model = overrides.model === undefined ? createConfiguredModel(config) : overrides.model;
  const investigators = overrides.investigators ?? { demo: createDemoInvestigator(), live: model === null ? null : createLiveInvestigator() };
  // The simulated provider keeps its own ledger; only local and CI configurations may arm its fault plan.
  const provider = overrides.provider ?? createCreditProvider(cosmos.provider, { faultsEnabled: config.providerFaultsEnabled });
  const outbox = overrides.outbox ?? createOutboxStore(cosmos.cases);
  const readiness = overrides.readiness ?? createReadiness({ ping: () => reference.ping(), clock, logger });
  return { config, contract, logger, clock, authenticator, cosmos, reference, cases, admission, model, investigators, provider, outbox, readiness };
}
