import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startControlServer, type ControlServer } from './control.ts';
import { stackEnvironment } from './env.ts';
import { isAlive, killTree } from './process.ts';
import { ROOT, listStackContainers, readStates, removeOrphans, startStack, tearDown, type Stack } from './stack.ts';

const USAGE = `Usage:
  node tests/support/cli.ts up [--no-seed]
      Start the emulators, the Functions host and a test identity provider; keep them running until Ctrl+C.
  node tests/support/cli.ts run [--no-seed] [--timeout <seconds>] -- <command> [args...]
      Start the stack, run the command with RESOLVE_STACK_* variables set, then remove everything.
  node tests/support/cli.ts down [--all]
      Remove stacks left behind by a crashed run. Stacks whose owning process is alive are skipped unless --all.
  node tests/support/cli.ts status
      List recorded stacks.
`;

const EXIT = { ok: 0, usage: 2, startFailed: 3, timeout: 4, hostLost: 5, interrupted: 130 } as const;
const DEFAULT_TIMEOUT_SECONDS = 900;

const info = (line: string): void => void process.stdout.write(`${line}\n`);
const fail = (line: string): void => void process.stderr.write(`${line}\n`);

function describe(stack: Stack): void {
  info(`Resolve stack ${stack.id} is running (simulated credits only; fictional data).`);
  info(`  Console:        ${stack.apiUrl}/`);
  info(`  API reference:  ${stack.apiUrl}/reference/`);
  info(`  Token service:  POST ${stack.idpMintUrl}   (test identity provider; accepts claims as JSON)`);
  info(`  Cosmos DB:      ${stack.cosmosEndpoint}   (emulator; the per-run key is not printed)`);
  info(`  Host log:       ${stack.hostLog}`);
}

