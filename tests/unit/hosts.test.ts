import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cosmosAccountName,
  isCosmosAccountHostname,
  isLoopbackHostname,
} from '../../src/config/hosts.ts';

describe('isLoopbackHostname', () => {
  for (const hostname of ['127.0.0.1', 'localhost', '[::1]', '::1']) {
    it(`accepts ${hostname}`, () => {
      assert.equal(isLoopbackHostname(hostname), true);
    });
  }

  for (const hostname of [
    '',
    '0.0.0.0',
    '127.0.0.2',
    '10.0.0.4',
    'localhost.evil.example',
    'evil-localhost',
    'example.documents.azure.com',
    '[::2]',
  ]) {
    it(`rejects ${JSON.stringify(hostname)}`, () => {
      assert.equal(isLoopbackHostname(hostname), false);
    });
  }
});

describe('cosmosAccountName', () => {
  it('extracts the account name from public, US Government and China endpoints', () => {
    assert.equal(cosmosAccountName('resolve-demo.documents.azure.com'), 'resolve-demo');
    assert.equal(cosmosAccountName('resolve-demo.documents.azure.us'), 'resolve-demo');
    assert.equal(cosmosAccountName('resolve-demo.documents.azure.cn'), 'resolve-demo');
  });

  for (const hostname of [
    'documents.azure.com',
    'ab.documents.azure.com',
    'UPPER.documents.azure.com',
    'a.b.documents.azure.com',
    'resolve-demo.documents.azure.com.evil.example',
    'evil.example/resolve-demo.documents.azure.com',
    'resolve_demo.documents.azure.com',
    'resolve-demo.table.cosmos.azure.com',
    '127.0.0.1',
    '',
  ]) {
    it(`returns null for ${JSON.stringify(hostname)}`, () => {
      assert.equal(cosmosAccountName(hostname), null);
      assert.equal(isCosmosAccountHostname(hostname), false);
    });
  }

  it('agrees with isCosmosAccountHostname', () => {
    assert.equal(isCosmosAccountHostname('resolve-demo.documents.azure.com'), true);
  });
});
