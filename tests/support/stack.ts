import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, closeSync, openSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CosmosClient } from '@azure/cosmos';
import { PACKAGE_MARKER, defaultPackageDir } from '../../tools/build/stage.ts';
import { EXIT, runSeedCommand } from '../../tools/seed/command.ts';
import { RestartInProgressError, type RestartOptions } from './control.ts';
import { startTestIdp, type TestIdp } from './idp.ts';
import { commandLineOf, isAlive, killTree, run, withPathPrefix } from './process.ts';
import { reservePorts } from './ports.ts';
import { startCosmosProxy, type CosmosProxy, type ProxyStats } from './proxy.ts';
import { loadManifest, provisionDatabase } from './provision.ts';
import { waitFor } from './wait.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILE = join(ROOT, 'tests', 'support', 'compose.yaml');
const AZURITE_ACCOUNT = 'resolvelocal';
const FUNC = process.env['RESOLVE_FUNC'] ?? 'func';

/** Names that belong to the application or the host; they must come from the stack, never from the caller's shell. */
const APPLICATION_VARIABLE =
  /^(COSMOS_|AUTH_|TEST_IDP_|RESOLVE_|TRIGGER_|AGENT_|LIVE_MODEL_|APPROVAL_|RESPONSE_VALIDATION$|ALLOWED_ORIGINS$|PROVIDER_FAULTS|ENTRA_|SEED_|AzureWebJobs|FUNCTIONS_|WEBSITE_|APPLICATIONINSIGHTS_)/i;

export interface StackPorts {
  gateway: number;
  health: number;
  blob: number;
  queue: number;
  table: number;
  host: number;
}

/** Everything needed to find and remove a stack's resources later. Holds no secrets. */
export interface StackState {
  id: string;
  project: string;
  startedAt: string;
  ownerPid: number;
  ports: StackPorts;
  hostPid: number | null;
}

export interface StackOptions {
  root?: string;
  packageDir?: string;
  /** Seed the fictional reference data (default true). */
  seed?: boolean;
  hostTimeoutMs?: number;
  log?: (line: string) => void;
  /** Extra application settings, applied last (for example to enable provider fault injection). */
  settings?: Readonly<Record<string, string>>;
}

export interface Stack {
  readonly id: string;
  readonly apiUrl: string;
  readonly idpMintUrl: string;
  readonly idpJwksUrl: string;
  readonly cosmosEndpoint: string;
  readonly cosmosKey: string;
  readonly database: string;
  readonly diagnosticsDir: string;
  readonly hostLog: string;
  /** Resolves when the Functions host ends without being stopped on purpose, with its exit code. */
  readonly hostExited: Promise<number | null>;
  proxyStats(): Readonly<ProxyStats>;
  captureDiagnostics(reason: string): Promise<string>;
  /**
   * Kills the Functions host without warning, as a crash would, and starts it again on the same port with the same
   * settings, or with the limit overrides in `options.settings` (which replace earlier ones; `{}` restores the defaults).
   * Resolves when `/api/health` answers. The change feed trigger takes up to the lease expiration to resume.
   */
  restartHost(options?: RestartOptions): Promise<void>;
  stop(): Promise<void>;
}

export const stackRoot = (root: string): string => join(root, '.artifacts', 'stack');
export const diagnosticsRoot = (root: string): string => join(root, '.artifacts', 'diagnostics');

const statePath = (root: string, id: string): string => join(stackRoot(root), id, 'state.json');

async function writeState(root: string, state: StackState): Promise<void> {
  await writeFile(statePath(root, state.id), `${JSON.stringify(state, null, 2)}\n`);
}

export async function readStates(root: string): Promise<StackState[]> {
  const entries = await readdir(stackRoot(root)).catch(() => [] as string[]);
  const states: StackState[] = [];
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(await readFile(statePath(root, entry), 'utf8')) as Partial<StackState>;
      if (parsed.id === entry && typeof parsed.project === 'string' && /^resolve-stk-[0-9a-f]{8}$/.test(parsed.project) && typeof parsed.ports?.host === 'number') {
        states.push(parsed as StackState);
      }
    } catch {
      // A directory without a readable state file is not ours to act on.
    }
  }
  return states;
}

function composeEnvironment(state: StackState, azuriteKey: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RESOLVE_STACK_ID: state.id,
    COSMOS_GATEWAY_PORT: String(state.ports.gateway),
    COSMOS_HEALTH_PORT: String(state.ports.health),
    AZURITE_KEY: azuriteKey,
    AZURITE_BLOB_PORT: String(state.ports.blob),
    AZURITE_QUEUE_PORT: String(state.ports.queue),
    AZURITE_TABLE_PORT: String(state.ports.table),
  };
}

