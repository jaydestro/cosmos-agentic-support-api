import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { parse, stringify } from 'yaml';
import { dockerCheck, OASDIFF } from '../support/safety.ts';
import { ROOT } from '../support/stack.ts';

it('the pinned API-diff tool passes identical contracts and rejects removal of an operation', { timeout: 240_000 }, async () => {
  assert.equal(await dockerCheck(OASDIFF, ['breaking', '/repo/contracts/openapi.yaml', '/repo/contracts/openapi.yaml', '--fail-on', 'WARN']), 0);
  const contract: unknown = parse(await readFile(join(ROOT, 'contracts', 'openapi.yaml'), 'utf8'));
  assert.ok(typeof contract === 'object' && contract !== null && 'paths' in contract);
  const paths = contract.paths;
  assert.ok(typeof paths === 'object' && paths !== null && '/cases' in paths);
  const cases = paths['/cases'];
  assert.ok(typeof cases === 'object' && cases !== null && 'post' in cases);
  delete cases.post;
  await mkdir(join(ROOT, '.artifacts', 'contract'), { recursive: true });
  await writeFile(join(ROOT, '.artifacts', 'contract', 'removed-operation.yaml'), stringify(contract));
  assert.equal(
    await dockerCheck(OASDIFF, ['breaking', '/repo/contracts/openapi.yaml', '/repo/.artifacts/contract/removed-operation.yaml', '--fail-on', 'WARN']),
    1,
  );
});
