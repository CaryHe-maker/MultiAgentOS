import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inGitWorkTree } from './compose-system.js';

const made: string[] = [];
afterEach(async () => {
  for (const folder of made.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe('whether a folder lies in a git work tree (git_inspect is offered only then)', () => {
  it('finds .git in the folder or in a folder above it, as a folder or a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mas-git-'));
    made.push(root);
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await mkdir(join(root, 'repo', 'services', 'api'), { recursive: true });
    expect(inGitWorkTree(join(root, 'repo'))).toBe(true);
    expect(inGitWorkTree(join(root, 'repo', 'services', 'api'))).toBe(true);
    // A worktree has a .git file that points to the repository.
    await mkdir(join(root, 'worktree'));
    await writeFile(join(root, 'worktree', '.git'), 'gitdir: ../repo/.git/worktrees/w\n');
    expect(inGitWorkTree(join(root, 'worktree'))).toBe(true);
  });

  it('says no for a folder with no .git anywhere above it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mas-nogit-'));
    made.push(root);
    await mkdir(join(root, 'plain'));
    // The temporary folder of the system lies in no repository on the machines the tests run on.
    expect(inGitWorkTree(join(root, 'plain'))).toBe(false);
  });
});
