import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const URL_VARIABLE = 'RESOLVE_STACK_CONTROL_URL';
const TOKEN_VARIABLE = 'RESOLVE_STACK_CONTROL_TOKEN';
const TOKEN_HEADER = 'x-resolve-control-token';
const RESTART_PATH = '/restart-host';
const MAX_BODY_BYTES = 4096;
const MAX_OVERRIDES = 16;
/** The only settings a test may change on a running stack: numeric limit overrides, which the application can only lower. */
const OVERRIDE_NAME = /^RESOLVE_LIMIT_[A-Z0-9_]{1,60}$/;
const OVERRIDE_VALUE = /^[0-9]{1,9}$/;

export const CONTROL_URL_VARIABLE = URL_VARIABLE;
export const CONTROL_TOKEN_VARIABLE = TOKEN_VARIABLE;

/** Raised when a restart is requested while another one is still running. */
export class RestartInProgressError extends Error {
  constructor() {
    super('A host restart is already in progress.');
    this.name = 'RestartInProgressError';
  }
}

/** What a restart may change. */
export interface RestartOptions {
  /**
   * The limit overrides (`RESOLVE_LIMIT_*`) the restarted host starts with. They replace those of earlier restarts, so
   * `{}` restores the defaults. Leaving this out keeps what the host already has.
   */
  readonly settings?: Readonly<Record<string, string>>;
}

/** What a test process may ask the stack's owner to do. */
export interface Controllable {
  restartHost(options?: RestartOptions): Promise<void>;
}

export interface ControlServer {
  /** The variables that let one child process, and nothing else, reach the server. */
  readonly environment: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

function sameSecret(supplied: string | undefined, expected: Buffer): boolean {
  if (supplied === undefined) return false;
  const given = Buffer.from(supplied);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function reply(response: ServerResponse, status: number, body?: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}

class BadControlRequest extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'BadControlRequest';
    this.status = status;
  }
}

/** Reads the whole body, which is always drained so the reply can still be delivered when it is too large. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.once('end', () => {
      if (size > MAX_BODY_BYTES) reject(new BadControlRequest(413, `The request body is larger than ${String(MAX_BODY_BYTES)} bytes.`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.once('error', reject);
  });
}

/** An empty body keeps the host's current settings; otherwise the body is `{"settings": {"RESOLVE_LIMIT_...": "3"}}`. */
function parseRestartOptions(text: string): RestartOptions {
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadControlRequest(400, 'The request body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BadControlRequest(400, 'The request body must be an object.');
  const unknownKey = Object.keys(parsed).find((key) => key !== 'settings');
  if (unknownKey !== undefined) throw new BadControlRequest(400, 'Only "settings" may be given.');
  const settings: unknown = (parsed as { settings?: unknown }).settings;
  if (settings === undefined) return {};
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new BadControlRequest(400, '"settings" must be an object.');
  const entries = Object.entries(settings);
  if (entries.length > MAX_OVERRIDES) throw new BadControlRequest(400, `At most ${String(MAX_OVERRIDES)} settings may be given.`);
  const accepted: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!OVERRIDE_NAME.test(name)) throw new BadControlRequest(400, 'Only RESOLVE_LIMIT_* settings may be changed.');
    if (typeof value !== 'string' || !OVERRIDE_VALUE.test(value)) throw new BadControlRequest(400, 'A setting value must be a whole number written as a string.');
    accepted[name] = value;
  }
  return { settings: accepted };
}

/**
 * A loopback-only server that lets the integration test process, which does not own the Functions host, ask the
 * stack's owner to restart it. Every call needs a random secret that only the child process receives.
 */
export async function startControlServer(target: Controllable): Promise<ControlServer> {
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(token);

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const refuse = (status: number, body: string): void => {
      request.resume();
      reply(response, status, body);
    };
    if (!sameSecret(request.headers[TOKEN_HEADER] as string | undefined, expected)) {
      refuse(401, 'A control token is required.');
      return;
    }
    if (request.url !== RESTART_PATH) {
      refuse(404, 'Unknown control operation.');
      return;
    }
    if (request.method !== 'POST') {
      refuse(405, 'Use POST.');
      return;
    }
    try {
      await target.restartHost(parseRestartOptions(await readBody(request)));
      reply(response, 204);
    } catch (error) {
      if (error instanceof BadControlRequest) reply(response, error.status, error.message);
      else if (error instanceof RestartInProgressError) reply(response, 409, error.message);
      else reply(response, 500, error instanceof Error ? error.message : 'The restart failed.');
    }
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) reply(response, 500, 'The control request failed.');
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    environment: { [URL_VARIABLE]: `http://127.0.0.1:${String(port)}`, [TOKEN_VARIABLE]: token },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * Restarts the stack's Functions host from inside a test process started by `tests/support/cli.ts run`. Passing
 * `options.settings` changes the limit overrides the restarted host starts with (`{}` restores the defaults).
 */
export async function restartHost(env: NodeJS.ProcessEnv = process.env, timeoutMs = 300_000, options: RestartOptions = {}): Promise<void> {
  const url = env[URL_VARIABLE] ?? '';
  const token = env[TOKEN_VARIABLE] ?? '';
  if (url === '' || token === '') {
    throw new Error('No stack control channel was found. Run integration tests through "npm run test:integration".');
  }
  const response = await fetch(`${url}${RESTART_PATH}`, {
    method: 'POST',
    headers: {
      [TOKEN_HEADER]: token,
      ...(options.settings === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.settings === undefined ? {} : { body: JSON.stringify({ settings: options.settings }) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 204) {
    throw new Error(`The stack could not restart the Functions host (${String(response.status)}): ${(await response.text()).slice(0, 500)}`);
  }
}
