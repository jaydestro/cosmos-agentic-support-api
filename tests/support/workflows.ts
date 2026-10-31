import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './process.ts';
import { ROOT } from './stack.ts';

const FILES = [
  '.github/workflows/contract-cosmos-review.lock.yml',
  '.github/workflows/docs-maintainer.lock.yml',
  '.github/aw/actions-lock.json',
  '.gitattributes',
];

async function hashes(): Promise<string[]> {
  return Promise.all(FILES.map(async (path) => createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex')));
}

const version = await run('gh', ['aw', 'version']);
if (version.code !== 0 || !/\bv1\.0\.1\b/.test(version.stdout)) {
  throw new Error('GitHub Agentic Workflows v1.0.1 is required. Install the pinned extension; do not hand-edit locks.');
}
const original = await hashes();
const compiled = await run('gh', ['aw', 'compile', 'contract-cosmos-review', 'docs-maintainer', '--validate'], { cwd: ROOT, timeoutMs: 180_000 });
process.stdout.write(compiled.stdout);
process.stderr.write(compiled.stderr);
if (compiled.code !== 0) throw new Error('Agentic workflow compilation/validation failed.');
const current = await hashes();
if (original.some((hash, index) => hash !== current[index])) {
  throw new Error('Generated workflow locks drifted. Review the compiler output and persist it using npm run workflows:compile.');
}
process.stdout.write('Generated workflow locks match compiler v1.0.1.\n');
