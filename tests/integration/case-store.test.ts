import type { CosmosClient } from '@azure/cosmos';
import { after, before } from 'node:test';
import { createCaseStore } from '../../src/cases/store.ts';
import { createOutboxStore } from '../../src/outbox/store.ts';
import { defineCaseStoreConformance, type CaseStoreTarget } from '../support/case-store-conformance.ts';
import { openEmulator, readStackConnection } from '../support/env.ts';

let cosmos: CosmosClient;
let target: CaseStoreTarget;

before(() => {
  const stack = readStackConnection();
  cosmos = openEmulator(stack);
  const cases = cosmos.database(stack.database).container('cases');
  target = { store: createCaseStore(cases), outbox: createOutboxStore(cases) };
});

after(() => {
  cosmos.dispose();
});

defineCaseStoreConformance('Cosmos DB emulator', () => target);
