import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.ts';
import { ROOT } from './stack.ts';

export const GITLEAKS = 'ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
export const OASDIFF = 'tufin/oasdiff@sha256:82b1840a77335562bb11ce95f77ad31745a0c6f3a770929333ed1c5ef466e400';
const SOURCES = [
  '.github', 'src', 'web', 'contracts', 'infra', 'tools', 'tests', 'docs', 'README.md',
  'package.json', 'package-lock.json', '.gitignore', '.gitattributes', '.gitleaks.toml', '.node-version', 'host.json',
  'redocly.yaml', 'eslint.config.js', 'tsconfig.json', 'tsconfig.build.json',
];

export async function dockerCheck(image: string, args: readonly string[]): Promise<number> {
  const result = await run('docker', ['run', '--rm', '--network', 'none', '-v', `${ROOT}:/repo:ro`, image, ...args], { timeoutMs: 180_000 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code === null) {
    process.stderr.write(`Container check could not complete: ${result.startFailure ?? (result.timedOut ? 'timed out' : 'terminated')}\n`);
  }
  return result.code ?? 1;
}

async function main(args: readonly string[]): Promise<number> {
  if (args[0] === 'secrets' && args.length === 1) {
    const history = await dockerCheck(GITLEAKS, ['git', '--config', '/repo/.gitleaks.toml', '--redact=100', '--no-banner', '--log-opts=--all', '/repo']);
    if (history !== 0) return history;
    for (const source of SOURCES) {
      const code = await dockerCheck(GITLEAKS, ['dir', '--config', '/repo/.gitleaks.toml', '--redact=100', '--no-banner', `/repo/${source}`]);
      if (code !== 0) return code;
    }
    return 0;
  }
  if (args[0] === 'breaking' && args[1] === '--base' && args.length === 3 && /^[0-9a-f]{40}$/.test(args[2] ?? '')) {
    const base = args[2];
    const result = await run('git', ['show', `${base}:contracts/openapi.yaml`], { cwd: ROOT });
    if (result.code !== 0) {
      process.stderr.write('BLOCKED: cannot read the baseline contract. Initial publication has no compatibility baseline; this is not a pass.\n');
      return 2;
    }
    const directory = join(ROOT, '.artifacts', 'contract');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'baseline.yaml'), result.stdout);
    return dockerCheck(OASDIFF, ['breaking', '/repo/.artifacts/contract/baseline.yaml', '/repo/contracts/openapi.yaml', '--fail-on', 'WARN']);
  }
  process.stderr.write('Usage: safety.ts secrets | breaking --base <40-character commit SHA>\n');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
