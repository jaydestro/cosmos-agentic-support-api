import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveOutputDir, stagePackage } from './stage.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true, allowPositionals: false });
const out = resolveOutputDir(root, values.out);
const result = await stagePackage(root, out);
console.log(`Staged ${result.out}`);
console.log(`  entries: ${result.entries.join(', ')}`);
console.log(`  size: ${(result.bytes / 1024 / 1024).toFixed(1)} MiB (production dependencies only)`);
