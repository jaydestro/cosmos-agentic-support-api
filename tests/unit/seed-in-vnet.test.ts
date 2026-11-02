import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';

const scriptUrl = new URL('../../tools/azure/seed-in-vnet.ps1', import.meta.url);

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
