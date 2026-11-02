import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { it } from 'node:test';

const scriptUrl = new URL('../../tools/azure/seed-in-vnet.ps1', import.meta.url);
const execute = promisify(execFile);
const groupId = '/subscriptions/sub-one/resourceGroups/resolve-test';
const subnetId = `${groupId}/providers/Microsoft.Network/virtualNetworks/seed-vnet/subnets/seed-runner`;
const sourceCommit = 'a'.repeat(40);

async function runFake(scenario = 'success', overrides: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'resolve-seed-test-'));
  const trace = join(directory, 'trace');
  try {
    const az = join(directory, 'az');
    await copyFile(new URL('../support/seed-az.mjs', import.meta.url), az);
    await chmod(az, 0o700);
    const parameters = {
      ResourceGroup: 'resolve-test', AccountName: 'resolve-demo-y4chtkiyxiv4k',
      SubnetId: subnetId, SeedIdentityName: 'resolve-demo-seed-y4chtkiyxiv4k',
      SourceCommit: sourceCommit, WaitTimeoutMinutes: '1', ...overrides,
    };
    let stdout = '';
    let stderr = '';
    let failed = false;
    try {
      ({ stdout, stderr } = await execute('pwsh', [
        '-NoLogo', '-NoProfile', '-File', fileURLToPath(scriptUrl),
        ...Object.entries(parameters).flatMap(([key, value]) => [`-${key}`, value]),
      ], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, SEED_AZ_SCENARIO: scenario, SEED_AZ_TRACE: trace },
        timeout: 80_000,
      }));
    } catch (error) {
      if (!(error instanceof Error) || !('stderr' in error) || !('stdout' in error)) throw error;
      stderr = String(error.stderr);
      stdout = String(error.stdout);
      failed = true;
    }
    const calls = await readFile(trace, 'utf8').then(
      (text) => text.trim().split('\n').map((line) => JSON.parse(line) as string[]),
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    if (scenario.endsWith('-hang')) {
      const pid = Number(await readFile(`${trace}.pid`, 'utf8'));
      // Linux may retain an already-killed orphan as a zombie until init reaps it.
      const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      assert.ok(status === '' || status.split(' ')[2] === 'Z', 'the native child process must also be killed');
    }
    return { stdout, stderr, failed, calls };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('requires an immutable source commit and uses the pinned official Node 24 image', async () => {
  const script = await readFile(scriptUrl, 'utf8');

  assert.match(script, /\[Parameter\(Mandatory\)\]\s+\[ValidatePattern\('\^\[0-9a-fA-F\]\{40\}\$'\)\]\s+\[string\]\s+\$SourceCommit/);
  assert.match(script, /github\.com\/jaydestro\/cosmos-agentic-support-api\/archive\/\$SourceCommit\.tar\.gz/);
  assert.match(script, /node:24\.14\.0-bookworm-slim@sha256:[0-9a-f]{64}/);
  assert.match(script, /npm ci --omit=dev --ignore-scripts/);
  assert.doesNotMatch(script, /archive\/(?:HEAD|main|master|latest)/i);
});

it('validates private serverless Cosmos, delegated subnet, and only the seed identity', async () => {
  const script = await readFile(scriptUrl, 'utf8');

  assert.match(script, /'EnableServerless' -notin \$accountCapabilities/);
  assert.match(script, /\$account\.publicNetworkAccess -cne 'Disabled'/);
  assert.match(script, /Microsoft\.ContainerInstance\/containerGroups/);
  assert.match(script, /'--assign-identity', \[string\]\$identity\.id/);
  assert.match(script, /\$attachedIdentityMap\.type -cne 'UserAssigned'/);
  assert.match(script, /\$attachedIdentityIds\.Count -ne 1/);
  assert.doesNotMatch(script, /az\s+storage|COSMOS_KEY|--azure-file-volume|--publish-profile/i);
  for (const template of ['main.bicep', 'identities.bicep']) {
    const bicep = await readFile(new URL(`../../infra/${template}`, import.meta.url), 'utf8');
    assert.match(bicep, /resource seedIdentity [\s\S]*?tags: \{ project: 'resolve', purpose: 'reference-seeding' \}/);
  }
});

it('runs the guarded seeder twice, bounds work, tags ownership, and deletes only its exact container', async () => {
  const script = await readFile(scriptUrl, 'utf8');

  assert.equal((script.match(/node tools\/seed\/main\.ts --target cloud --confirm-account/g) ?? []).length, 2);
  assert.match(script, /\$containerCommand = "sh -c 'printf %s \$encodedRunnerCommand \| base64 -d \| sh'"/);
  assert.match(script, /timeout --kill-after=15s/);
  assert.match(script, /\[ValidateRange\(1, 60\)\]/);
  assert.match(script, /"runId=\$RunId"/);
  assert.match(script, /--name', \$ContainerName/);
  assert.match(script, /'container', 'delete', '--resource-group', \$ResourceGroup, '--name', \$ContainerName/);
  assert.match(script, /exit \$RunnerExitCode/);
});

it('executes the real deployment namespace with a full subnet ID, only seed identity, and owned cleanup', async () => {
  const result = await runFake();
  assert.equal(result.failed, false, result.stderr);
  assert.match(result.stdout, /read-back complete/);
  const create = result.calls.find((args) => args[1] === 'create');
  assert.ok(create);
  assert.equal(create[create.indexOf('--subnet') + 1], subnetId);
  assert.ok(create.includes('--no-wait'));
  assert.ok(!create.includes('--vnet'));
  assert.deepEqual(create.slice(create.indexOf('--assign-identity') + 1, create.indexOf('--tags')), [
    `${groupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/resolve-demo-seed-y4chtkiyxiv4k`,
  ]);
  const name = create[create.indexOf('--name') + 1];
  const cleanup = result.calls.find((args) => args[1] === 'delete');
  assert.ok(cleanup);
  assert.equal(cleanup[cleanup.indexOf('--name') + 1], name);
});

for (const name of ['-resolve-demo', 'resolve-demo-', 're', 'resolve_demo', 'a'.repeat(45)]) {
  it(`rejects invalid Cosmos account name ${name}`, async () => {
    const result = await runFake('success', { AccountName: name });
    assert.equal(result.failed, true);
    assert.equal(result.calls.length, 0);
  });
}

for (const [label, overrides] of [
  ['different subscription', { SubnetId: subnetId.replace('sub-one', 'sub-two') }],
  ['different group', { SubnetId: subnetId.replace('resolve-test', 'other-group') }],
  ...['app', 'publish', 'deploy'].map((role) => [role, { SeedIdentityName: `resolve-demo-${role}-y4chtkiyxiv4k` }] as const),
] as const) {
  it(`rejects ${label} before container creation`, async () => {
    const result = await runFake('success', overrides);
    assert.equal(result.failed, true, result.stdout);
    assert.match(result.stderr, label.startsWith('different') ? /subscription/ : /dedicated seed identity/);
    assert.ok(!result.calls.some((args) => args[0] === 'container'));
  });
}

for (const scenario of ['wrong-tags', 'missing-grant', 'broad-scope', 'broad-role', 'extra-grant', 'public', 'multi-region', 'provisioned', 'subnet-mismatch', 'no-delegation']) {
  it(`rejects ${scenario} before container creation`, async () => {
    const result = await runFake(scenario);
    assert.equal(result.failed, true, result.stdout);
    const reason = scenario === 'wrong-tags' ? /dedicated seed identity/
      : ['public', 'multi-region', 'provisioned'].includes(scenario) ? /serverless account/
        : ['subnet-mismatch', 'no-delegation'].includes(scenario) ? /not delegated/ : /reference-seeder/;
    assert.match(result.stderr, reason);
    assert.ok(!result.calls.some((args) => args[0] === 'container'));
  });
}

for (const scenario of ['create-failure', 'delayed-create', 'extra-identity', 'seed-failure', 'seed-failure-logs']) {
  it(`cleans up the exact owned container after ${scenario}`, async () => {
    const result = await runFake(scenario);
    assert.equal(result.failed, true);
    assert.ok(result.calls.some((args) => args[1] === 'delete'));
    if (scenario === 'create-failure') assert.match(result.stderr, /original create error/);
    if (scenario === 'seed-failure') assert.match(result.stderr, /exited with code 7/);
    if (scenario === 'seed-failure-logs') {
      assert.match(result.stderr, /exited with code 7/);
      assert.match(result.stderr, /log retrieval failed/);
    }
    if (scenario === 'delayed-create') assert.equal(result.calls.filter((args) => args.includes('tags')).length, 2);
  });
}

for (const scenario of ['not-found', 'foreign-tags', 'foreign-source', 'foreign-manager', 'lookup-failure', 'cleanup-failure', 'delete-failure', 'seed-failure-cleanup']) {
  it(`handles ${scenario} without hiding errors or deleting unrelated resources`, async () => {
    const result = await runFake(scenario);
    assert.equal(result.failed, true);
    const deletions = result.calls.filter((args) => args[1] === 'delete');
    assert.equal(deletions.length, ['cleanup-failure', 'delete-failure', 'seed-failure-cleanup'].includes(scenario) ? 1 : 0);
    if (scenario === 'seed-failure-cleanup') assert.match(result.stderr, /exited with code 7/);
    else if (!['delete-failure', 'foreign-source', 'foreign-manager'].includes(scenario)) assert.match(result.stderr, /original create error/);
    assert.match(result.stderr, /Cleanup failed/);
    if (scenario === 'not-found') assert.match(result.stderr, /delayed creation/);
  });
}

it('waits through asynchronous provisioning before reading the completed seed result', async () => {
  const result = await runFake('provisioning');
  assert.equal(result.failed, false, result.stderr);
  assert.equal(result.calls.filter((args) => args.includes('containers[0].instanceView.currentState')).length, 2);
});

for (const scenario of ['create-hang', 'show-hang']) {
  it(`kills a stalled ${scenario} process tree and still cleans up`, { timeout: 85_000 }, async () => {
    const started = Date.now();
    const result = await runFake(scenario);
    assert.equal(result.failed, true);
    assert.match(result.stderr, /process deadline/);
    assert.ok(Date.now() - started < 75_000);
    assert.ok(result.calls.some((args) => args[1] === 'delete'));
  });
}
