import { app, type InvocationContext } from '@azure/functions';
import { readTriggerTuning } from '../config/trigger.ts';
import { invocationLogger } from './adapter.ts';
import { getRuntime } from './runtime.ts';

// Invalid timer overrides fail registration instead of silently reverting to defaults.
const tuning = readTriggerTuning(process.env);

/**
 * Delivers every change of the `cases` container. Only outbox items are acted on, and they are
 * processed idempotently from the stored state because a failed invocation is not redelivered.
 */
app.cosmosDB('processOutbox', {
  connection: 'COSMOS_CONNECTION',
  databaseName: '%COSMOS_DATABASE%',
  containerName: 'cases',
  leaseContainerName: 'leases',
  // The leases container is provisioned with the database; it is never created at runtime.
  createLeaseContainerIfNotExists: false,
  // Items enqueued before the first lease exists must still be seen.
  startFromBeginning: true,
  maxItemsPerInvocation: 10,
  ...tuning,
  handler: async (documents: unknown[], context: InvocationContext): Promise<void> => {
    const log = invocationLogger(context);
    let runtime;
    try {
      runtime = getRuntime();
    } catch {
      log.error('outbox batch was not processed because the runtime is unavailable', { documents: documents.length });
      return;
    }
    await runtime.outbox.processBatch(documents, log);
  },
});
