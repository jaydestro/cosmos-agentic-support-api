import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const root = resolve(import.meta.dirname, '..', '..');
const source = resolve(root, 'contracts', 'openapi.yaml');
const target = resolve(root, 'contracts', 'generated', 'openapi.d.ts');

const normalize = (text: string): string => text.replace(/\r\n/g, '\n');

const ast = await openapiTS(pathToFileURL(source));
const generated = normalize(astToString(ast));

if (process.argv.includes('--check')) {
  const current = normalize(await readFile(target, 'utf8').catch(() => ''));
  if (current !== generated) {
    console.error('contracts/generated/openapi.d.ts is out of date. Run: npm run contract:generate');
    process.exitCode = 1;
  } else {
    console.log('contracts/generated/openapi.d.ts is up to date');
  }
} else {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, generated);
  console.log('wrote contracts/generated/openapi.d.ts');
}
