import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { emptyDirectory, repositoryScope } from '../test-support/environments.js';
import { FileDigestCache, buildFileSet } from './file-set.js';
import { readGuardedFile } from './guarded-file.js';
import { resolveRepositoryScope, type RepositoryScope } from './repository-scope.js';
import { normalizeRequestPath } from './request-path.js';

/** “中文说明” in GBK: not valid UTF-8. */
const GBK_TEXT = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xcb, 0xb5, 0xc3, 0xf7, 0x0a]);

async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function scopeOf(root: string, exclusions: string[] = []): Promise<RepositoryScope> {
  const scope = await resolveRepositoryScope(repositoryScope(root, exclusions));
  if (scope === undefined) throw new Error('scope');
  return scope;
}

describe('exclusion rules (M1Interface 3.5, shared with Core)', () => {
  it.each([
    ['.env.production'],
    ['.hidden/server.pem'],
    ['KEYS/SERVER.PEM'], // case-insensitive: excluding too much is safe
    ['src/.git/config'], // nested repositories and submodules
    ['vendor/lib/node_modules/x/index.js'],
  ])('rejects %s before looking at the disk', async (path) => {
    const root = await emptyDirectory('guard');
    const read = await readGuardedFile(await scopeOf(root), path);
    expect(read).toMatchObject({ ok: false, outcome: { reasonCode: 'OUT_OF_SCOPE' } });
  });

  it('applies the defaults even when the scope carries none', async () => {
    const scope = await scopeOf(await emptyDirectory('guard'));
    expect(scope.rules).toEqual(expect.arrayContaining(['**/.env*', '**/.git/**']));
  });

  it('treats a scope with a rule the shared matcher cannot apply as missing', async () => {
    const root = await emptyDirectory('guard');
    expect(await resolveRepositoryScope(repositoryScope(root, ['src/{a,b}.ts']))).toBeUndefined();
    expect(await resolveRepositoryScope(repositoryScope(root, ['../outside/**']))).toBeUndefined();
  });
});

describe('request paths (ExecutorSet 3.2 step 2)', () => {
  it.each([
    ['src/a.ts', 'src/a.ts'],
    ['./src//a.ts', 'src/a.ts'],
    ['src/../a.ts', 'a.ts'],
    ['src/', 'src'],
    ['.', '.'],
  ])('%s normalizes to %s', (input, expected) => {
    expect(normalizeRequestPath(input)).toBe(expected);
  });

  it.each(['../a', 'src/../../a', '/etc/passwd', 'C:/x', 'a\\b', 'a\0b', ''])(
    'refuses %j',
    (input) => {
      expect(normalizeRequestPath(input)).toBeUndefined();
    },
  );

  it('never yields a path that climbs out of the root', () => {
    const segment = fc.constantFrom('a', 'b', '.', '..', '', 'c.ts');
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 8 }), (segments) => {
        const normalized = normalizeRequestPath(segments.join('/'));
        if (normalized === undefined) return;
        expect(normalized.split('/')).not.toContain('..');
        expect(normalized.startsWith('/')).toBe(false);
      }),
    );
  });
});

describe('guarded read (ExecutorSet 3.2)', () => {
  it('reads a text file inside the root', async () => {
    const root = await emptyDirectory('guard');
    await writeTree(root, { 'src/a.ts': 'one\n' });
    const read = await readGuardedFile(await scopeOf(root), 'src/a.ts');
    expect(read).toMatchObject({ ok: true, file: { path: 'src/a.ts' } });
  });

  it('rejects an excluded path before looking at the disk', async () => {
    const root = await emptyDirectory('guard');
    const read = await readGuardedFile(await scopeOf(root), '.env.production');
    expect(read).toMatchObject({ ok: false, outcome: { reasonCode: 'OUT_OF_SCOPE' } });
  });

  it('rejects a link inside the root that resolves to an excluded file', async () => {
    const root = await emptyDirectory('guard');
    await writeTree(root, { '.env': 'SECRET=1\n' });
    await symlink(join(root, '.env'), join(root, 'innocent.txt'));
    const read = await readGuardedFile(await scopeOf(root), 'innocent.txt');
    expect(read).toMatchObject({ ok: false, outcome: { reasonCode: 'OUT_OF_SCOPE' } });
  });

  it('rejects a directory link that leaves the root', async () => {
    const base = await emptyDirectory('guard');
    await writeTree(base, { 'outside/secret.txt': 'x\n', 'repo/readme.md': 'r\n' });
    await symlink(join(base, 'outside'), join(base, 'repo', 'linked'));
    const read = await readGuardedFile(await scopeOf(join(base, 'repo')), 'linked/secret.txt');
    expect(read).toMatchObject({ ok: false, outcome: { reasonCode: 'OUT_OF_SCOPE' } });
  });

  it('reports a file replaced between the checks and the open as PATH_ESCAPE', async () => {
    const base = await emptyDirectory('guard');
    await writeTree(base, { 'repo/a.txt': 'original\n', 'other.txt': 'swapped in\n' });
    const read = await readGuardedFile(await scopeOf(join(base, 'repo')), 'a.txt', {
      beforeOpen: (real) => rename(join(base, 'other.txt'), real),
    });
    expect(read).toMatchObject({
      ok: false,
      outcome: { outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' },
    });
  });

  it('reports a file replaced by a link after the checks as PATH_ESCAPE', async () => {
    const base = await emptyDirectory('guard');
    await writeTree(base, { 'repo/a.txt': 'original\n', 'outside.txt': 'outside\n' });
    const read = await readGuardedFile(await scopeOf(join(base, 'repo')), 'a.txt', {
      beforeOpen: async (real) => {
        await rename(real, `${real}.old`);
        await symlink(join(base, 'outside.txt'), real);
      },
    });
    expect(read).toMatchObject({
      ok: false,
      outcome: { outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' },
    });
  });

  it('reports a file deleted between the checks and the open as NOT_FOUND', async () => {
    const base = await emptyDirectory('guard');
    await writeTree(base, { 'repo/a.txt': 'original\n' });
    const read = await readGuardedFile(await scopeOf(join(base, 'repo')), 'a.txt', {
      beforeOpen: (real) => rm(real),
    });
    expect(read).toMatchObject({
      ok: false,
      outcome: { outcome: 'REJECTED', reasonCode: 'NOT_FOUND' },
    });
  });

  it('refuses a file that is not UTF-8 text instead of returning replacement characters', async () => {
    const root = await emptyDirectory('guard');
    await writeTree(root, { 'gbk.txt': GBK_TEXT, '中文.md': '中文说明\n' });
    const scope = await scopeOf(root);
    expect(await readGuardedFile(scope, 'gbk.txt')).toMatchObject({
      ok: false,
      outcome: { outcome: 'REJECTED', reasonCode: 'UNSUPPORTED_FILE' },
    });
    expect(await readGuardedFile(scope, '中文.md')).toMatchObject({ ok: true });
  });

  it('treats a NUL beyond the first 8 KiB as text', async () => {
    const root = await emptyDirectory('guard');
    await writeTree(root, {
      'late.txt': Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]),
    });
    const read = await readGuardedFile(await scopeOf(root), 'late.txt');
    expect(read.ok).toBe(true);
  });
});

