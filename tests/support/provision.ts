import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CosmosClient, PartitionKeyKind, type ContainerRequest, type IndexingPolicy } from '@azure/cosmos';
import { isTransientDependencyError } from '../../src/data/errors.ts';

export type PartitionKind = keyof typeof PartitionKeyKind;

export interface ContainerSpec {
  name: string;
  purpose: string;
  partitionKey: { paths: string[]; kind: PartitionKind; version: 2 };
  /** `null` leaves time-to-live off; -1 turns it on without a default expiry (items opt in). */
  defaultTtl: number | null;
  indexingPolicy: IndexingPolicy;
}

export interface ContainerManifest {
  database: string;
  containers: ContainerSpec[];
}

/** Any of these anywhere in the manifest would provision throughput, which the serverless account rejects. */
const THROUGHPUT_KEYS = new Set(['throughput', 'offerthroughput', 'maxthroughput', 'autoscalesettings', 'autopilot']);
const NAME = /^[a-z][a-z0-9_-]{1,62}$/;
const PATH = /^\/(?:[A-Za-z_][A-Za-z0-9_]*|"[^"/]+")$/;

function findThroughputKeys(value: unknown, trail: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findThroughputKeys(item, `${trail}[${String(index)}]`, found);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (THROUGHPUT_KEYS.has(key.toLowerCase())) found.push(`${trail}.${key}`);
      findThroughputKeys(child, `${trail}.${key}`, found);
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates the manifest strictly so that a typo cannot silently provision something else. */
export function parseManifest(value: unknown): ContainerManifest {
  const problems: string[] = [];
  if (!isRecord(value)) throw new Error('The container manifest must be an object.');
  findThroughputKeys(value, '$', problems);
  const throughput = problems.splice(0).map((where) => `${where} sets throughput; the account is serverless`);

  const database = value['database'];
  if (typeof database !== 'string' || !NAME.test(database)) problems.push('database must be a lowercase name');
  const raw = value['containers'];
  if (!Array.isArray(raw) || raw.length === 0) problems.push('containers must be a non-empty array');

  const containers: ContainerSpec[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (Array.isArray(raw) ? raw : []).entries()) {
    const where = `containers[${String(index)}]`;
    if (!isRecord(entry)) {
      problems.push(`${where} must be an object`);
      continue;
    }
    const { name, purpose, partitionKey, defaultTtl, indexingPolicy } = entry;
    if (typeof name !== 'string' || !NAME.test(name)) problems.push(`${where}.name is invalid`);
    else if (seen.has(name)) problems.push(`${where}.name is a duplicate`);
    else seen.add(name);
    if (typeof purpose !== 'string' || purpose.length === 0) problems.push(`${where}.purpose is required`);

    let key: ContainerSpec['partitionKey'] | undefined;
    if (isRecord(partitionKey)) {
      const { paths, kind, version } = partitionKey;
      const pathsOk = Array.isArray(paths) && paths.length >= 1 && paths.length <= 3 && paths.every((p) => typeof p === 'string' && PATH.test(p));
      const kindOk = kind === 'Hash' || kind === 'MultiHash';
      if (!pathsOk) problems.push(`${where}.partitionKey.paths is invalid`);
      else if (kindOk && (kind === 'Hash') !== (paths.length === 1)) problems.push(`${where}.partitionKey.kind does not match the number of paths`);
      if (!kindOk) problems.push(`${where}.partitionKey.kind must be Hash or MultiHash`);
      if (version !== 2) problems.push(`${where}.partitionKey.version must be 2`);
      if (pathsOk && kindOk && version === 2) key = { paths: paths as string[], kind, version };
    } else {
      problems.push(`${where}.partitionKey is required`);
    }

    if (defaultTtl !== null && !(typeof defaultTtl === 'number' && Number.isInteger(defaultTtl) && (defaultTtl === -1 || defaultTtl > 0))) {
      problems.push(`${where}.defaultTtl must be null, -1 or a positive integer`);
    }
    if (!isRecord(indexingPolicy)) problems.push(`${where}.indexingPolicy is required`);

    if (typeof name === 'string' && typeof purpose === 'string' && key !== undefined && isRecord(indexingPolicy) && (defaultTtl === null || typeof defaultTtl === 'number')) {
      containers.push({ name, purpose, partitionKey: key, defaultTtl, indexingPolicy });
    }
  }

  const all = [...throughput, ...problems];
  if (all.length > 0) throw new Error(`Invalid container manifest:\n- ${all.join('\n- ')}`);
  return { database: database as string, containers };
}

export async function loadManifest(root: string): Promise<ContainerManifest> {
  const text = await readFile(join(root, 'infra', 'containers.json'), 'utf8');
  return parseManifest(JSON.parse(text) as unknown);
}

export interface ProvisionedContainer {
  name: string;
  created: boolean;
}

export interface ProvisionResult {
  database: string;
  databaseCreated: boolean;
  containers: ProvisionedContainer[];
}

export interface ProvisionOptions {
  endpoint: string;
  key: string;
  manifest: ContainerManifest;
  /** Overrides the manifest database name, e.g. for a throwaway database. */
  database?: string;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(attempts: number, sleep: (ms: number) => Promise<void>, action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts || !isTransientDependencyError(error)) throw error;
      await sleep(Math.min(500 * 2 ** (attempt - 1), 4000));
    }
  }
}

