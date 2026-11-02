import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { parse } from 'yaml';

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const root = new URL('../../', import.meta.url);
const workflow = record(parse(await readFile(new URL('.github/workflows/api-cd.yml', root), 'utf8')));
const job = record(record(workflow['jobs'])['deploy']);
const stepsInput: unknown = job['steps'];
assert.ok(Array.isArray(stepsInput));
const steps = (stepsInput as unknown[]).map(record);
function step(id: string): Record<string, unknown> {
  const found = steps.find((entry) => entry['id'] === id);
  assert.ok(found, `step ${id} exists`);
  return found;
}

const sha = 'a'.repeat(40);
const guid = '11111111-1111-1111-1111-111111111111';
const repository = 'jaydestro/cosmos-agentic-support-api';
const environment = {
  can_admins_bypass: false,
  protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 1 } }] }],
};
const run = {
  path: '.github/workflows/checks.yml', event: 'push', status: 'completed', conclusion: 'success',
  head_branch: 'main', head_repository: { full_name: repository }, head_sha: sha, run_attempt: 1,
};
const app = {
  id: `/subscriptions/${guid}/resourceGroups/resolve-demo/providers/Microsoft.Web/sites/resolve-api`,
  kind: 'functionapp,linux',
  properties: {
    reserved: true, httpsOnly: true, publicNetworkAccess: 'Enabled',
    functionAppConfig: { runtime: { name: 'node', version: '24' }, scaleAndConcurrency: { alwaysReady: [] } },
    serverFarmId: `/subscriptions/${guid}/resourceGroups/resolve-demo/providers/Microsoft.Web/serverfarms/resolve-plan`,
    defaultHostName: 'resolve-api-abc.eastus-01.azurewebsites.net',
  },
};
const plan = { sku: { name: 'FC1', tier: 'FlexConsumption' }, properties: { reserved: true } };
const linuxShell = { skip: process.platform !== 'linux' };

