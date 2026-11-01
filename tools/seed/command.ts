import { CosmosClient, type Container } from '@azure/cosmos';
import { ManagedIdentityCredential } from '@azure/identity';
import { loadContract } from '../../src/contract/load.ts';
import { SEED_TENANTS } from './data/index.ts';
import {
  SEED_CONTAINER,
  SeedGuardError,
  USAGE,
  assertSeedPrincipal,
  describePlan,
  parseSeedArgs,
  type CloudPlan,
  type SeedPlan,
} from './guards.ts';
import { SeedError, runSeed, type SeedResult } from './seeder.ts';
import { assertSeedContainer, createCosmosSeedStore } from './store.ts';
import { buildSeedDocs, validateSeedData } from './validate.ts';

export interface CommandIo {
  out(text: string): void;
  err(text: string): void;
}

export const EXIT = { ok: 0, failure: 1, drift: 2 } as const;

/** A failed read-back always fails; drift fails unless it was explicitly accepted. */
export function exitCodeFor(result: Pick<SeedResult, 'readBackOk' | 'drift'>, allowDrift: boolean): number {
  if (!result.readBackOk) return EXIT.failure;
  if (result.drift.length > 0 && !allowDrift) return EXIT.drift;
  return EXIT.ok;
}

const CONNECTION_POLICY = {
  requestTimeout: 10_000,
  retryOptions: { maxRetryAttemptCount: 3, maxWaitTimeInSeconds: 10 },
};

interface Connection {
  container: Container;
  close(): void;
}

function connect(plan: SeedPlan): Connection {
  const client =
    plan.target === 'emulator'
      ? new CosmosClient({
          endpoint: plan.endpoint,
          key: plan.key,
          userAgentSuffix: 'resolve-seed',
          connectionPolicy: { ...CONNECTION_POLICY, enableEndpointDiscovery: false },
        })
      : new CosmosClient({
          endpoint: plan.endpoint,
          aadCredentials: new ManagedIdentityCredential({ clientId: plan.clientId }),
          userAgentSuffix: 'resolve-seed',
          connectionPolicy: CONNECTION_POLICY,
        });
  return {
    container: client.database(plan.database).container(SEED_CONTAINER),
    close: () => {
      client.dispose();
    },
  };
}

async function assertCloudIdentity(plan: CloudPlan): Promise<void> {
  const credential = new ManagedIdentityCredential({ clientId: plan.clientId });
  const token = await credential.getToken('https://cosmos.azure.com/.default');
  assertSeedPrincipal(token.token, plan.expectedPrincipalId);
}

function summarize(error: unknown): string {
  if (error instanceof SeedGuardError || error instanceof SeedError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === 'string' || typeof code === 'number' ? ` (${String(code)})` : ''}: ${error.message.slice(0, 300)}`;
  }
  return 'unknown error';
}

function describeResult(plan: SeedPlan, result: SeedResult): string {
  const { readBack } = result;
  return [
    `target: ${describePlan(plan)}`,
    `seed: ${String(result.documents)} documents (created ${String(result.created)}, unchanged ${String(result.unchanged)}, drift ${String(result.drift.length)})`,
    `read-back: ${String(readBack.checked)} checked, ${String(readBack.missing.length)} missing, ${String(readBack.mismatched.length)} mismatched, ${String(readBack.notListed.length)} not listed`,
    '',
  ].join('\n');
}

/** Runs the seeder. Never called at application startup; there is no endpoint that reaches it. */
export async function runSeedCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CommandIo,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(USAGE);
    return EXIT.ok;
  }

  let plan: SeedPlan;
  try {
    plan = parseSeedArgs(argv, env);
  } catch (error) {
    io.err(`refused: ${summarize(error)}\n`);
    return EXIT.failure;
  }

  const problems = validateSeedData(SEED_TENANTS, loadContract());
  if (problems.length > 0) {
    for (const problem of problems) io.err(`fixture problem: ${problem.where}: ${problem.message}\n`);
    return EXIT.failure;
  }
  const docs = buildSeedDocs(SEED_TENANTS);

  if (plan.dryRun) {
    io.err(`target: ${describePlan(plan)}\n`);
    const counts = (type: string): number => docs.filter((doc) => doc.type === type).length;
    io.out(`dry run: ${String(docs.length)} documents (accounts ${String(counts('account'))}, invoices ${String(counts('invoice'))}, policies ${String(counts('policy'))}); nothing was written\n`);
    return EXIT.ok;
  }

  const connections: Connection[] = [];
  try {
    if (plan.target === 'cloud') await assertCloudIdentity(plan);
    const writer = connect(plan);
    const verifier = connect(plan);
    connections.push(writer, verifier);
    await assertSeedContainer(writer.container);

    const result = await runSeed({
      docs,
      writer: createCosmosSeedStore(writer.container),
      verifier: createCosmosSeedStore(verifier.container),
      log: (line) => {
        io.err(`${line}\n`);
      },
    });

    if (plan.json) {
      io.out(`${JSON.stringify({ target: plan.target, database: plan.database, container: SEED_CONTAINER, ...result })}\n`);
    } else {
      io.out(describeResult(plan, result));
    }

    const code = exitCodeFor(result, plan.allowDrift);
    if (code === EXIT.drift) {
      io.err('drift: stored documents differ from the fixtures; nothing was overwritten (use --allow-drift to accept)\n');
    }
    return code;
  } catch (error) {
    io.err(`failed: ${summarize(error)}\n`);
    return EXIT.failure;
  } finally {
    for (const connection of connections) connection.close();
  }
}
