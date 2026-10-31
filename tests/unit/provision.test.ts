import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { CONTAINER_NAMES } from '../../src/data/cosmos.ts';
import { containerDifferences, loadManifest, parseManifest, type ContainerSpec } from '../support/provision.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function validContainer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'reference',
    purpose: 'Seeded reference data.',
    partitionKey: { paths: ['/tenantId'], kind: 'Hash', version: 2 },
    defaultTtl: null,
    indexingPolicy: { indexingMode: 'consistent', automatic: true },
    ...overrides,
  };
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { database: 'resolve', containers: [validContainer()], ...overrides };
}

function rejection(value: unknown): string {
  try {
    parseManifest(value);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('expected the manifest to be rejected');
}

describe('the committed container manifest', () => {
  it('declares exactly the containers the application opens', async () => {
    const manifest = await loadManifest(ROOT);
    assert.deepEqual(manifest.containers.map((spec) => spec.name).sort(), Object.values(CONTAINER_NAMES).sort());
    assert.equal(manifest.database, 'resolve');
  });

  it('sets no throughput anywhere, which the serverless account requires', async () => {
    const text = JSON.stringify(await loadManifest(ROOT)).toLowerCase();
    for (const word of ['throughput', 'autoscale', 'autopilot']) assert.ok(!text.includes(word), word);
  });

  it('keeps the partitioning the data model depends on', async () => {
    const byName = new Map((await loadManifest(ROOT)).containers.map((spec) => [spec.name, spec]));
    assert.deepEqual(byName.get('reference')?.partitionKey, { paths: ['/tenantId'], kind: 'Hash', version: 2 });
    assert.deepEqual(byName.get('cases')?.partitionKey, { paths: ['/tenantId', '/caseId'], kind: 'MultiHash', version: 2 });
    assert.deepEqual(byName.get('provider')?.partitionKey, { paths: ['/tenantId'], kind: 'Hash', version: 2 });
    assert.deepEqual(byName.get('leases')?.partitionKey, { paths: ['/id'], kind: 'Hash', version: 2 });
  });

  it('turns time-to-live on for cases without a default expiry, so only items that opt in expire', async () => {
    const byName = new Map((await loadManifest(ROOT)).containers.map((spec) => [spec.name, spec]));
    assert.equal(byName.get('cases')?.defaultTtl, -1);
    assert.equal(byName.get('reference')?.defaultTtl, null);
  });
});

describe('parseManifest', () => {
  it('accepts a valid manifest and returns typed containers', () => {
    const manifest = parseManifest(validManifest());
    assert.equal(manifest.database, 'resolve');
    assert.equal(manifest.containers[0]?.name, 'reference');
    assert.equal(manifest.containers[0]?.defaultTtl, null);
  });

  it('rejects anything that is not an object', () => {
    for (const value of [null, [], 'text', 3]) assert.match(rejection(value), /must be an object/);
  });

  it('rejects throughput wherever it appears, naming the offending path', () => {
    const atDatabase = rejection(validManifest({ throughput: 400 }));
    assert.match(atDatabase, /\$\.throughput sets throughput; the account is serverless/);
    const atContainer = rejection(validManifest({ containers: [validContainer({ offerThroughput: 400 })] }));
    assert.match(atContainer, /containers\[0\]\.offerThroughput/);
    const nested = rejection(validManifest({ containers: [validContainer({ indexingPolicy: { autoscaleSettings: { maxThroughput: 4000 } } })] }));
    assert.match(nested, /autoscaleSettings/);
    assert.match(nested, /maxThroughput/);
    assert.match(rejection(validManifest({ containers: [validContainer({ autopilot: true })] })), /autopilot/);
  });

  it('rejects a missing or malformed database name and an empty container list', () => {
    assert.match(rejection(validManifest({ database: 'Resolve' })), /database must be a lowercase name/);
    assert.match(rejection(validManifest({ database: undefined })), /database must be a lowercase name/);
    assert.match(rejection(validManifest({ containers: [] })), /containers must be a non-empty array/);
    assert.match(rejection({ database: 'resolve' }), /containers must be a non-empty array/);
  });

  it('rejects bad names, duplicates and a missing purpose', () => {
    assert.match(rejection(validManifest({ containers: [validContainer({ name: 'Bad Name' })] })), /containers\[0\]\.name is invalid/);
    assert.match(rejection(validManifest({ containers: [validContainer(), validContainer()] })), /containers\[1\]\.name is a duplicate/);
    assert.match(rejection(validManifest({ containers: [validContainer({ purpose: '' })] })), /purpose is required/);
    assert.match(rejection(validManifest({ containers: ['reference'] })), /containers\[0\] must be an object/);
  });

  it('rejects partition keys that do not describe a usable key', () => {
    const key = (partitionKey: unknown) => rejection(validManifest({ containers: [validContainer({ partitionKey })] }));
    assert.match(key(undefined), /partitionKey is required/);
    assert.match(key({ paths: [], kind: 'Hash', version: 2 }), /paths is invalid/);
    assert.match(key({ paths: ['tenantId'], kind: 'Hash', version: 2 }), /paths is invalid/);
    assert.match(key({ paths: ['/a', '/b', '/c', '/d'], kind: 'MultiHash', version: 2 }), /paths is invalid/);
    assert.match(key({ paths: ['/tenantId'], kind: 'Range', version: 2 }), /kind must be Hash or MultiHash/);
    assert.match(key({ paths: ['/tenantId'], kind: 'MultiHash', version: 2 }), /kind does not match the number of paths/);
    assert.match(key({ paths: ['/tenantId', '/caseId'], kind: 'Hash', version: 2 }), /kind does not match the number of paths/);
    assert.match(key({ paths: ['/tenantId'], kind: 'Hash', version: 1 }), /version must be 2/);
  });

  it('accepts the documented time-to-live values and rejects the rest', () => {
    const ttl = (defaultTtl: unknown) => ({ ...validManifest({ containers: [validContainer({ defaultTtl })] }) });
    for (const value of [null, -1, 60]) assert.equal(parseManifest(ttl(value)).containers[0]?.defaultTtl, value);
    for (const value of [0, -2, 1.5, '60', undefined]) assert.match(rejection(ttl(value)), /defaultTtl must be null, -1 or a positive integer/);
  });

  it('requires an indexing policy object', () => {
    assert.match(rejection(validManifest({ containers: [validContainer({ indexingPolicy: undefined })] })), /indexingPolicy is required/);
    assert.match(rejection(validManifest({ containers: [validContainer({ indexingPolicy: [] })] })), /indexingPolicy is required/);
  });

  it('reports every problem at once, not just the first', () => {
    const message = rejection({ database: 'X', containers: [validContainer({ name: 'A', purpose: '' })] });
    assert.match(message, /database must be a lowercase name/);
    assert.match(message, /name is invalid/);
    assert.match(message, /purpose is required/);
  });
});

describe('containerDifferences', () => {
  const spec: ContainerSpec = {
    name: 'cases',
    purpose: 'test',
    partitionKey: { paths: ['/tenantId', '/caseId'], kind: 'MultiHash', version: 2 },
    defaultTtl: -1,
    indexingPolicy: {
      compositeIndexes: [[{ path: '/type', order: 'ascending' }, { path: '/seq', order: 'ascending' }]],
    },
  };
  const matching = {
    partitionKey: { paths: ['/tenantId', '/caseId'], kind: 'MultiHash', version: 2 },
    defaultTtl: -1,
    indexingPolicy: spec.indexingPolicy,
  };

  it('is empty when the stored container matches', () => {
    assert.deepEqual(containerDifferences(spec, matching), []);
  });

  it('names each way the stored container differs', () => {
    assert.match(containerDifferences(spec, { ...matching, partitionKey: { ...matching.partitionKey, paths: ['/tenantId'] } }).join(), /partition key paths/);
    assert.match(containerDifferences(spec, { ...matching, partitionKey: { ...matching.partitionKey, kind: 'Hash' } }).join(), /partition key kind is Hash/);
    assert.match(containerDifferences(spec, { ...matching, partitionKey: { ...matching.partitionKey, version: 1 } }).join(), /partition key version is 1/);
    assert.match(containerDifferences(spec, { ...matching, defaultTtl: undefined }).join(), /defaultTtl is undefined, expected -1/);
    assert.match(containerDifferences(spec, { ...matching, indexingPolicy: { compositeIndexes: [] } }).join(), /composite indexes differ/);
  });

  it('flags a stored partition key with no version, which Cosmos DB treats as version 1', () => {
    const unversioned = { paths: matching.partitionKey.paths, kind: matching.partitionKey.kind };
    assert.match(containerDifferences(spec, { ...matching, partitionKey: unversioned }).join(), /partition key version is undefined, expected 2/);
  });

  it('expects no time-to-live when the manifest has none', () => {
    const plain: ContainerSpec = { ...spec, defaultTtl: null };
    assert.deepEqual(containerDifferences(plain, { ...matching, defaultTtl: undefined }), []);
    assert.match(containerDifferences(plain, matching).join(), /defaultTtl is -1, expected undefined/);
  });
});
