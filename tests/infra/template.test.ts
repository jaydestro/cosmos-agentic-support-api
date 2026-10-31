import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, it } from 'node:test';
import { parse } from 'yaml';

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

let template: Record<string, unknown>;
let resources: Record<string, unknown>[];
before(async () => {
  template = record(JSON.parse(await readFile(new URL('../../infra/main.json', import.meta.url), 'utf8')));
  const items = template['resources'];
  assert.ok(Array.isArray(items));
  resources = (items as unknown[]).map(record);
});

function resource(type: string): Record<string, unknown> {
  const matches = resources.filter((entry) => entry['type'] === type);
  assert.equal(matches.length, 1, `one ${type} resource declaration`);
  const first = matches[0];
  assert.ok(first);
  return first;
}

it('declares single-region serverless Cosmos DB with no throughput at any scope and private-only data access', () => {
  const properties = record(resource('Microsoft.DocumentDB/databaseAccounts')['properties']);
  assert.deepEqual(properties['capabilities'], [{ name: 'EnableServerless' }]);
  assert.ok(Array.isArray(properties['locations']));
  assert.equal(properties['locations'].length, 1);
  assert.equal(properties['publicNetworkAccess'], 'Disabled');
  assert.equal(properties['disableLocalAuth'], true);
  assert.doesNotMatch(JSON.stringify(template), /"(throughput|autoscaleSettings)"\s*:/);
  assert.equal(resource('Microsoft.Network/privateDnsZones')['name'], 'privatelink.documents.azure.com');
  assert.ok(resource('Microsoft.Network/privateEndpoints'));
});

it('keeps Flex ingress public HTTPS, Node 24, outbound VNet integration and no always-ready instances', () => {
  const plan = resource('Microsoft.Web/serverfarms');
  assert.deepEqual(plan['sku'], { name: 'FC1', tier: 'FlexConsumption' });
  assert.equal(record(plan['properties'])['reserved'], true);
  const app = resource('Microsoft.Web/sites');
  const properties = record(app['properties']);
  assert.equal(app['kind'], 'functionapp,linux');
  assert.equal(properties['httpsOnly'], true);
  assert.equal(properties['publicNetworkAccess'], 'Enabled');
  assert.ok(properties['virtualNetworkSubnetId']);
  const config = record(properties['functionAppConfig']);
  assert.deepEqual(config['runtime'], { name: 'node', version: '24' });
  assert.deepEqual(record(config['scaleAndConcurrency'])['alwaysReady'], []);
  assert.equal(record(config['scaleAndConcurrency'])['maximumInstanceCount'], 40);
  assert.match(JSON.stringify(resource('Microsoft.Network/virtualNetworks')), /Microsoft\.App\/environments/);
});

it('uses separate application and seed identities, container-scoped data roles and identity-only host storage', () => {
  assert.equal(resources.filter((entry) => entry['type'] === 'Microsoft.ManagedIdentity/userAssignedIdentities').length, 2);
  const assignments = resource('Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments');
  assert.match(JSON.stringify(assignments), /\/dbs\//);
  assert.match(JSON.stringify(assignments), /\/colls\//);
  const storage = record(resource('Microsoft.Storage/storageAccounts')['properties']);
  assert.equal(storage['allowSharedKeyAccess'], false);
  assert.equal(storage['allowBlobPublicAccess'], false);
  assert.match(JSON.stringify(record(template['variables'])['roles']), /changeFeed/);
  assert.equal(record(record(template['parameters'])['liveModelApproved'])['defaultValue'], false);
  assert.ok(!('defaultValue' in record(record(template['parameters'])['location'])), 'no silently chosen deployment region');
});

it('the paid workflow is manual, main-only, OIDC-only and requires protected approval after preview', async () => {
  const workflow = record(parse(await readFile(new URL('../../.github/workflows/azure-proof.yml', import.meta.url), 'utf8')));
  assert.deepEqual(Object.keys(record(workflow['on'])), ['workflow_dispatch']);
  const jobs = record(workflow['jobs']);
  assert.match(String(record(jobs['preview'])['if']), /refs\/heads\/main/);
  assert.match(String(record(jobs['preview'])['if']), /approve_paid_limits/);
  assert.equal(record(jobs['deploy'])['needs'], 'preview');
  assert.equal(record(jobs['deploy'])['environment'], 'azure-demo');
  assert.match(JSON.stringify(jobs), /prevent_self_review/);
  assert.doesNotMatch(JSON.stringify(jobs), /client-secret|publish-profile/);
});
