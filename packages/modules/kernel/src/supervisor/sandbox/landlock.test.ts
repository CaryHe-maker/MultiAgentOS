import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDigestOf, type SandboxProfile, type SandboxScope } from '@multiagentos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { landlockWritable, probeLandlock } from './landlock.js';
import { createSandboxRunner } from './sandbox-runner.js';

const profileOf = (repositoryRoot: string, writableRoots: string[]): SandboxProfile => ({
  repositoryRoot,
  workdir: '',
  writableRoots,
  network: false,
  homeReadOnly: [],
  homeMaskedFiles: [],
  maskedFiles: [],
  maskedDirs: [],
  protectedExisting: [],
});

describe('the directories an unisolated command may write (D79)', () => {
  it('takes the write roots that exist and the system temporary directories', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'landlock-dirs-')));
    try {
      mkdirSync(join(base, 'repo', 'mine'), { recursive: true });
      const writable = landlockWritable(
        profileOf(join(base, 'repo'), ['mine', 'not-yet']),
        join(base, 'home'),
      );
      expect(writable).toContain(join(base, 'repo', 'mine'));
      expect(writable).not.toContain(join(base, 'repo', 'not-yet'));
      expect(writable).not.toContain(join(base, 'repo'));
      expect(writable).toContain('/dev');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('leaves out a temporary directory the repository lives in, which would open all of it', () => {
    expect(landlockWritable(profileOf('/tmp/work/repo', ['src']), '/home/u')).not.toContain('/tmp');
    expect(landlockWritable(profileOf('/srv/repo', ['src']), '/home/u')).toContain('/tmp');
  });
});

/** These run where Landlock works (Linux 5.13 and later, with python3), as in WSL and Docker. */
const python = probeLandlock();

describe.skipIf(python === undefined)('an unisolated command under Landlock (D79)', () => {
  let base: string;
  let repo: string;
  let home: string;
  let emptyFile: string;

  beforeAll(() => {
    // Not under /tmp: commands may write /tmp, and a repository there would be all writable.
    base = realpathSync(mkdtempSync(join(homedir(), '.landlock-test-')));
    repo = join(base, 'repo');
    home = join(base, 'home');
    mkdirSync(join(repo, 'mine'), { recursive: true });
    mkdirSync(join(repo, 'theirs'), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(repo, 'theirs', 'module.py'), 'original\n');
    emptyFile = join(base, 'empty');
    writeFileSync(emptyFile, '');
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const run = async (command: string) => {
    const profile = profileOf(repo, ['mine']);
    const scope: SandboxScope = {
      kind: 'SANDBOX',
      backend: 'UNISOLATED',
      profile,
      approvalDigest: approvalDigestOf({
        command,
        workdir: '',
        network: false,
        writableRoots: ['mine'],
        backend: 'UNISOLATED',
      }),
    };
    const runner = createSandboxRunner({ emptyFile, cancelGraceMs: 400, killGraceMs: 400, home });
    expect(runner.unisolatedWritesEnforced).toBe(true);
    const result = await runner.run({
      scope,
      command,
      timeoutMs: 10_000,
      maxOutputBytes: 100_000,
      signal: new AbortController().signal,
    });
    if (result.kind !== 'RAN') throw new Error(result.kind);
    return result;
  };

  it('writes in its own write scope and in /tmp, but not in the files of another task', async () => {
    const marker = `/tmp/landlock-${String(process.pid)}.txt`;
    const result = await run(
      `echo ok > mine/out.txt && echo ok > ${marker} && cat ${marker} && rm ${marker}; ` +
        `echo changed > theirs/module.py; echo "exit=$?"`,
    );
    expect(readFileSync(join(repo, 'mine', 'out.txt'), 'utf8')).toBe('ok\n');
    expect(result.output).toContain('ok');
    expect(result.output).toContain('Permission denied');
    expect(result.output).toContain('exit=1');
    expect(readFileSync(join(repo, 'theirs', 'module.py'), 'utf8')).toBe('original\n');
  });

  it('holds for the processes the command starts, and reads everything as before', async () => {
    const result = await run(
      `cat theirs/module.py; python3 -c "open('theirs/new.txt','w')" 2>&1 | tail -1; echo hi > /dev/null && echo devnull-ok`,
    );
    expect(result.output).toContain('original');
    expect(result.output).toContain('PermissionError');
    expect(result.output).toContain('devnull-ok');
  });

  it('can be turned off, and then writes anywhere as before', async () => {
    const runner = createSandboxRunner({
      emptyFile,
      cancelGraceMs: 400,
      killGraceMs: 400,
      home,
      landlock: false,
    });
    expect(runner.unisolatedWritesEnforced).toBe(false);
  });
});
