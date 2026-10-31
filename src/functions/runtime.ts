import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createPoisonNotifier } from '../cases/poison.ts';
import { ConfigError, loadConfig } from '../config/env.ts';
import { findAppRoot, loadContract, type Contract } from '../contract/load.ts';
import { consoleConnectSources } from '../http/console-config.ts';
import { createPipeline } from '../http/pipeline.ts';
import { createStaticServer, type StaticServer } from '../http/static.ts';
import { createOutboxHandlers } from '../outbox/handlers.ts';
import { createOutboxProcessor, type OutboxProcessor } from '../outbox/processor.ts';
import { createServices, type Services } from '../services.ts';
import { createLogger, stdoutSink } from '../telemetry/log.ts';

export interface Runtime {
  readonly services: Services;
  readonly pipeline: ReturnType<typeof createPipeline<Services>>;
  readonly outbox: OutboxProcessor;
  readonly statics: StaticServer;
}

let contract: Contract | undefined;

/** Compiled once per process; function registration needs it before any configuration is read. */
export function getContract(): Contract {
  contract ??= loadContract(findAppRoot());
  return contract;
}

function createRuntime(): Runtime {
  const logger = createLogger(stdoutSink, { component: 'resolve-api' });
  try {
    const config = loadConfig();
    const services = createServices(config, logger, { contract: getContract() });
    const outbox = createOutboxProcessor({
      store: services.outbox,
      handlers: createOutboxHandlers(services),
      clock: services.clock,
      logger,
      workerId: `w-${String(process.pid)}-${randomBytes(4).toString('hex')}`,
      allowDiagnostics: config.env !== 'azure',
      onPoisoned: createPoisonNotifier({ cases: services.cases, clock: services.clock }),
    });
    return {
      services,
      pipeline: createPipeline(services),
      outbox,
      statics: createStaticServer(join(findAppRoot(), 'dist', 'web'), { connectSources: consoleConnectSources(config) }),
    };
  } catch (error) {
    // Names of invalid settings are safe to log; values and stack traces are not.
    if (error instanceof ConfigError) logger.error('configuration is invalid', { issues: error.issues });
    else logger.error('runtime failed to start', { errorName: error instanceof Error ? error.name : 'unknown' });
    throw error;
  }
}

let runtime: Runtime | undefined;
let failed = false;

/**
 * Lazily builds the process-wide runtime. A failure is remembered: configuration cannot change
 * without a restart, so every later call fails fast instead of rebuilding and re-logging.
 */
export function getRuntime(): Runtime {
  if (failed) throw new Error('runtime unavailable');
  try {
    runtime ??= createRuntime();
    return runtime;
  } catch (error) {
    failed = true;
    throw error;
  }
}