describe('file set and snapshot (ExecutorSet 3.1)', () => {
  const files = {
    'README.md': '# r\n',
    'src/a.ts': 'export const a = 1;\n',
    '.hidden/b.ts': 'export const b = 2;\n',
  };

  async function snapshot(root: string, cache = new FileDigestCache()) {
    const built = await buildFileSet(await scopeOf(root), {
      signal: new AbortController().signal,
      cache,
    });
    if (!built.ok) throw new Error('limit');
    return built.set;
  }

  it('gives the same snapshot for the same content in different places', async () => {
    const first = await emptyDirectory('snap');
    const second = await emptyDirectory('snap');
    await writeTree(first, files);
    await writeTree(second, files);
    expect((await snapshot(first)).snapshotId).toBe((await snapshot(second)).snapshotId);
  });

  it('ignores excluded and binary files, and changes with any text file', async () => {
    const root = await emptyDirectory('snap');
    await writeTree(root, files);
    const before = await snapshot(root);
    await writeTree(root, {
      '.env': 'SECRET=1\n',
      'node_modules/x/index.js': 'x\n',
      'vendor/sub/.git/HEAD': 'ref: refs/heads/main\n',
      'logo.bin': Buffer.from([1, 0, 2]),
    });
    await symlink(join(root, 'README.md'), join(root, 'link.md'));
    const withIgnored = await snapshot(root);
    expect(withIgnored.snapshotId).toBe(before.snapshotId);
    expect(withIgnored.files.map((file) => file.path)).toEqual([
      '.hidden/b.ts',
      'README.md',
      'src/a.ts',
    ]);
    await writeTree(root, { 'src/a.ts': 'export const a = 2;\n' });
    expect((await snapshot(root)).snapshotId).not.toBe(before.snapshotId);
  });

  it('leaves files that are not UTF-8 text out, however their characters fall on reads', async () => {
    const root = await emptyDirectory('snap');
    // The three bytes of 中 straddle the 1 MiB read chunk of the digest.
    const straddling = Buffer.concat([Buffer.alloc(1024 * 1024 - 1, 0x61), Buffer.from('中\n')]);
    await writeTree(root, { 'gbk.txt': GBK_TEXT, 'big.txt': straddling, '中文.md': '中文\n' });
    expect((await snapshot(root)).files.map((file) => file.path)).toEqual(['big.txt', '中文.md']);
  });

  it('sorts by UTF-16 code units, not by locale', async () => {
    const root = await emptyDirectory('snap');
    await writeTree(root, { 'b.ts': '1\n', 'B.ts': '2\n', 'a.ts': '3\n', '_x.ts': '4\n' });
    expect((await snapshot(root)).files.map((file) => file.path)).toEqual([
      'B.ts',
      '_x.ts',
      'a.ts',
      'b.ts',
    ]);
  });

  it('stops at maxFiles', async () => {
    const root = await emptyDirectory('snap');
    await writeTree(root, files);
    const built = await buildFileSet(await scopeOf(root), {
      signal: new AbortController().signal,
      maxFiles: 2,
      cache: new FileDigestCache(),
    });
    expect(built.ok).toBe(false);
  });

  it('applies exclusions appended by Core', async () => {
    const root = await emptyDirectory('snap');
    await writeTree(root, files);
    const built = await buildFileSet(await scopeOf(root, ['src/**']), {
      signal: new AbortController().signal,
      cache: new FileDigestCache(),
    });
    expect(built.ok && built.set.files.map((file) => file.path)).toEqual([
      '.hidden/b.ts',
      'README.md',
    ]);
  });
});
