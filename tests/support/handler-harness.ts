import assert from 'node:assert/strict';
import { createDemoInvestigator } from '../../src/agent/demo.ts';
import type { Investigators } from '../../src/agent/investigator.ts';
import type { ModelClient } from '../../src/agent/model.ts';
import type { Principal, RoleName } from '../../src/auth/principal.ts';
import type { Authenticator } from '../../src/auth/verify.ts';
import { createAdmissionControl } from '../../src/cases/admission.ts';
import { createPoisonNotifier } from '../../src/cases/poison.ts';
import { loadConfig, type Config } from '../../src/config/env.ts';
import { loadContract } from '../../src/contract/load.ts';
import type { CosmosHandles } from '../../src/data/cosmos.ts';
import { handlers } from '../../src/handlers/index.ts';
import { createPipeline } from '../../src/http/pipeline.ts';
import { createReadiness } from '../../src/http/readiness.ts';
import { createOutboxHandlers } from '../../src/outbox/handlers.ts';
import { createOutboxProcessor, type ProcessOutcome } from '../../src/outbox/processor.ts';
import type { Services } from '../../src/services.ts';
import { createMemoryLogger } from '../../src/telemetry/log.ts';
import { SEED_TENANTS } from '../../tools/seed/data/index.ts';
import { createTestClock, type TestClock } from './clock.ts';
import { createMemoryCases, type MemoryCases } from './memory-case-store.ts';
import { createMemoryProvider, type MemoryProvider } from './memory-provider.ts';
import { createMemoryReference, type MemoryReference } from './memory-reference.ts';

export const contract = loadContract();

export const BASE_CONFIG = loadConfig({
  RESOLVE_ENV: 'local',
  COSMOS_ENDPOINT: 'http://127.0.0.1:8081',
  COSMOS_AUTH: 'emulator-key',
  COSMOS_KEY: 'unit-test-key',
  AUTH_MODE: 'test-idp',
  TEST_IDP_JWKS_URL: 'http://127.0.0.1:9/jwks',
  TEST_IDP_ISSUER: 'http://127.0.0.1:9',
  TEST_IDP_AUDIENCE: 'api://resolve-unit-test',
});

export const NOW = new Date('2026-10-29T12:00:00.000Z');
export const PRINCIPAL_ID = '00000000-0000-4000-8000-0000000000a1';

export interface Reply {
  status: number;
  headers: Record<string, string>;
  json: unknown;
}

export interface CallOptions {
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Sent as JSON together with the content headers a real client adds. */
  body?: unknown;
  /** Sent exactly as given, for malformed or oversized bodies. It wins over `body`. */
  rawBody?: string;
}

/** The databases and clock behind one or more callers, so several harnesses can act on one dataset. */
export interface World {
  memory: MemoryCases;
  reference: MemoryReference;
  provider: MemoryProvider;
  clock: TestClock;
}

export function newWorld(now: Date = NOW): World {
  return {
    memory: createMemoryCases(),
    reference: createMemoryReference(SEED_TENANTS),
    provider: createMemoryProvider(),
    clock: createTestClock(now),
  };
}

export interface HarnessOptions {
  tenant?: string;
  principalId?: string;
  roles?: RoleName[];
  /** Starts the clock of a new world; ignored when `world` is given. */
  now?: Date;
  config?: Partial<Config>;
  world?: World;
  investigators?: Investigators;
  model?: ModelClient | null;
}

export function harness(options: HarnessOptions = {}) {
  const { logger, lines } = createMemoryLogger();
  const world = options.world ?? newWorld(options.now);
  const { memory, reference, provider, clock } = world;
  const config: Config = { ...BASE_CONFIG, ...options.config };
  const principal: Principal = {
    principalId: options.principalId ?? PRINCIPAL_ID,
    tenantId: options.tenant ?? 'aurora',
    roles: options.roles ?? ['Representative'],
  };
  const authentications: (string | null)[] = [];
  const authenticator: Authenticator = {
    authenticate(authorization) {
      authentications.push(authorization);
      return Promise.resolve(principal);
    },
  };
  const admission = createAdmissionControl({
    store: memory.store,
    limits: {
      concurrentRuns: config.tenantLimits.concurrentRuns,
      casesPerUtcDay: config.tenantLimits.casesPerUtcDay,
      liveCostMicroUsdPerUtcDay: config.tenantLimits.liveCostMicroUsdPerUtcDay,
    },
    clock,
    sleep: () => Promise.resolve(),
  });
  const services: Services = {
    config,
    contract,
    logger,
    clock,
    authenticator,
    cosmos: {} as unknown as CosmosHandles,
    reference: reference.store,
    cases: memory.store,
    admission,
    investigators: options.investigators ?? { demo: createDemoInvestigator(), live: null },
    model: options.model ?? null,
    provider,
    outbox: memory.outbox,
    readiness: createReadiness({ ping: () => reference.store.ping(), clock, logger }),
  };
  const execute = createPipeline(services);

  async function call(operationId: string, request: CallOptions = {}): Promise<Reply> {
    const op = contract.byId.get(operationId);
    assert.ok(op, `unknown operation ${operationId}`);
    const handler = handlers[operationId];
    assert.ok(handler, `no handler for ${operationId}`);
    const params = request.params ?? {};
    const path = op.path.replace(/\{(\w+)\}/g, (_match, name: string) => encodeURIComponent(params[name] ?? ''));
    const url = new URL(`http://localhost:7071/api${path}`);
    for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value);

    const headers = new Headers(request.headers);
    const text = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
    let body: ReadableStream<Uint8Array> | null = null;
    if (text !== undefined) {
      const bytes = new TextEncoder().encode(text);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      if (!headers.has('content-length')) headers.set('content-length', String(bytes.byteLength));
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }

    const response = await execute(op, handler, { method: op.method, url: url.toString(), headers, params, body });
    return {
      status: response.status,
      headers: response.headers,
      json: response.body === undefined ? undefined : (JSON.parse(response.body) as unknown),
    };
  }

  /** A processor for one worker identity; its sleeps advance the test clock instead of waiting. */
  const processorFor = (workerId: string) =>
    createOutboxProcessor({
      store: memory.outbox,
      handlers: createOutboxHandlers(services),
      clock,
      logger,
      workerId,
      allowDiagnostics: false,
      onPoisoned: createPoisonNotifier({ cases: memory.store, clock }),
      sleep: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
    });
  const processor = processorFor('unit-worker');

  /** Delivers every pending outbox item the way the change-feed trigger would, through the real processor. */
  const drain = (): Promise<ProcessOutcome[]> => processor.processBatch(memory.outboxDocs().filter((doc) => doc.state === 'pending'));

  return { call, drain, processor, processorFor, world, memory, reference, clock, logger, lines, authentications, services };
}

export const as = <T>(value: unknown): T => value as T;
