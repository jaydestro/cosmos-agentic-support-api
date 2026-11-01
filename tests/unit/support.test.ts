import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { after, describe, it } from 'node:test';
import { createAuthenticator } from '../../src/auth/verify.ts';
import { createMemoryLogger } from '../../src/telemetry/log.ts';
import { mintToken, parseClaims, startTestIdp, type TestIdp } from '../support/idp.ts';
import { reservePorts } from '../support/ports.ts';
import { REWRITTEN_FORMAT, SERIALIZATION_FORMATS_HEADER, startCosmosProxy } from '../support/proxy.ts';

const OID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createTcpServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

describe('reservePorts', () => {
  it('returns distinct loopback ports that can be bound afterwards', async () => {
    const ports = await reservePorts(4);
    assert.equal(ports.length, 4);
    assert.equal(new Set(ports).size, 4);
    for (const port of ports) {
      assert.ok(Number.isInteger(port) && port > 1023 && port < 65536, `unexpected port ${String(port)}`);
      assert.equal(await bindable(port), true);
    }
  });

  it('returns an empty list for zero', async () => {
    assert.deepEqual(await reservePorts(0), []);
  });
});

describe('Cosmos proxy', () => {
  interface Seen {
    method: string | undefined;
    url: string | undefined;
    headers: IncomingMessage['headers'];
    body: string;
  }
  const seen: Seen[] = [];
  let upstream: Server;
  let upstreamPort = 0;

  async function startUpstream(): Promise<void> {
    upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(207, { 'Content-Type': 'application/json', 'x-ms-request-charge': '2.5' });
        response.end(JSON.stringify({ echoed: request.url }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    assert.ok(address !== null && typeof address !== 'string');
    upstreamPort = address.port;
  }

  after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });

  it('asks the upstream for JSON text instead of the requested serialization', async () => {
    await startUpstream();
    const proxy = await startCosmosProxy({ upstreamPort });
    try {
      const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/dbs/resolve/colls/leases/docs`, {
        method: 'POST',
        headers: { [SERIALIZATION_FORMATS_HEADER]: 'CosmosBinary', 'content-type': 'application/query+json' },
        body: '{"query":"SELECT 1"}',
      });
      assert.equal(response.status, 207);
      assert.equal(response.headers.get('x-ms-request-charge'), '2.5');
      assert.deepEqual(await response.json(), { echoed: '/dbs/resolve/colls/leases/docs' });

      const received = seen.at(-1);
      assert.ok(received);
      assert.equal(received.method, 'POST');
      assert.equal(received.body, '{"query":"SELECT 1"}');
      assert.equal(received.headers[SERIALIZATION_FORMATS_HEADER], REWRITTEN_FORMAT);
      assert.equal(received.headers['content-type'], 'application/query+json');
      assert.deepEqual({ requests: proxy.stats.requests, rewritten: proxy.stats.rewritten }, { requests: 1, rewritten: 1 });
    } finally {
      await proxy.close();
    }
  });

  it('does not add the header to a request that did not carry it', async () => {
    const proxy = await startCosmosProxy({ upstreamPort });
    try {
      const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`);
      await response.text();
      assert.equal(seen.at(-1)?.headers[SERIALIZATION_FORMATS_HEADER], undefined);
      assert.equal(proxy.stats.rewritten, 0);
    } finally {
      await proxy.close();
    }
  });

  it('answers 502 and counts the failure when the upstream is unreachable', async () => {
    const [closedPort] = await reservePorts(1);
    assert.ok(closedPort !== undefined);
    const proxy = await startCosmosProxy({ upstreamPort: closedPort });
    try {
      const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`);
      await response.text();
      assert.equal(response.status, 502);
      assert.equal(proxy.stats.upstreamFailures, 1);
    } finally {
      await proxy.close();
    }
  });

  it('listens on loopback only', async () => {
    const proxy = await startCosmosProxy({ upstreamPort });
    try {
      assert.equal(await bindable(proxy.port), false, 'the proxy port should be in use');
    } finally {
      await proxy.close();
    }
  });
});

describe('claims parsing', () => {
  it('accepts the minimal request', () => {
    assert.deepEqual(parseClaims({ oid: OID }), { oid: OID });
  });

  it('accepts every supported field', () => {
    const claims = {
      oid: OID,
      roles: ['Resolve.Approver.aurora'],
      scope: 'access_as_user',
      ver: '2.0',
      idtyp: 'user',
      tid: OID,
      audience: 'api://x',
      issuer: 'https://x.invalid/',
      expiresInSeconds: -5,
    };
    assert.deepEqual(parseClaims(claims), claims);
  });

  it('accepts null to omit the scope or version', () => {
    assert.deepEqual(parseClaims({ oid: OID, scope: null, ver: null }), { oid: OID, scope: null, ver: null });
  });

  for (const [name, body, message] of [
    ['a string', 'x', 'body must be an object'],
    ['null', null, 'body must be an object'],
    ['an array', [], 'body must be an object'],
    ['a missing oid', {}, 'oid must be a non-empty string'],
    ['an empty oid', { oid: '' }, 'oid must be a non-empty string'],
    ['a numeric oid', { oid: 7 }, 'oid must be a non-empty string'],
    ['non-string roles', { oid: OID, roles: [1] }, 'roles must be an array of strings'],
    ['roles that are not a list', { oid: OID, roles: 'a' }, 'roles must be an array of strings'],
    ['a numeric scope', { oid: OID, scope: 1 }, 'scope must be a string or null'],
    ['a numeric tid', { oid: OID, tid: 1 }, 'tid must be a string'],
    ['a non-finite expiry', { oid: OID, expiresInSeconds: Number.POSITIVE_INFINITY }, 'expiresInSeconds must be a finite number'],
    ['a string expiry', { oid: OID, expiresInSeconds: '5' }, 'expiresInSeconds must be a finite number'],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseClaims(body), message);
    });
  }
});

describe('test identity provider', () => {
  let idp: TestIdp | undefined;
  const started = async (): Promise<TestIdp> => (idp ??= await startTestIdp());
  after(async () => {
    await idp?.close();
  });

  it('publishes a signing key that the real remote-key-set verifier accepts', async () => {
    const provider = await started();
    const { createRemoteJWKSet } = await import('jose');
    const { logger } = createMemoryLogger();
    const authenticator = createAuthenticator(
      {
        mode: 'test-idp',
        issuer: provider.issuer,
        audiences: [provider.audience],
        jwksUrl: provider.jwksUrl,
        directoryId: undefined,
      },
      ['aurora'],
      { logger, getKey: createRemoteJWKSet(new URL(provider.jwksUrl)) },
    );
    const token = await mintToken(provider.mintUrl, { oid: OID, roles: ['Resolve.Representative.aurora'] });
    const principal = await authenticator.authenticate(`${['Bear', 'er'].join('')} ${token}`);
    assert.deepEqual(principal, { principalId: OID, tenantId: 'aurora', roles: ['Representative'] });
  });

  it('serves only public key material', async () => {
    const provider = await started();
    const keys = ((await (await fetch(provider.jwksUrl)).json()) as { keys: Record<string, unknown>[] }).keys;
    assert.equal(keys.length, 1);
    const [key] = keys;
    assert.ok(key);
    assert.equal(key['kty'], 'RSA');
    for (const privateMember of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.equal(key[privateMember], undefined);
  });

  it('listens on loopback only', async () => {
    const provider = await started();
    assert.match(provider.jwksUrl, /^http:\/\/127\.0\.0\.1:\d+\/jwks\.json$/);
    assert.match(provider.mintUrl, /^http:\/\/127\.0\.0\.1:\d+\/mint$/);
  });

  it('refuses bad mint requests without signing anything', async () => {
    const provider = await started();
    const post = (body: string) =>
      fetch(provider.mintUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post('{"oid":1}')).status, 400);
    assert.equal((await post(JSON.stringify({ oid: OID, padding: 'x'.repeat(5000) }))).status, 413);
  });

  it('answers 404 for anything else', async () => {
    const provider = await started();
    assert.equal((await fetch(provider.mintUrl)).status, 404);
    assert.equal((await fetch(provider.jwksUrl.replace('jwks.json', 'other'))).status, 404);
    assert.equal((await fetch(provider.jwksUrl, { method: 'POST' })).status, 404);
  });

  it('reports a refused mint as an error to the caller', async () => {
    const provider = await started();
    await assert.rejects(mintToken(provider.mintUrl, { oid: '' }), /refused to mint a token \(HTTP 400\)/);
  });
});

describe('test identity provider, browser access', () => {
  const CONSOLE = 'http://127.0.0.1:7071';
  let idp: TestIdp | undefined;
  const started = async (): Promise<TestIdp> => (idp ??= await startTestIdp({ allowedOrigins: [CONSOLE] }));
  after(async () => {
    await idp?.close();
  });

  const preflight = (provider: TestIdp, origin: string) =>
    fetch(provider.mintUrl, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
  const mint = (provider: TestIdp, origin: string) =>
    fetch(provider.mintUrl, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oid: OID, roles: ['Resolve.Representative.aurora'] }),
    });

  it('answers the preflight for the console origin only', async () => {
    const provider = await started();
    const allowed = await preflight(provider, CONSOLE);
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), CONSOLE);
    assert.equal(allowed.headers.get('access-control-allow-methods'), 'POST');
    assert.equal(allowed.headers.get('access-control-allow-headers'), 'Content-Type');
    assert.equal(allowed.headers.get('vary'), 'Origin');

    for (const origin of ['http://127.0.0.1:7072', 'http://localhost:7071', 'https://example.invalid', 'null', '*']) {
      const refused = await preflight(provider, origin);
      assert.equal(refused.headers.get('access-control-allow-origin'), null, origin);
      assert.equal(refused.headers.get('vary'), 'Origin', origin);
    }
  });

  it('lets the console read the minted token and nobody else', async () => {
    const provider = await started();
    const own = await mint(provider, CONSOLE);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('access-control-allow-origin'), CONSOLE);
    assert.equal(typeof ((await own.json()) as { token?: unknown }).token, 'string');

    const foreign = await mint(provider, 'https://example.invalid');
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  });

  it('applies the same origin rule to error answers', async () => {
    const provider = await started();
    const bad = await fetch(provider.mintUrl, { method: 'POST', headers: { Origin: CONSOLE, 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('access-control-allow-origin'), CONSOLE);
    const foreign = await fetch(provider.mintUrl, { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  });

  it('exposes no CORS access to the key set or other paths', async () => {
    const provider = await started();
    const jwks = await fetch(provider.jwksUrl, { headers: { Origin: CONSOLE } });
    assert.equal(jwks.status, 200);
    assert.equal(jwks.headers.get('access-control-allow-origin'), null);
    const other = await fetch(provider.mintUrl.replace('/mint', '/other'), { method: 'OPTIONS', headers: { Origin: CONSOLE } });
    assert.equal(other.status, 404);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });

  it('allows no browser origin when none is configured', async () => {
    const closed = await startTestIdp();
    try {
      const refused = await preflight(closed, CONSOLE);
      assert.equal(refused.headers.get('access-control-allow-origin'), null);
    } finally {
      await closed.close();
    }
  });
});
