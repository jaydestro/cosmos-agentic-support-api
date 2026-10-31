import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createTestIssuer, type TestIssuer, type TokenClaims } from './tokens.ts';

const MAX_BODY_BYTES = 4096;

export interface TestIdp {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly mintUrl: string;
  /** The same issuer, for tests that run in this process. */
  readonly signer: TestIssuer;
  close(): Promise<void>;
}

export interface TestIdpOptions {
  /** 0 (the default) picks a free port. */
  port?: number;
  /** Browser origins that may call `/mint` (the console page). Any other origin gets no CORS headers, so a browser blocks it. */
  allowedOrigins?: readonly string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Returns the claims, or a message naming the first invalid field. */
export function parseClaims(value: unknown): TokenClaims | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'body must be an object';
  const body = value as Record<string, unknown>;
  const claims: TokenClaims = { oid: '' };

  if (typeof body['oid'] !== 'string' || body['oid'] === '') return 'oid must be a non-empty string';
  claims.oid = body['oid'];

  for (const name of ['idtyp', 'tid', 'audience', 'issuer'] as const) {
    const field = body[name];
    if (field === undefined) continue;
    if (typeof field !== 'string') return `${name} must be a string`;
    claims[name] = field;
  }
  for (const name of ['scope', 'ver'] as const) {
    const field = body[name];
    if (field === undefined) continue;
    if (field !== null && typeof field !== 'string') return `${name} must be a string or null`;
    claims[name] = field;
  }
  if (body['roles'] !== undefined) {
    if (!isStringArray(body['roles'])) return 'roles must be an array of strings';
    claims.roles = body['roles'];
  }
  if (body['expiresInSeconds'] !== undefined) {
    if (typeof body['expiresInSeconds'] !== 'number' || !Number.isFinite(body['expiresInSeconds'])) {
      return 'expiresInSeconds must be a finite number';
    }
    claims.expiresInSeconds = body['expiresInSeconds'];
  }
  return claims;
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  response.end(text);
}

/**
 * A loopback-only identity provider for tests: it publishes a JWKS and signs whatever claims a test asks for.
 * It exists only inside the test lifecycle; the application refuses `AUTH_MODE=test-idp` on Azure hosting.
 */
export async function startTestIdp(options: TestIdpOptions = {}): Promise<TestIdp> {
  const signer = await createTestIssuer();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  // Only `/mint` is meant for a browser. The answer varies by origin so a shared cache never serves one origin's headers to another.
  const mintHeaders = (request: IncomingMessage): Record<string, string> => {
    const origin = request.headers.origin;
    return typeof origin === 'string' && allowedOrigins.has(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : { Vary: 'Origin' };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && path === '/jwks.json') {
      sendJson(response, 200, signer.jwks());
      return;
    }
    if (request.method === 'OPTIONS' && path === '/mint') {
      response.writeHead(204, {
        ...mintHeaders(request),
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      response.end();
      return;
    }
    if (request.method === 'POST' && path === '/mint') {
      const cors = mintHeaders(request);
      const text = await readBody(request);
      if (text === null) {
        sendJson(response, 413, { error: 'body too large' }, cors);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        sendJson(response, 400, { error: 'body is not JSON' }, cors);
        return;
      }
      const claims = parseClaims(parsed);
      if (typeof claims === 'string') {
        sendJson(response, 400, { error: claims }, cors);
        return;
      }
      sendJson(response, 200, { token: await signer.mint(claims) }, cors);
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'failed' });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The test IdP has no address');
  const origin = `http://127.0.0.1:${String(address.port)}`;

  return {
    issuer: signer.issuer,
    audience: signer.audience,
    jwksUrl: `${origin}/jwks.json`,
    mintUrl: `${origin}/mint`,
    signer,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Asks a running test IdP (possibly in another process) for a signed token. */
export async function mintToken(mintUrl: string, claims: TokenClaims): Promise<string> {
  const response = await fetch(mintUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(claims),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`The test IdP refused to mint a token (HTTP ${String(response.status)})`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string') throw new Error('The test IdP returned no token');
  return body.token;
}
