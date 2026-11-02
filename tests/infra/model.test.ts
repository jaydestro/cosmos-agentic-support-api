import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const template = record(JSON.parse(await readFile(new URL('../../infra/model.json', import.meta.url), 'utf8')) as unknown);
const resources = template['resources'];
assert.ok(Array.isArray(resources));

it('the live model is a pinned, on-demand deployment with local authentication disabled', () => {
  const entries: unknown[] = resources;
  const account = entries.map(record).find((entry) => entry['type'] === 'Microsoft.CognitiveServices/accounts');
  const deployment = entries.map(record).find((entry) => entry['type'] === 'Microsoft.CognitiveServices/accounts/deployments');
  assert.ok(account && deployment);
  assert.equal(record(account['properties'])['disableLocalAuth'], true);
  assert.deepEqual(record(deployment['sku']), { name: 'Standard', capacity: 10 });
  const properties = record(deployment['properties']);
  assert.deepEqual(properties['model'], { format: 'OpenAI', name: 'gpt-4.1-mini', version: '2025-04-14' });
  assert.equal(properties['versionUpgradeOption'], 'NoAutoUpgrade');
  assert.equal(properties['raiPolicyName'], 'Microsoft.DefaultV2');
  assert.equal(record(record(template['parameters'])['namePrefix'])['defaultValue'], 'resolve-demo');
  assert.doesNotMatch(JSON.stringify(template), /listKeys|apiKey|ProvisionedManaged/);
});

it('the access bootstrap keeps model access opt-in and restricted to the application principal', async () => {
  const access = record(JSON.parse(await readFile(new URL('../../infra/deployment-access.json', import.meta.url), 'utf8')) as unknown);
  assert.equal(record(record(access['parameters'])['enableLiveModel'])['defaultValue'], false);
  const variables = record(access['variables']);
  assert.equal(variables['openAiUser'], '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd');
  assert.match(String(variables['allowedRoleIds']), /enableLiveModel/);
  assert.match(JSON.stringify(access['resources']), /__APP_PRINCIPAL_ID__/);
  assert.doesNotMatch(JSON.stringify(access['resources']), /elevateAccess|Owner|User Access Administrator/);
});
