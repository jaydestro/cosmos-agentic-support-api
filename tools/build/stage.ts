import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Written into every staged directory; a directory without it is never deleted. */
export const PACKAGE_MARKER = '.resolve-package';

/** Files and folders that make a runnable, deployable Functions app. Nothing else is staged. */
const STAGED_ENTRIES = ['host.json', 'package.json', 'package-lock.json', 'dist'] as const;
const STAGED_CONTRACT = join('contracts', 'openapi.yaml');

export function defaultPackageDir(root: string): string {
  return join(root, '.artifacts', 'package');
}

/** The output must be a subdirectory of `<root>/.artifacts`, so it is ignored by Git and can never be a source folder. */
export function resolveOutputDir(root: string, requested: string | undefined, cwd: string = process.cwd()): string {
  const out = requested === undefined ? defaultPackageDir(root) : resolve(cwd, requested);
  const artifacts = join(root, '.artifacts');
  const inside = relative(artifacts, out);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`The package directory must be a subdirectory of ${artifacts}`);
  }
  return out;
}

export async function prepareOutputDir(out: string): Promise<void> {
  if (existsSync(out)) {
    if (!existsSync(join(out, PACKAGE_MARKER))) {
      throw new Error(`Refusing to delete ${out}: it was not created by the package script (no ${PACKAGE_MARKER} marker)`);
    }
    await rm(out, { recursive: true, force: true });
  }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, PACKAGE_MARKER), 'Created by tools/build/package.ts. Safe to delete.\n');
}

/** npm is a script, not an executable, on some platforms; run its CLI entry with the current Node instead. */
export function npmCliPath(): string {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    process.env['npm_execpath'],
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.endsWith('npm-cli.js') && existsSync(candidate)) return candidate;
  }
  throw new Error('Could not locate npm-cli.js; run this through "npm run package"');
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return total;
}

export interface StageResult {
  out: string;
  entries: string[];
  bytes: number;
}

export async function stagePackage(root: string, out: string): Promise<StageResult> {
  for (const required of [join('dist', 'src', 'index.js'), join('dist', 'web', 'index.html')]) {
    if (!existsSync(join(root, required))) throw new Error(`${required} is missing; run "npm run build" first`);
  }

  await prepareOutputDir(out);
  for (const entry of STAGED_ENTRIES) await cp(join(root, entry), join(out, entry), { recursive: true });
  await mkdir(join(out, 'contracts'), { recursive: true });
  await cp(join(root, STAGED_CONTRACT), join(out, STAGED_CONTRACT));

  const install = spawnSync(
    process.execPath,
    [npmCliPath(), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: out, stdio: 'inherit' },
  );
  if (install.status !== 0) throw new Error('npm ci --omit=dev failed in the staged directory');

  const manifest = JSON.parse(await readFile(join(out, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!existsSync(join(out, 'node_modules', name))) throw new Error(`Production dependency ${name} was not installed`);
  }
  if (existsSync(join(out, 'node_modules', 'typescript'))) throw new Error('A development dependency leaked into the staged package');

  const entries = (await readdir(out)).filter((name) => name !== PACKAGE_MARKER).sort();
  return { out, entries, bytes: await directoryBytes(out) };
}
