import { createRunner } from '../agent/runner.ts';
import type { Config } from '../config/env.ts';
import { createCreditExecutor } from '../credits/execute.ts';
import type { Services } from '../services.ts';
import type { OutboxHandlers } from './processor.ts';

/** The part of the service graph the handlers use, so a test can supply just that. */
export type OutboxHandlerServices = Pick<Services, 'cases' | 'admission' | 'reference' | 'clock' | 'model' | 'investigators' | 'provider'> & {
  readonly config: Pick<Config, 'agent' | 'approvalTtlMs'>;
};

/** Handlers per outbox kind. A kind without a handler is left untouched and reported as `unhandled_kind`. */
export function createOutboxHandlers(services: OutboxHandlerServices): OutboxHandlers {
  const runner = createRunner({
    cases: services.cases,
    admission: services.admission,
    reference: services.reference,
    clock: services.clock,
    config: { liveApproved: services.config.agent.liveApproved, approvalTtlMs: services.config.approvalTtlMs },
    investigators: services.investigators,
    model: services.model,
  });
  return {
    // Records its own completion in the transaction that records the credit.
    'credit.execute': createCreditExecutor({
      cases: services.cases,
      reference: services.reference,
      provider: services.provider,
      clock: services.clock,
    }),
    // Proves trigger delivery and leases locally. The processor records the completion.
    'diagnostic.echo': ({ logger }) => {
      logger.info('diagnostic echo handled');
      return Promise.resolve();
    },
    'investigation.start': ({ item, logger }) => runner.run(item, logger),
  };
}
