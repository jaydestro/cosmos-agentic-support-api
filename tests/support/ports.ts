import { createServer, type Server } from 'node:net';

/** Reserves `count` distinct free loopback ports. All listeners are released together, so the ports are only briefly unreserved. */
export async function reservePorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    const ports: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Could not reserve a loopback port');
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}