async function execute(id: string, options: {
  env?: Record<string, string>;
  environment?: unknown;
  run?: unknown;
  app?: unknown;
  plan?: unknown;
  latestSha?: string;
} = {}): Promise<{ status: number | null; output: string; summary: string; githubOutput: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'resolve-cd-'));
  try {
    const fixtures = {
      environment: options.environment ?? environment, run: options.run ?? run,
      app: options.app ?? app, plan: options.plan ?? plan,
      latest: { object: { sha: options.latestSha ?? sha } },
    };
    for (const [name, value] of Object.entries(fixtures)) {
      await writeFile(join(directory, `${name}.json`), JSON.stringify(value));
    }
    const scripts = {
      gh: `#!/bin/bash
set -euo pipefail
case "$*" in
  *environments/azure-api-cd) cat "$RUNNER_TEMP/environment.json";;
  *actions/runs/123) cat "$RUNNER_TEMP/run.json";;
  *git/ref/heads/main*) node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.RUNNER_TEMP+"/latest.json")).object.sha)';;
  *) exit 99;;
esac
`,
      az: `#!/bin/bash
set -euo pipefail
case "$*" in
  "account show --query id -o tsv") echo "$ACCOUNT_ID";;
  "rest --method get --url https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/resolve-demo/providers/Microsoft.Web/sites/resolve-api?api-version=2024-11-01 -o json") cat "$RUNNER_TEMP/app.json";;
  "rest --method get --url https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/resolve-demo/providers/Microsoft.Web/serverfarms/resolve-plan?api-version=2024-11-01 -o json") cat "$RUNNER_TEMP/plan.json";;
  *) exit 99;;
esac
`,
      curl: `#!/bin/bash
set -euo pipefail
output=""
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2;;
    --proto) [[ "$2" == '=https' ]]; shift 2;;
    --write-out|--connect-timeout|--max-time) shift 2;;
    --silent|--show-error) shift;;
    https://*.azurewebsites.net/*) url="$1"; shift;;
    *) exit 99;;
  esac
done
case "$url" in
  */api/health) printf '%s' "$HEALTH_BODY" > "$output"; printf '%s' "$HEALTH_CODE";;
  */api/ready) printf '%s' "$READY_BODY" > "$output"; printf '%s' "$READY_CODE";;
  */api/cases) printf '%s' "$CASES_CODE";;
  *) exit 99;;
esac
exit "\${CURL_EXIT:-0}"
`,
      sleep: '#!/bin/bash\nexit 0\n',
    };
    for (const [name, content] of Object.entries(scripts)) {
      await writeFile(join(directory, name), content, { mode: 0o700 });
    }
    const summaryPath = join(directory, 'summary');
    const outputPath = join(directory, 'output');
    await writeFile(summaryPath, '');
    await writeFile(outputPath, '');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', String(step(id)['run'])], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env, PATH: `${directory}:${process.env['PATH'] ?? ''}`,
        RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: repository, CI_RUN_ID: '123', CI_RUN_ATTEMPT: '1', CI_SHA: sha,
        RESOURCE_GROUP: 'resolve-demo', APP_NAME: 'resolve-api',
        CLIENT_ID: guid, TENANT_ID: guid, SUBSCRIPTION_ID: guid, ACCOUNT_ID: guid,
        BASE_URL: `https://${app.properties.defaultHostName}/api`,
        HEALTH_BODY: '{"status":"ok"}', READY_BODY: '{"status":"ok"}',
        HEALTH_CODE: '200', READY_CODE: '200', CASES_CODE: '401',
        ...options.env,
      },
    });
    assert.ifError(result.error);
    return {
      status: result.status, output: result.stdout + result.stderr,
      summary: await readFile(summaryPath, 'utf8'), githubOutput: await readFile(outputPath, 'utf8'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('automatically hands off only enabled successful same-repository main push CI to protected OIDC CD', () => {
  assert.deepEqual(workflow['on'], {
    workflow_run: { workflows: ['Resolve checks'], types: ['completed'], branches: ['main'] },
  });
  assert.equal(String(job['if']).replace(/\s+/g, ' ').trim(),
    "github.ref == 'refs/heads/main' && github.event.workflow_run.conclusion == 'success' && " +
    "github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main' && " +
    "github.event.workflow_run.head_repository.full_name == github.repository && vars.AZURE_API_CD_ENABLED == 'true'");
  assert.deepEqual(workflow['permissions'], { contents: 'read' });
  assert.deepEqual(job['permissions'], { contents: 'read', actions: 'read', 'id-token': 'write' });
  assert.equal(job['environment'], 'azure-api-cd');
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 20);
  assert.equal(step('smoke')['timeout-minutes'], 5);
  assert.equal(workflow['concurrency'], undefined);
  assert.deepEqual(job['concurrency'], { group: 'resolve-demo-deploy', 'cancel-in-progress': false, queue: 'max' });
  const download = steps.find((entry) => String(entry['uses']).startsWith('actions/download-artifact@'));
  assert.ok(download);
  assert.deepEqual(download['with'], {
    name: 'resolve-api-${{ env.CI_SHA }}-${{ env.CI_RUN_ATTEMPT }}', 'run-id': '${{ env.CI_RUN_ID }}',
    'github-token': '${{ github.token }}', repository: '${{ github.repository }}',
    path: '${{ runner.temp }}/resolve-artifact',
  });
  assert.ok(steps.indexOf(step('guard')) < steps.indexOf(download));
  const login = steps.find((entry) => String(entry['uses']).startsWith('azure/login@'));
  assert.ok(login);
  assert.deepEqual(login['with'], {
    'client-id': '${{ env.CLIENT_ID }}', 'tenant-id': '${{ env.TENANT_ID }}',
    'subscription-id': '${{ env.SUBSCRIPTION_ID }}',
  });
  assert.ok(steps.indexOf(step('target')) < steps.indexOf(step('deploy')));
  assert.equal(steps.indexOf(step('freshness')) + 1, steps.indexOf(step('deploy')));
  assert.equal(record(job['env'])['CLIENT_ID'], '${{ vars.AZURE_API_CD_CLIENT_ID }}');
  assert.deepEqual(step('deploy')['with'], {
    'app-name': '${{ env.APP_NAME }}', package: '${{ runner.temp }}/resolve-package',
    sku: 'flexconsumption', 'remote-build': false,
  });
  assert.doesNotMatch(JSON.stringify(workflow), /npm |checkout@|publish-profile|client-secret|secrets\.|listKeys|role assignment|deployment group create/i);
});

it('all executable workflow actions use the exact official reviewed full commit SHAs', async () => {
  const approved: Record<string, string> = {
    'actions/checkout': 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
    'actions/setup-node': 'a0853c24544627f65ddf259abe73b1d18a591444',
    'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
    'actions/download-artifact': '634f93cb2916e3fdff6788551b99b062d0335ce0',
    'azure/login': 'a641126d1b8aa4d1fa005f4f92df94a3a4c4c906',
    'Azure/functions-action': 'c5060b3b8bb1ebbcb531abd00c822ecbaa8ea656',
  };
  function check(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(check); return; }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uses') {
        assert.equal(typeof child, 'string');
        const [action, pin] = String(child).split('@');
        assert.ok(action && pin);
        assert.match(pin, /^[a-f0-9]{40}$/);
        assert.equal(pin, approved[action], `official reviewed pin for ${action}`);
      } else check(child);
    }
  }
  for (const name of ['checks.yml', 'azure-proof.yml', 'api-cd.yml']) {
    check(parse(await readFile(new URL(`.github/workflows/${name}`, root), 'utf8')));
  }
});