/** Describes every way the stored container differs from the manifest; an empty list means it matches. */
export function containerDifferences(
  spec: ContainerSpec,
  stored: { partitionKey?: { paths?: string[]; kind?: string; version?: number }; defaultTtl?: number; indexingPolicy?: IndexingPolicy },
): string[] {
  const differences: string[] = [];
  const storedKey = stored.partitionKey;
  if (JSON.stringify(storedKey?.paths) !== JSON.stringify(spec.partitionKey.paths)) {
    differences.push(`partition key paths are ${JSON.stringify(storedKey?.paths)}, expected ${JSON.stringify(spec.partitionKey.paths)}`);
  }
  if (storedKey?.kind !== spec.partitionKey.kind) differences.push(`partition key kind is ${String(storedKey?.kind)}, expected ${spec.partitionKey.kind}`);
  if ((storedKey?.version ?? 1) !== spec.partitionKey.version) differences.push(`partition key version is ${String(storedKey?.version)}, expected ${String(spec.partitionKey.version)}`);
  const expectedTtl = spec.defaultTtl ?? undefined;
  if (stored.defaultTtl !== expectedTtl) differences.push(`defaultTtl is ${String(stored.defaultTtl)}, expected ${String(expectedTtl)}`);
  const storedComposite = JSON.stringify(stored.indexingPolicy?.compositeIndexes ?? []);
  const expectedComposite = JSON.stringify(spec.indexingPolicy.compositeIndexes ?? []);
  if (storedComposite !== expectedComposite) differences.push('composite indexes differ from the manifest');
  return differences;
}

/**
 * Creates the database and containers if they are missing and verifies them by reading them back.
 * It never sets throughput, never deletes anything and never alters an existing container.
 */
export async function provisionDatabase(options: ProvisionOptions): Promise<ProvisionResult> {
  const attempts = options.attempts ?? 6;
  const sleep = options.sleep ?? defaultSleep;
  const databaseName = options.database ?? options.manifest.database;
  const client = new CosmosClient({
    endpoint: options.endpoint,
    key: options.key,
    userAgentSuffix: 'resolve-provision',
    connectionPolicy: { requestTimeout: 15_000, enableEndpointDiscovery: false },
  });
  try {
    const created = await withRetry(attempts, sleep, () => client.databases.createIfNotExists({ id: databaseName }));
    const database = client.database(databaseName);
    const result: ProvisionResult = { database: databaseName, databaseCreated: created.statusCode === 201, containers: [] };

    for (const spec of options.manifest.containers) {
      const request: ContainerRequest = {
        id: spec.name,
        partitionKey: { paths: spec.partitionKey.paths, kind: PartitionKeyKind[spec.partitionKey.kind], version: spec.partitionKey.version },
        indexingPolicy: spec.indexingPolicy,
        ...(spec.defaultTtl === null ? {} : { defaultTtl: spec.defaultTtl }),
      };
      const response = await withRetry(attempts, sleep, () => database.containers.createIfNotExists(request));
      result.containers.push({ name: spec.name, created: response.statusCode === 201 });
    }

    for (const spec of options.manifest.containers) {
      const { resource } = await withRetry(attempts, sleep, () => database.container(spec.name).read());
      if (resource === undefined) throw new Error(`Container ${spec.name} was not readable after it was created.`);
      const differences = containerDifferences(spec, resource);
      if (differences.length > 0) throw new Error(`Container ${spec.name} does not match the manifest: ${differences.join('; ')}`);
    }
    return result;
  } finally {
    client.dispose();
  }
}
