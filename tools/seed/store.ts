import type { Container } from '@azure/cosmos';
import { isStatus } from '../../src/data/errors.ts';
import { SEED_CONTAINER, SEED_PARTITION_KEY_PATH, SeedGuardError } from './guards.ts';
import type { SeedStore } from './seeder.ts';

/** Fixtures are tiny; the cap only guards the listing query. */
const LIST_CAP = 1000;

export function createCosmosSeedStore(container: Container): SeedStore {
  return {
    async create(doc) {
      try {
        await container.items.create(doc);
        return 'created';
      } catch (error) {
        if (isStatus(error, 409)) return 'exists';
        throw error;
      }
    },

    async read(tenantId, id) {
      try {
        const response = await container.item(id, tenantId).read<Record<string, unknown>>();
        return response.resource ?? null;
      } catch (error) {
        if (isStatus(error, 404)) return null;
        throw error;
      }
    },

    async listIds(tenantId, type) {
      const { resources } = await container.items
        .query<string>(
          {
            query: 'SELECT TOP @top VALUE c.id FROM c WHERE c.tenantId = @tenantId AND c.type = @type',
            parameters: [
              { name: '@top', value: LIST_CAP },
              { name: '@tenantId', value: tenantId },
              { name: '@type', value: type },
            ],
          },
          { partitionKey: tenantId },
        )
        .fetchAll();
      return resources;
    },
  };
}

/** Refuses to write into a container that is missing or does not have the expected partition key. */
export async function assertSeedContainer(container: Container): Promise<void> {
  const response = await container.read().catch((error: unknown) => {
    if (isStatus(error, 404)) return null;
    throw error;
  });
  const definition = response?.resource;
  if (definition === undefined) {
    throw new SeedGuardError('container_missing', `Container "${SEED_CONTAINER}" does not exist; provision it first.`);
  }
  const paths = definition.partitionKey?.paths ?? [];
  if (paths.length !== 1 || paths[0] !== SEED_PARTITION_KEY_PATH) {
    throw new SeedGuardError('container_shape_unexpected', `Container "${SEED_CONTAINER}" must be partitioned by ${SEED_PARTITION_KEY_PATH}.`);
  }
}