const composeArgs = (project: string, ...rest: string[]): string[] => ['compose', '-p', project, '-f', COMPOSE_FILE, ...rest];
const projectOf = (id: string): string => `resolve-stk-${id}`;

/** Removing a project needs only its name, but Compose still interpolates the file, so supply harmless placeholders. */
async function removeComposeProject(id: string): Promise<boolean> {
  const placeholders: NodeJS.ProcessEnv = {
    ...process.env,
    RESOLVE_STACK_ID: id,
    COSMOS_GATEWAY_PORT: '1',
    COSMOS_HEALTH_PORT: '1',
    AZURITE_KEY: 'unused',
    AZURITE_BLOB_PORT: '1',
    AZURITE_QUEUE_PORT: '1',
    AZURITE_TABLE_PORT: '1',
  };
  const result = await run('docker', composeArgs(projectOf(id), 'down', '--volumes', '--remove-orphans', '--timeout', '5'), {
    env: placeholders,
    timeoutMs: 120_000,
  });
  return result.code === 0;
}

const redactAll = (text: string, secrets: readonly string[]): string =>
  secrets.filter((secret) => secret.length > 0).reduce((current, secret) => current.split(secret).join('[redacted]'), text);

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolveConnect(false);
    });
  });
}

async function httpOk(url: string): Promise<boolean> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  await response.arrayBuffer();
  return response.ok;
}

