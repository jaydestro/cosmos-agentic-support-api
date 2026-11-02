import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { dockerCheck, GITLEAKS } from '../support/safety.ts';
import { ROOT } from '../support/stack.ts';

it('allows only documented synthetic values and rejects a generated credential-shaped probe', { timeout: 240_000 }, async () => {
  const args = ['dir', '--config', '/repo/.gitleaks.toml', '--redact=100', '--no-banner'];
  assert.equal(await dockerCheck(GITLEAKS, [...args, '/repo/tests/integration/foundation.test.ts']), 0);
  const directory = join(ROOT, '.artifacts', 'scanner-probe');
  await mkdir(directory, { recursive: true });
  const probe = join(directory, 'probe.txt');
  try {
    await writeFile(probe, `github_token = "${['gh', 'p_'].join('')}${randomBytes(18).toString('hex')}"\n`);
    assert.equal(await dockerCheck(GITLEAKS, [...args, '/repo/.artifacts/scanner-probe']), 1);
  } finally {
    await rm(probe, { force: true });
  }
});

it('the CLI history exception matches only its exact synthetic key and fixture path', { timeout: 240_000 }, async () => {
  const args = ['dir', '--config', '/repo/.gitleaks.toml', '--redact=100', '--no-banner'];
  const directory = join(ROOT, '.artifacts', 'cli-scanner-probe');
  const fixture = join(directory, 'tests', 'demo', 'fixtures.ts');
  const other = join(directory, 'unrelated.ts');
  const marker = ['fictional', 'duplicate', 'key', '001'].join('-');
  await mkdir(join(directory, 'tests', 'demo'), { recursive: true });
  try {
    await writeFile(fixture, `export const KEY = '${marker}';\n`);
    assert.equal(await dockerCheck(GITLEAKS, [...args, '/repo/.artifacts/cli-scanner-probe/tests/demo/fixtures.ts']), 0);
    await writeFile(other, `export const KEY = '${marker}';\n`);
    assert.equal(await dockerCheck(GITLEAKS, [...args, '/repo/.artifacts/cli-scanner-probe/unrelated.ts']), 1);
    await writeFile(fixture, `github_token = "${['gh', 'p_'].join('')}${randomBytes(18).toString('hex')}"\n`);
    assert.equal(await dockerCheck(GITLEAKS, [...args, '/repo/.artifacts/cli-scanner-probe/tests/demo/fixtures.ts']), 1);
  } finally {
    await rm(fixture, { force: true });
    await rm(other, { force: true });
  }
});