async function runCommand(command: readonly string[], seed: boolean, timeoutSeconds: number): Promise<number> {
  const [program, ...args] = command;
  if (program === undefined) {
    fail('run needs a command after --');
    return EXIT.usage;
  }

  let stack: Stack;
  try {
    stack = await startStack({ seed, log: info });
  } catch (error) {
    fail(error instanceof Error ? error.message : 'The stack failed to start.');
    return EXIT.startFailed;
  }

  let control: ControlServer;
  try {
    control = await startControlServer(stack);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'The stack control channel could not be started.');
    await stack.stop();
    return EXIT.startFailed;
  }

  let timedOut = false;
  let hostLost = false;
  let finished = false;
  let signal: NodeJS.Signals | undefined;

  const child = spawn(program === 'node' ? process.execPath : program, args, {
    env: { ...process.env, ...stackEnvironment(stack), ...control.environment },
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const stopChild = (): void => {
    if (child.pid !== undefined) void killTree(child.pid);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    stopChild();
  }, timeoutSeconds * 1000);
  const onSignal = (received: NodeJS.Signals): void => {
    signal = received;
    stopChild();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  void stack.hostExited.then(() => {
    if (!finished) {
      hostLost = true;
      stopChild();
    }
  });

  const code = await new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      fail(`Could not start the command: ${error.message}`);
      resolve(null);
    });
    child.once('exit', (exitCode) => resolve(exitCode));
  });
  finished = true;
  clearTimeout(timer);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await control.close();

  let exitCode: number;
  if (timedOut) exitCode = EXIT.timeout;
  else if (hostLost) exitCode = EXIT.hostLost;
  else if (signal !== undefined) exitCode = EXIT.interrupted;
  else exitCode = code ?? 1;

  if (exitCode !== EXIT.ok) {
    const reason = timedOut
      ? `the command did not finish within ${String(timeoutSeconds)}s`
      : hostLost
        ? 'the Functions host exited while the command was running'
        : `the command exited with ${String(exitCode)}`;
    try {
      const directory = await stack.captureDiagnostics(reason);
      info(`Diagnostics saved to ${directory}`);
      // Fictional, redacted data only: surface warnings and outbox outcomes in the job log, which has no artifact upload.
      if (process.env['CI'] !== undefined) {
        const text = await readFile(join(directory, 'host.log'), 'utf8').catch(() => '');
        const interesting = text.split(/\r?\n/).filter((line) => /outbox|poison|retry|could not|unhandled|warn|error/i.test(line)).slice(-80);
        for (const line of interesting) info(`host: ${line.slice(0, 400)}`);
      }
    } catch (error) {
      fail(`Diagnostics could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  await stack.stop();
  return exitCode;
}

async function upCommand(seed: boolean): Promise<number> {
  let stack: Stack;
  try {
    stack = await startStack({ seed, log: info });
  } catch (error) {
    fail(error instanceof Error ? error.message : 'The stack failed to start.');
    return EXIT.startFailed;
  }
  describe(stack);
  info('Press Ctrl+C to stop and remove everything.');

  const reason = await new Promise<'signal' | 'host'>((resolve) => {
    process.once('SIGINT', () => resolve('signal'));
    process.once('SIGTERM', () => resolve('signal'));
    void stack.hostExited.then(() => resolve('host'));
  });
  if (reason === 'host') {
    fail('The Functions host exited unexpectedly.');
    info(`Diagnostics saved to ${await stack.captureDiagnostics('the Functions host exited')}`);
  }
  info('Stopping.');
  await stack.stop();
  return reason === 'host' ? EXIT.hostLost : EXIT.ok;
}

async function downCommand(all: boolean): Promise<number> {
  let failures = 0;
  for (const state of await readStates(ROOT)) {
    if (!all && isAlive(state.ownerPid)) {
      info(`Skipping ${state.id}: its owner process (${String(state.ownerPid)}) is still running. Use --all to stop it anyway.`);
      continue;
    }
    if (!(await tearDown(ROOT, state, info))) failures += 1;
  }
  await removeOrphans(ROOT, info);
  return failures === 0 ? EXIT.ok : 1;
}

async function statusCommand(): Promise<number> {
  const states = await readStates(ROOT);
  if (states.length === 0) info('No stacks are recorded.');
  for (const state of states) {
    const owner = isAlive(state.ownerPid) ? 'running' : 'gone';
    const host = state.hostPid === null ? 'not started' : isAlive(state.hostPid) ? 'running' : 'gone';
    info(`${state.id}  started ${state.startedAt}  owner ${String(state.ownerPid)} (${owner})  host ${host}  api http://127.0.0.1:${String(state.ports.host)}`);
  }
  const containers = await listStackContainers();
  info(`${String(containers.length)} container(s) carry a resolve.owner label.`);
  return EXIT.ok;
}

const parse = (args: readonly string[]) =>
  parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { 'no-seed': { type: 'boolean' }, all: { type: 'boolean' }, timeout: { type: 'string' } },
  });

async function main(argv: readonly string[]): Promise<number> {
  const separator = argv.indexOf('--');
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const tail = separator === -1 ? [] : argv.slice(separator + 1);

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(head);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Invalid arguments.');
    fail(USAGE);
    return EXIT.usage;
  }

  const [verb, ...extra] = parsed.positionals;
  const seed = parsed.values['no-seed'] !== true;
  if (extra.length > 0) {
    fail(`Unexpected argument: ${extra[0] ?? ''}`);
    fail(USAGE);
    return EXIT.usage;
  }

  switch (verb) {
    case 'up':
      return upCommand(seed);
    case 'run': {
      const raw = parsed.values['timeout'];
      const seconds = raw === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(raw);
      if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 10 || seconds > 7200) {
        fail('--timeout must be a whole number of seconds from 10 to 7200.');
        return EXIT.usage;
      }
      return runCommand(tail, seed, seconds);
    }
    case 'down':
      return downCommand(parsed.values['all'] === true);
    case 'status':
      return statusCommand();
    case undefined:
    default:
      fail(USAGE);
      return EXIT.usage;
  }
}

process.exitCode = await main(process.argv.slice(2));