export async function preflight(root: string, packageDir: string): Promise<void> {
  const problems: string[] = [];
  if (process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    problems.push('NODE_TLS_REJECT_UNAUTHORIZED=0 is set; the stack never disables TLS verification. Unset it.');
  }
  const docker = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30_000 });
  if (docker.code !== 0) problems.push('Docker is not available or its daemon is not running.');
  else if ((await run('docker', ['compose', 'version', '--short'], { timeoutMs: 30_000 })).code !== 0) {
    problems.push('Docker Compose v2 is required (docker compose).');
  }
  const func = await run(FUNC, ['--version'], { timeoutMs: 30_000 });
  if (func.code !== 0 || !/^4\./.test(func.stdout.trim())) {
    problems.push('Azure Functions Core Tools 4.x (func) was not found on PATH; set RESOLVE_FUNC to its location.');
  }
  const wanted = (await readFile(join(root, '.node-version'), 'utf8')).trim().split('.')[0];
  if (process.versions.node.split('.')[0] !== wanted) {
    problems.push(`Node ${String(wanted)}.x is required (see .node-version); this is ${process.versions.node}. The host's worker uses the same Node.`);
  }
  if (!existsSync(join(packageDir, PACKAGE_MARKER)) || !existsSync(join(packageDir, 'dist', 'src', 'index.js'))) {
    problems.push('The deployable package is missing; run `npm run package` first.');
  }
  if (problems.length > 0) throw new Error(`Preflight failed:\n- ${problems.join('\n- ')}`);
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const root = options.root ?? ROOT;
  const packageDir = options.packageDir ?? defaultPackageDir(root);
  const log = options.log ?? (() => undefined);
  await preflight(root, packageDir);

  const id = randomUUID().replaceAll('-', '').slice(0, 8);
  const cosmosKey = randomBytes(64).toString('base64');
  const azuriteKey = randomBytes(32).toString('base64');
  const secrets = [cosmosKey, azuriteKey];
  const redact = (text: string): string => redactAll(text, secrets);

  const [gateway, health, blob, queue, table, host] = await reservePorts(6);
  if (gateway === undefined || health === undefined || blob === undefined || queue === undefined || table === undefined || host === undefined) {
    throw new Error('Could not reserve free loopback ports.');
  }
  const state: StackState = {
    id,
    project: projectOf(id),
    startedAt: new Date().toISOString(),
    ownerPid: process.pid,
    ports: { gateway, health, blob, queue, table, host },
    hostPid: null,
  };
  const stackDir = join(stackRoot(root), id);
  const hostLog = join(stackDir, 'host.log');
  const diagnosticsDir = join(diagnosticsRoot(root), id);
  const cosmosEndpoint = `http://127.0.0.1:${String(gateway)}`;
  const apiUrl = `http://127.0.0.1:${String(host)}`;
  const database = 'resolve';
  const composeEnv = composeEnvironment(state, azuriteKey);

  const cleanups: { name: string; action: () => Promise<void> }[] = [];
  let proxy: CosmosProxy | undefined;
  let idp: TestIdp | undefined;
  let hostExit: { code: number | null } | undefined;
  let hostRestarts = 0;
  let probeClient: CosmosClient | undefined;

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      let failed = false;
      for (const cleanup of [...cleanups].reverse()) {
        try {
          await cleanup.action();
        } catch (error) {
          failed = true;
          log(`cleanup ${cleanup.name} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
      // Keep the record when something could not be removed, so `down` can finish the job.
      if (!failed) await rm(stackDir, { recursive: true, force: true });
    })());

  async function tail(file: string, lines: number): Promise<string> {
    const text = await readFile(file, 'utf8').catch(() => '');
    return redact(text.split(/\r?\n/).slice(-lines).join('\n'));
  }

  async function captureDiagnostics(reason: string): Promise<string> {
    await mkdir(diagnosticsDir, { recursive: true });
    // A whole serial integration run writes about 25,000 host log lines; keep enough that a failure early in it is still captured.
    await writeFile(join(diagnosticsDir, 'host.log'), await tail(hostLog, 30_000));
    const logs = await run('docker', composeArgs(state.project, 'logs', '--no-color', '--tail', '500'), {
      env: composeEnv,
      timeoutMs: 60_000,
    });
    await writeFile(join(diagnosticsDir, 'compose.log'), redact(`${logs.stdout}\n${logs.stderr}`));
    await writeFile(
      join(diagnosticsDir, 'summary.json'),
      `${JSON.stringify({ reason: redact(reason), state, proxy: proxy?.stats ?? null, hostExit: hostExit ?? null, hostRestarts, capturedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    return diagnosticsDir;
  }

  try {
    await mkdir(stackDir, { recursive: true });
    await writeState(root, state);

    log(`starting emulators (project ${state.project})`);
    cleanups.push({
      name: 'compose',
      action: async () => {
        if (!(await removeComposeProject(id))) throw new Error('docker compose down failed');
      },
    });
    const up = await run('docker', composeArgs(state.project, 'up', '--detach', '--quiet-pull'), { env: composeEnv, timeoutMs: 300_000 });
    if (up.code !== 0) throw new Error(`docker compose up failed: ${redact(up.stderr.trim().slice(-800))}`);

    await waitFor('the Cosmos DB emulator to report ready', () => httpOk(`http://127.0.0.1:${String(health)}/ready`), { timeoutMs: 120_000, intervalMs: 1000 });
    for (const [name, port] of [['blob', blob], ['queue', queue], ['table', table]] as const) {
      await waitFor(`Azurite ${name} to accept connections`, () => canConnect(port), { timeoutMs: 60_000 });
    }

    proxy = await startCosmosProxy({ upstreamPort: gateway });
    cleanups.push({ name: 'proxy', action: () => proxy?.close() ?? Promise.resolve() });
    idp = await startTestIdp({ allowedOrigins: [apiUrl, `http://localhost:${String(host)}`] });
    cleanups.push({ name: 'idp', action: () => idp?.close() ?? Promise.resolve() });

    log('provisioning database and containers');
    const manifest = await loadManifest(root);
    await provisionDatabase({ endpoint: cosmosEndpoint, key: cosmosKey, manifest, database });

    const azureStorage = [
      'DefaultEndpointsProtocol=http',
      `AccountName=${AZURITE_ACCOUNT}`,
      `AccountKey=${azuriteKey}`,
      `BlobEndpoint=http://127.0.0.1:${String(blob)}/${AZURITE_ACCOUNT}`,
      `QueueEndpoint=http://127.0.0.1:${String(queue)}/${AZURITE_ACCOUNT}`,
      `TableEndpoint=http://127.0.0.1:${String(table)}/${AZURITE_ACCOUNT}`,
    ].join(';');
    const settings: Record<string, string> = {
      FUNCTIONS_WORKER_RUNTIME: 'node',
      FUNCTIONS_CORE_TOOLS_TELEMETRY_OPTOUT: '1',
      AzureWebJobsStorage: azureStorage,
      // The Functions host (a .NET process) reaches the emulator through the header-rewriting proxy.
      COSMOS_CONNECTION: `AccountEndpoint=http://127.0.0.1:${String(proxy.port)}/;AccountKey=${cosmosKey};`,
      COSMOS_DATABASE: database,
      COSMOS_ENDPOINT: cosmosEndpoint,
      COSMOS_AUTH: 'emulator-key',
      COSMOS_KEY: cosmosKey,
      RESOLVE_ENV: process.env['CI'] === undefined ? 'local' : 'ci',
      AUTH_MODE: 'test-idp',
      TEST_IDP_ISSUER: idp.issuer,
      TEST_IDP_AUDIENCE: idp.audience,
      TEST_IDP_JWKS_URL: idp.jwksUrl,
      TEST_IDP_MINT_URL: idp.mintUrl,
      RESOLVE_TENANTS: 'aurora,borealis',
      AGENT_MODE: 'demo',
      PROVIDER_FAULTS_ENABLED: 'true',
      TRIGGER_FEED_POLL_MS: '500',
      TRIGGER_LEASE_ACQUIRE_MS: '2000',
      TRIGGER_LEASE_EXPIRATION_MS: '15000',
      TRIGGER_LEASE_RENEW_MS: '4000',
      // Admission counts cost nothing, and these suites share two tenants and one day's allowance (see src/config/limits.ts).
      RESOLVE_LIMIT_TENANT_CASES_PER_UTC_DAY: '1000',
      RESOLVE_LIMIT_TENANT_CONCURRENT_RUNS: '100',
      ...options.settings,
    };
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !APPLICATION_VARIABLE.test(name)));
    // Limit overrides a test asked for through the control channel. They outlive restarts until it replaces them.
    let overrides: Readonly<Record<string, string>> = {};
    const hostEnvironment = (): NodeJS.ProcessEnv => withPathPrefix({ ...inherited, ...settings, ...overrides }, dirname(process.execPath));

    log(`starting the Functions host on port ${String(host)}`);
    // A process stopped on purpose (a restart or the final cleanup) is not a lost host, so `hostExited` ignores it.
    const intentional = new WeakSet<ChildProcess>();
    let running: { child: ChildProcess; pid: number; exited: Promise<void> } | undefined;
    let reportLost: (code: number | null) => void = () => undefined;
    const hostExited = new Promise<number | null>((resolveLost) => {
      reportLost = resolveLost;
    });
    const hostGone = (): string | undefined => (hostExit === undefined ? undefined : `the Functions host exited (code ${String(hostExit.code)})`);

    function launchHost(): void {
      hostExit = undefined;
      const logFd = openSync(hostLog, 'a');
      const child = spawn(FUNC, ['start', '--verbose', '--port', String(host)], {
        cwd: packageDir,
        env: hostEnvironment(),
        stdio: ['ignore', logFd, logFd],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      closeSync(logFd);
      let spawnFailure: string | undefined;
      const exited = new Promise<void>((resolveExit) => {
        const ended = (code: number | null): void => {
          hostExit = { code };
          // The pid may be reused once the process is gone, so nothing may kill it later.
          if (running?.child === child) running = undefined;
          if (!intentional.has(child)) reportLost(code);
          resolveExit();
        };
        child.once('error', (error) => {
          spawnFailure = error.message;
          ended(null);
        });
        child.once('exit', ended);
      });
      if (child.pid === undefined) throw new Error(`The Functions host could not be started: ${spawnFailure ?? 'unknown error'}`);
      running = { child, pid: child.pid, exited };
    }

    async function startHost(): Promise<void> {
      launchHost();
      if (running === undefined) throw new Error('The Functions host could not be started.');
      state.hostPid = running.pid;
      await writeState(root, state);
      await waitFor('the Functions host to answer /api/health', () => httpOk(`${apiUrl}/api/health`), {
        timeoutMs: options.hostTimeoutMs ?? 180_000,
        intervalMs: 500,
        abortWhen: hostGone,
      });
    }

    cleanups.push({
      name: 'host',
      action: async () => {
        const live = running;
        if (live === undefined) return;
        intentional.add(live.child);
        await killTree(live.pid);
      },
    });
    await startHost();

    let restarting: Promise<void> | undefined;
    const restartHost = (restart: RestartOptions = {}): Promise<void> => {
      if (restarting !== undefined) return Promise.reject(new RestartInProgressError());
      const attempt = (async (): Promise<void> => {
        const previous = running;
        if (stopping !== undefined || previous === undefined) throw new Error('The Functions host is not running.');
        log('restarting the Functions host');
        intentional.add(previous.child);
        await killTree(previous.pid);
        await previous.exited;
        await waitFor('the stopped host to release its port', async () => !(await canConnect(host)), { timeoutMs: 30_000, intervalMs: 200 });
        const changed = restart.settings === undefined ? '' : ` with ${String(Object.keys(restart.settings).length)} limit override(s)`;
        await appendFile(hostLog, `\n--- Functions host restarted at ${new Date().toISOString()}${changed} ---\n`);
        if (stopping !== undefined) throw new Error('The stack is stopping.');
        if (restart.settings !== undefined) overrides = { ...restart.settings };
        hostRestarts += 1;
        await startHost();
      })();
      restarting = attempt;
      const done = (): void => {
        restarting = undefined;
      };
      void attempt.then(done, done);
      return attempt;
    };

    probeClient = new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey, connectionPolicy: { enableEndpointDiscovery: false } });
    cleanups.push({ name: 'probe-client', action: () => Promise.resolve(probeClient?.dispose()) });
    const leases = probeClient.database(database).container('leases');
    await waitFor(
      'the Cosmos DB trigger to acquire its leases',
      async () => {
        const { resources } = await leases.items.query('SELECT c.id FROM c').fetchAll();
        return resources.length >= 2 ? resources.length : undefined;
      },
      { timeoutMs: 90_000, intervalMs: 500, abortWhen: hostGone },
    );

    if (options.seed ?? true) {
      log('seeding fictional reference data');
      let output = '';
      const code = await runSeedCommand(
        ['--target', 'emulator', '--endpoint', cosmosEndpoint, '--database', database],
        { COSMOS_KEY: cosmosKey },
        { out: (text) => (output += text), err: (text) => (output += text) },
      );
      if (code !== EXIT.ok) throw new Error(`Seeding failed (exit ${String(code)}):\n${redact(output).slice(-1500)}`);
    }

    const stats = proxy.stats;
    return {
      id,
      apiUrl,
      idpMintUrl: idp.mintUrl,
      idpJwksUrl: idp.jwksUrl,
      cosmosEndpoint,
      cosmosKey,
      database,
      diagnosticsDir,
      hostLog,
      hostExited,
      proxyStats: () => ({ ...stats }),
      captureDiagnostics,
      restartHost,
      stop,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    let where: string;
    try {
      where = `\nDiagnostics: ${await captureDiagnostics(message)}`;
    } catch {
      where = '\nDiagnostics could not be captured.';
    }
    const hostTail = await tail(hostLog, 25);
    await stop();
    throw new Error(`${redact(message)}${where}${hostTail === '' ? '' : `\nLast host output:\n${hostTail}`}`, { cause: error });
  }
}

/** Removes the resources recorded by one stack, and nothing else. Returns whether everything was removed. */
export async function tearDown(root: string, state: StackState, log: (line: string) => void = () => undefined): Promise<boolean> {
  if (state.hostPid !== null && isAlive(state.hostPid)) {
    const commandLine = await commandLineOf(state.hostPid);
    if (commandLine !== null && commandLine.includes(`--port ${String(state.ports.host)}`) && /\bstart\b/.test(commandLine)) {
      log(`stopping Functions host ${String(state.hostPid)}`);
      await killTree(state.hostPid);
    } else {
      log(`process ${String(state.hostPid)} is no longer this stack's host; leaving it alone`);
    }
  }
  const removed = await removeComposeProject(state.id);
  log(`compose project ${state.project}: ${removed ? 'removed' : 'could not be removed'}`);
  if (removed) await rm(join(stackRoot(root), state.id), { recursive: true, force: true });
  return removed;
}

export interface StackContainer {
  containerId: string;
  stackId: string;
}

/**
 * Containers created by this tooling. A container qualifies only when its owner label and its Compose
 * project agree, so containers from anything else (including look-alike names) are never matched.
 */
export async function listStackContainers(): Promise<StackContainer[]> {
  const result = await run(
    'docker',
    ['ps', '--all', '--filter', 'label=resolve.owner', '--format', '{{.ID}}|{{.Label "resolve.owner"}}|{{.Label "com.docker.compose.project"}}'],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) return [];
  const found: StackContainer[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [containerId, owner, project] = line.trim().split('|');
    if (containerId !== undefined && owner !== undefined && /^[0-9a-f]{8}$/.test(owner) && project === projectOf(owner)) {
      found.push({ containerId, stackId: owner });
    }
  }
  return found;
}

/** Removes the Compose project of every container this tooling created that no state record accounts for. */
export async function removeOrphans(root: string, log: (line: string) => void = () => undefined): Promise<string[]> {
  const known = new Set((await readStates(root)).map((state) => state.id));
  const orphans = [...new Set((await listStackContainers()).map((container) => container.stackId))].filter((id) => !known.has(id));
  const removed: string[] = [];
  for (const id of orphans) {
    const ok = await removeComposeProject(id);
    log(`orphaned project ${projectOf(id)}: ${ok ? 'removed' : 'could not be removed'}`);
    if (ok) removed.push(projectOf(id));
  }
  return removed;
}