it('round-trips the main CI archive into CD without rebuilding or uploading diagnostics (Linux)', linuxShell, async () => {
  const ci = record(parse(await readFile(new URL('.github/workflows/checks.yml', root), 'utf8')));
  const ciSteps = record(record(ci['jobs'])['check'])['steps'] as unknown[];
  const archive = ciSteps.map(record).find((entry) => entry['name'] === 'Archive the checked production package');
  const unpack = steps.find((entry) => entry['name'] === 'Unpack without rebuilding');
  assert.ok(archive && unpack);
  assert.equal(archive['if'], "github.event_name == 'push' && github.ref == 'refs/heads/main'");
  const directory = await mkdtemp(join(tmpdir(), 'resolve-cd-package-'));
  try {
    const packagePath = join(directory, '.artifacts/package');
    await mkdir(join(packagePath, 'dist/src'), { recursive: true });
    await mkdir(join(packagePath, 'node_modules/.bin'), { recursive: true });
    await mkdir(join(directory, 'resolve-artifact'));
    await writeFile(join(packagePath, 'host.json'), '{"version":"2.0"}');
    await writeFile(join(packagePath, 'dist/src/index.js'), 'export {};');
    await writeFile(join(packagePath, 'node_modules/.bin/demo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(directory, '.artifacts/diagnostic.log'), 'not part of the deployment');
    const env = { ...process.env, RUNNER_TEMP: directory };
    const packed = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', String(archive['run'])], {
      cwd: directory, env, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(packed.status, 0, packed.stderr);
    await writeFile(join(directory, 'resolve-artifact/resolve-api.tgz'), await readFile(join(directory, 'resolve-api.tgz')));
    const unpacked = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', String(unpack['run'])], {
      cwd: directory, env, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(unpacked.status, 0, unpacked.stderr);
    assert.equal(await readFile(join(directory, 'resolve-package/dist/src/index.js'), 'utf8'), 'export {};');
    assert.equal((await stat(join(directory, 'resolve-package/node_modules/.bin/demo'))).mode & 0o777, 0o755);
    await assert.rejects(readFile(join(directory, 'resolve-package/diagnostic.log')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('executes CI provenance and approval guards, rejecting missing targets, missing approvals and non-main or unverified runs (Linux)', linuxShell, async () => {
  const good = await execute('guard');
  assert.equal(good.status, 0, good.output);
  assert.match(good.summary, /Build: passed main CI run 123 attempt 1/);
  for (const name of ['RESOURCE_GROUP', 'APP_NAME', 'CLIENT_ID', 'TENANT_ID', 'SUBSCRIPTION_ID']) {
    assert.notEqual((await execute('guard', { env: { [name]: '' } })).status, 0, `missing ${name}`);
  }
  const invalidInputs: Record<string, string>[] = [
    { RESOURCE_GROUP: '../other' }, { APP_NAME: 'https://other.example' }, { CLIENT_ID: 'not-a-guid' },
    { CI_RUN_ID: '../123' }, { CI_SHA: 'main' }, { CI_RUN_ATTEMPT: 'latest' },
  ];
  for (const env of invalidInputs) {
    assert.notEqual((await execute('guard', { env })).status, 0);
  }
  for (const invalid of [
    { ...environment, can_admins_bypass: true },
    { protection_rules: environment.protection_rules },
    { ...environment, protection_rules: [] },
    { ...environment, protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [1] }] },
    { ...environment, protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [] }] },
  ]) {
    assert.notEqual((await execute('guard', { environment: invalid })).status, 0);
  }
  for (const change of [
    { path: '.github/workflows/other.yml' }, { event: 'pull_request' }, { event: 'workflow_dispatch' },
    { status: 'in_progress' }, { conclusion: 'failure' }, { head_branch: 'feature' },
    { head_repository: { full_name: 'other/fork' } }, { head_sha: 'b'.repeat(40) }, { run_attempt: 2 },
  ]) {
    assert.notEqual((await execute('guard', { run: { ...run, ...change } })).status, 0, JSON.stringify(change));
  }
});

it('executes read-only target guards against actual ARM response envelopes (Linux)', linuxShell, async () => {
  const host = record(JSON.parse(await readFile(new URL('host.json', root), 'utf8')));
  assert.equal(record(record(host['extensions'])['http'])['routePrefix'], '');
  const good = await execute('target');
  assert.equal(good.status, 0, good.output);
  assert.equal(good.githubOutput, `base_url=https://${app.properties.defaultHostName}/api\n`);
  assert.notEqual((await execute('target', { env: { ACCOUNT_ID: 'other' } })).status, 0);
  for (const change of [
    { reserved: false },
    { httpsOnly: false }, { publicNetworkAccess: 'Disabled' }, { defaultHostName: 'attacker.example' },
    { functionAppConfig: { ...app.properties.functionAppConfig, runtime: { name: 'node', version: '22' } } },
    { functionAppConfig: { ...app.properties.functionAppConfig, scaleAndConcurrency: { alwaysReady: [{ name: 'http', instanceCount: 1 }] } } },
    { functionAppConfig: { ...app.properties.functionAppConfig, scaleAndConcurrency: {} } },
  ]) {
    assert.notEqual((await execute('target', { app: { ...app, properties: { ...app.properties, ...change } } })).status, 0, JSON.stringify(change));
  }
  assert.notEqual((await execute('target', { app: { ...app, id: `${app.id}-other` } })).status, 0);
  assert.notEqual((await execute('target', { app: { ...app, kind: 'functionapp' } })).status, 0);
  assert.notEqual((await execute('target', { plan: { ...plan, sku: { name: 'Y1', tier: 'Dynamic' } } })).status, 0);
});

it('executes bounded anonymous smoke at /api, requiring exact JSON and 401 (Linux)', linuxShell, async () => {
  const good = await execute('smoke');
  assert.equal(good.status, 0, good.output);
  const invalidResponses: Record<string, string>[] = [
    { HEALTH_BODY: '{"status":"ok","extra":true}' }, { HEALTH_BODY: '{"status":"ok"}\n{"status":"ok"}' },
    { HEALTH_BODY: '<html>ok</html>' }, { HEALTH_CODE: '302' },
    { READY_BODY: '{"status":"unavailable"}' }, { READY_CODE: '503' },
    { CASES_CODE: '200' }, { CASES_CODE: '302' }, { CASES_CODE: '403' }, { CURL_EXIT: '7' },
  ];
  for (const env of invalidResponses) {
    assert.notEqual((await execute('smoke', { env })).status, 0, JSON.stringify(env));
  }
  const script = String(step('smoke')['run']);
  assert.match(script, /for attempt in \{1\.\.12\}/);
  assert.match(script, /--connect-timeout 5 --max-time 10/);
  assert.doesNotMatch(script, /--location|--insecure|Authorization|--retry/);
  const report = steps.find((entry) => entry['name'] === 'Report deployment and smoke separately');
  assert.ok(report);
  assert.equal(report['if'], 'always()');
  assert.match(String(report['run']), /Build provenance:.*\n.*Deploy:.*\n.*Unauthenticated HTTP smoke:/);
  assert.match(String(report['run']), /BLOCKED \/ not run here:/);
});

it('refuses an obsolete main revision immediately before deployment (Linux)', linuxShell, async () => {
  assert.equal((await execute('freshness')).status, 0);
  const stale = await execute('freshness', { latestSha: 'b'.repeat(40) });
  assert.notEqual(stale.status, 0);
  assert.match(stale.output, /no longer the current main revision/);
});

it('CD cannot mint provisioning identity tokens and critical jobs preserve their bounded pending queue', async () => {
  const publisher = await readFile(new URL('infra/api-publisher.bicep', root), 'utf8');
  assert.match(publisher, /environment:azure-api-cd/);
  assert.doesNotMatch(publisher, /environment:azure-demo|f58310d9|b24988ac|listKeys/);
  assert.match(publisher, /scope: app/);
  assert.match(publisher, /de139f84-1756-47ae-9be6-808fbbe84772/);
  const provisioning = record(parse(await readFile(new URL('.github/workflows/azure-proof.yml', root), 'utf8')));
  assert.equal(provisioning['concurrency'], undefined);
  for (const name of ['preview', 'deploy']) {
    assert.deepEqual(record(record(provisioning['jobs'])[name])['concurrency'],
      { group: 'resolve-demo-deploy', 'cancel-in-progress': false, queue: 'max' });
  }
});
