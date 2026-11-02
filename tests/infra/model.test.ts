import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { parse } from 'yaml';

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

it('the protected deployment carries the selected namespace and makes live inference opt-in', async () => {
  const workflow = record(parse(await readFile(new URL('../../.github/workflows/azure-proof.yml', import.meta.url), 'utf8')));
  const inputs = record(record(record(workflow['on'])['workflow_dispatch'])['inputs']);
  assert.equal(record(inputs['enable_live_model'])['default'], false);
  const jobs = record(workflow['jobs']);
  for (const name of ['preview', 'deploy']) {
    const job = record(jobs[name]);
    const env = record(job['env']);
    assert.equal(env['NAME_PREFIX'], '${{ vars.AZURE_NAME_PREFIX }}');
    assert.equal(env['ENABLE_LIVE_MODEL'], '${{ inputs.enable_live_model }}');
    const steps: unknown = job['steps'];
    assert.ok(Array.isArray(steps));
    const entries: unknown[] = steps;
    const scripts = entries.map(record).map((entry) => typeof entry['run'] === 'string' ? entry['run'] : '').join('\n');
    assert.ok(scripts.includes('namePrefix="$NAME_PREFIX"'));
    assert.ok(scripts.includes('infra/model.bicep'));
  }
  const deploySteps: unknown = record(jobs['deploy'])['steps'];
  assert.ok(Array.isArray(deploySteps));
  const entries: unknown[] = deploySteps;
  const provision = entries.map(record).find((entry) => entry['id'] === 'provision');
  assert.ok(provision);
  const script = String(provision['run']);
  assert.ok(script.includes('model_args=()'));
  assert.ok(script.includes('if [[ "$ENABLE_LIVE_MODEL" == true ]]'));
  assert.ok(script.includes('liveModelApproved=true'));
  assert.ok(script.includes('modelInputUsdPerMillionTokens=$MODEL_INPUT_PRICE'));
  assert.ok(script.includes('modelOutputUsdPerMillionTokens=$MODEL_OUTPUT_PRICE'));
  assert.ok(script.includes('date -d "$MODEL_PRICING_DATE"'));
});
