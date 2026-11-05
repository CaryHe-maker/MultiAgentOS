import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changesBetween, fingerprintRoots, type ChangeScanOptions } from './change-scan.js';

let root = '';
const options = (): ChangeScanOptions => ({
  repositoryRoot: root,
  exclusions: [],
  maxEntries: 1000,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mao-changes-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'src', 'a.ts'), 'one');
  await writeFile(join(root, 'src', 'b.ts'), 'two');
  await writeFile(join(root, 'docs', 'c.md'), 'three');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const scan = async (roots: string[]) => {
  const found = await fingerprintRoots(options(), roots);
  if (found === undefined) throw new Error('scan incomplete');
  return found;
};

describe('change scan', () => {
  it('names added, modified and removed files, sorted', async () => {
    const before = await scan(['src']);
    await writeFile(join(root, 'src', 'a.ts'), 'one, changed');
    await writeFile(join(root, 'src', 'new.ts'), 'new');
    await rm(join(root, 'src', 'b.ts'));
    expect(changesBetween(before, await scan(['src']))).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/new.ts',
    ]);
  });

  it('sees a rewrite that keeps the size', async () => {
    const before = await scan(['src']);
    await writeFile(join(root, 'src', 'a.ts'), 'ONE');
    const later = new Date(Date.now() + 5000);
    await utimes(join(root, 'src', 'a.ts'), later, later);
    expect(changesBetween(before, await scan(['src']))).toEqual(['src/a.ts']);
  });

  it('looks only under the roots it is given', async () => {
    const before = await scan(['src']);
    await writeFile(join(root, 'docs', 'c.md'), 'elsewhere');
    expect(changesBetween(before, await scan(['src']))).toEqual([]);
    expect(Array.from((await scan(['.'])).keys()).sort()).toEqual([
      'docs/c.md',
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('leaves out dependencies, .git and excluded files', async () => {
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'node_modules', 'x', 'i.js'), 'x');
    await writeFile(join(root, '.git', 'HEAD'), 'ref');
    await writeFile(join(root, '.env'), 'SECRET=1');
    expect(Array.from((await scan(['.'])).keys()).sort()).toEqual([
      'docs/c.md',
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('gives up on a tree it cannot scan whole', async () => {
    expect(
      await fingerprintRoots({ ...options(), maxEntries: 2 }, ['src', 'docs']),
    ).toBeUndefined();
  });

  it('accepts a root that does not exist yet, and a root that is one file', async () => {
    expect((await scan(['nowhere'])).size).toBe(0);
    expect(Array.from((await scan(['src/a.ts'])).keys())).toEqual(['src/a.ts']);
  });
});
