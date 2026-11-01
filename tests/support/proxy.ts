import { Agent, createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';

/**
 * The Functions host (a .NET process) asks the vNext emulator for binary-encoded query results, and the
 * emulator's binary encoding of lease queries is defective. Asking for JSON text instead avoids the defect.
 * Only the trigger connection goes through this proxy; the application's own JavaScript SDK connects directly.
 */
export const SERIALIZATION_FORMATS_HEADER = 'x-ms-cosmos-supported-serialization-formats';
export const REWRITTEN_FORMAT = 'JsonText';

export interface ProxyStats {
  requests: number;
  rewritten: number;
  upstreamFailures: number;
}

export interface CosmosProxy {
  readonly port: number;
  readonly stats: Readonly<ProxyStats>;
  close(): Promise<void>;
}

export interface ProxyOptions {
  upstreamPort: number;
  upstreamHost?: string;
  /** 0 (the default) picks a free port. */
  port?: number;
}

export async function startCosmosProxy(options: ProxyOptions): Promise<CosmosProxy> {
  const upstreamHost = options.upstreamHost ?? '127.0.0.1';
  const agent = new Agent({ keepAlive: true });
  const stats: ProxyStats = { requests: 0, rewritten: 0, upstreamFailures: 0 };

  const server: Server = createServer((incoming, outgoing) => {
    stats.requests += 1;
    const headers: IncomingHttpHeaders = { ...incoming.headers };
    if (headers[SERIALIZATION_FORMATS_HEADER] !== undefined) {
      headers[SERIALIZATION_FORMATS_HEADER] = REWRITTEN_FORMAT;
      stats.rewritten += 1;
    }

    const upstream = request(
      { host: upstreamHost, port: options.upstreamPort, method: incoming.method, path: incoming.url, headers, agent },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on('error', () => {
      stats.upstreamFailures += 1;
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(502).end();
    });
    outgoing.on('close', () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });
    incoming.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The Cosmos proxy has no address');

  return {
    port: address.port,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        agent.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
