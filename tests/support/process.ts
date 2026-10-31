import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';
import { sleep } from './wait.ts';

export interface RunResult {
  /** Exit status, or `null` when the process could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the executable could not be started, e.g. `ENOENT`. */
  startFailure?: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Runs a program without a shell and captures its output. Never rejects. */
export function run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs ?? 60_000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        const code: unknown = (error as { code?: unknown }).code;
        resolve({
          code: typeof code === 'number' ? code : null,
          stdout,
          stderr,
          timedOut: (error as { killed?: boolean }).killed === true,
          ...(typeof code === 'string' ? { startFailure: code } : {}),
        });
      },
    );
  });
}

/** Returns a copy of `env` whose PATH starts with `dir`, honoring the platform's variable-name casing. */
export function withPathPrefix(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const key = Object.keys(next).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const current = next[key];
  next[key] = current === undefined || current === '' ? dir : `${dir}${delimiter}${current}`;
  return next;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/** The full command line of a process, or `null` when it is gone or cannot be read. */
export async function commandLineOf(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const result = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}" -ErrorAction SilentlyContinue).CommandLine`,
      ],
      { timeoutMs: 20_000 },
    );
    const line = result.stdout.trim();
    return result.code === 0 && line !== '' ? line : null;
  }
  const result = await run('ps', ['-p', String(pid), '-o', 'args='], { timeoutMs: 10_000 });
  const line = result.stdout.trim();
  return result.code === 0 && line !== '' ? line : null;
}

/**
 * Stops a process and everything it started. On POSIX the process must have been spawned with
 * `detached: true` so that it leads its own process group.
 */
export async function killTree(pid: number, graceMs = 5000): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 20_000 });
    return;
  }
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pid, name);
    } catch {
      try {
        process.kill(pid, name);
      } catch {
        // Already gone.
      }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < deadline) await sleep(100);
  if (isAlive(pid)) signal('SIGKILL');
}
