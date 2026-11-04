import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { protectedPathsOf, quarantineNewProtected, scanRepository } from './sandbox-scan.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'scan-')));
  roots.push(base);
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
  mkdirSync(join(repo, 'keys'), { recursive: true });
  writeFileSync(join(repo, '.env'), 'A=1');
  writeFileSync(join(repo, '.env.local'), 'A=1');
  writeFileSync(join(repo, 'src', 'deep', 'id_rsa'), 'k');
  writeFileSync(join(repo, 'keys', 'server.pem'), 'k');
  writeFileSync(join(repo, 'AGENTS.md'), 'rules');
  writeFileSync(join(repo, 'src', 'AGENTS.md'), 'rules');
  writeFileSync(join(repo, 'node_modules', 'x', 'AGENTS.md'), 'not ours');
  writeFileSync(join(repo, 'src', 'a.ts'), 'x');
  return repo;
}

const options = (repositoryRoot: string, extra: string[] = []) => ({
  repositoryRoot,
  extraSecretRules: extra,
  exclusions: [],
  maxEntries: 10_000,
});

describe('scanRepository', () => {
  it('finds the secret files at any depth and the protected paths that exist', async () => {
    const scan = await scanRepository(options(repository()));
    expect(scan.maskedFiles).toEqual(['.env', '.env.local', 'keys/server.pem', 'src/deep/id_rsa']);
    expect(scan.protectedExisting).toEqual(['.git', 'AGENTS.md', 'src/AGENTS.md']);
    expect(scan.maskedDirs).toEqual([]);
  });

  it('adds the patterns of the Session', async () => {
    const scan = await scanRepository(options(repository(), ['src/deep/**']));
    expect(scan.maskedDirs).toContain('src/deep');
  });

  it('stops at its entry budget instead of walking a huge tree', async () => {
    const scan = await scanRepository({ ...options(repository()), maxEntries: 2 });
    expect(scan.maskedFiles.length + scan.protectedExisting.length).toBeLessThan(7);
  });
});

describe('quarantineNewProtected', () => {
  it('moves out what a command created and leaves what was there', async () => {
    const repo = repository();
    const before = await protectedPathsOf(options(repo));
    mkdirSync(join(repo, 'sub', '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, 'sub', '.git', 'hooks', 'pre-commit'), 'evil');
    writeFileSync(join(repo, 'sub', 'AGENTS.md'), 'new rules');
    const quarantine = join(repo, '..', 'quarantine');
    const moved = await quarantineNewProtected(options(repo), before, quarantine);
    expect(moved.sort()).toEqual(['sub/.git', 'sub/AGENTS.md']);
    expect(existsSync(join(repo, 'sub', '.git'))).toBe(false);
    expect(existsSync(join(repo, 'sub', 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(repo, '.git'))).toBe(true);
  });

  it('does nothing when nothing was created', async () => {
    const repo = repository();
    const before = await protectedPathsOf(options(repo));
    expect(await quarantineNewProtected(options(repo), before, join(repo, '..', 'q'))).toEqual([]);
  });
});
