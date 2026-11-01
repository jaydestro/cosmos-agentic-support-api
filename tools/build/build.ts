import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const web = join(dist, 'web');

function compileServer(): void {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('The TypeScript build failed');
}

async function bundleConsole(): Promise<{ script: string; styles: string }> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: { main: 'web/src/main.ts', styles: 'web/src/styles.css' },
    outdir: 'dist/web/assets',
    // Content hashes make the long-lived cache headers on assets/ safe.
    entryNames: '[name]-[hash]',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
  });
  const names = Object.keys(result.metafile.outputs).map((output) => basename(output));
  const script = names.find((name) => name.endsWith('.js'));
  const styles = names.find((name) => name.endsWith('.css'));
  if (script === undefined || styles === undefined) throw new Error('The console bundle is incomplete');
  return { script, styles };
}

async function writeConsoleHtml(files: { script: string; styles: string }): Promise<void> {
  const template = await readFile(join(root, 'web', 'index.html'), 'utf8');
  if (!template.includes('{{script}}') || !template.includes('{{styles}}')) {
    throw new Error('web/index.html must contain the {{script}} and {{styles}} placeholders');
  }
  const html = template.replace('{{script}}', `/assets/${files.script}`).replace('{{styles}}', `/assets/${files.styles}`);
  await writeFile(join(web, 'index.html'), html);
}

async function copyReference(): Promise<void> {
  const target = join(web, 'reference');
  const swagger = join(root, 'node_modules', 'swagger-ui-dist');
  await mkdir(target, { recursive: true });
  await Promise.all([
    cp(join(swagger, 'swagger-ui-bundle.js'), join(target, 'swagger-ui-bundle.js')),
    cp(join(swagger, 'swagger-ui.css'), join(target, 'swagger-ui.css')),
    cp(join(root, 'contracts', 'openapi.yaml'), join(target, 'openapi.yaml')),
    cp(join(root, 'web', 'reference', 'index.html'), join(target, 'index.html')),
    cp(join(root, 'web', 'reference', 'init.js'), join(target, 'init.js')),
  ]);
}

await rm(dist, { recursive: true, force: true });
compileServer();
await mkdir(web, { recursive: true });
await writeConsoleHtml(await bundleConsole());
await copyReference();
console.log('Build complete: dist/src (Functions app) and dist/web (console and API reference)');
