import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PACKAGE_MARKER, defaultPackageDir, prepareOutputDir, resolveOutputDir } from '../../tools/build/stage.ts';

describe('package output directory', () => {
  const root = join(tmpdir(), 'resolve-root');

  it('defaults to a folder under .artifacts', () => {
    assert.equal(resolveOutputDir(root, undefined), defaultPackageDir(root));
    assert.equal(defaultPackageDir(root), join(root, '.artifacts', 'package'));
  });

  it('accepts a subdirectory of .artifacts', () => {
    const out = join(root, '.artifacts', 'stage-two');
    assert.equal(resolveOutputDir(root, out), out);
  });

  for (const [name, requested] of [
    ['the repository root', root],
    ['a source folder', join(root, 'src')],
    ['.artifacts itself', join(root, '.artifacts')],
    ['a parent of the repository', join(root, '..')],
    ['a sibling that only shares a name prefix', `${join(root, '.artifacts')}-other`],
    ['a path that climbs out of .artifacts', join(root, '.artifacts', '..', 'dist')],
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.throws(() => resolveOutputDir(root, requested), /subdirectory of/);
    });
  }

  it('resolves a relative request against the working directory', () => {
    const out = resolveOutputDir(root, join('.artifacts', 'rel'), root);
    assert.equal(out, join(root, '.artifacts', 'rel'));
  });
});

describe('prepareOutputDir', () => {
  let scratch = '';
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'resolve-stage-'));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('creates a marked directory when none exists', async () => {
    const out = join(scratch, 'fresh');
    await prepareOutputDir(out);
    assert.ok(existsSync(join(out, PACKAGE_MARKER)));
  });

  it('replaces a directory it created earlier', async () => {
    const out = join(scratch, 'again');
    await prepareOutputDir(out);
    await writeFile(join(out, 'stale.txt'), 'old');
    await prepareOutputDir(out);
    assert.ok(!existsSync(join(out, 'stale.txt')));
    assert.ok(existsSync(join(out, PACKAGE_MARKER)));
  });

  it('refuses to delete a directory it did not create', async () => {
    const out = join(scratch, 'precious');
    await mkdir(out);
    await writeFile(join(out, 'keep.txt'), 'mine');
    await assert.rejects(prepareOutputDir(out), /not created by the package script/);
    assert.ok(existsSync(join(out, 'keep.txt')));
  });
});
