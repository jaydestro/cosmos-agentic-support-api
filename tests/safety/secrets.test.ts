import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { dockerCheck, GITLEAKS } from '../support/safety.ts';
import { ROOT } from '../support/stack.ts';

it('allows only documented synthetic values and rejects a generated credential-shaped probe', { timeout: 240_000 }, async () => {
  const args = ['dir', '--config', '/repo/.gitleaks.toml', '--redact=100', '--no-banner'];
  assert.equal(await dockerCheck(GITLEAKS, [...args, '/repo/tests/integration/foundation.test.ts']), 0);
  const directory = join(ROOT, '.artifacts', 'scanner-probe');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'probe.txt'), `github_token = "${['gh', 'p_'].join('')}${randomBytes(18).toString('hex')}"\n`);
  assert.equal(await dockerCheck(GITLEAKS, [...args, '/repo/.artifacts/scanner-probe']), 1);
});
