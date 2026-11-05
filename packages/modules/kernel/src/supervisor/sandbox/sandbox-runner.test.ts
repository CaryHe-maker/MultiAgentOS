import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDigestOf, type SandboxProfile, type SandboxScope } from '@multiagentos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxRunner } from './sandbox-runner.js';

/**
 * These run the real `bwrap`, so they only run where it works: Ubuntu 24.04 and WSL (M2TechStack
 * 3.1). Elsewhere the same cases are covered by the pure argument tests.
 */
const bwrapWorks =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-net', '/bin/true']).status === 0;

describe.skipIf(!bwrapWorks)('SandboxRunner with bwrap', () => {
  let base: string;
  let repo: string;
  let home: string;
  let outside: string;
  let emptyFile: string;
  const runner = () =>
    createSandboxRunner({ emptyFile, cancelGraceMs: 400, killGraceMs: 400, home });

  const scopeFor = (
    command: string,
    over: Partial<SandboxProfile> = {},
    approved: Partial<{ command: string }> = {},
  ): { scope: SandboxScope; command: string } => {
    const profile: SandboxProfile = {
      repositoryRoot: repo,
      workdir: '',
      writableRoots: ['.'],
      network: false,
      homeReadOnly: [join(home, '.tools')],
      homeMaskedFiles: [join(home, '.tools', 'credentials')],
      maskedFiles: ['.env'],
      maskedDirs: ['secrets'],
      protectedExisting: ['.git', 'AGENTS.md'],
      ...over,
    };
    const digest = approvalDigestOf({
      command: approved.command ?? command,
      workdir: profile.workdir,
      network: profile.network,
      writableRoots: profile.writableRoots,
      backend: 'BWRAP',
    });
    return {
      scope: { kind: 'SANDBOX', backend: 'BWRAP', profile, approvalDigest: digest },
      command,
    };
  };
  const exec = async (command: string, over: Partial<SandboxProfile> = {}, timeoutMs = 10_000) => {
    const { scope } = scopeFor(command, over);
    const result = await runner().run({
      scope,
      command,
      timeoutMs,
      maxOutputBytes: 1_000_000,
      signal: new AbortController().signal,
    });
    if (result.kind !== 'RAN') throw new Error(`refused: ${result.reason}`);
    return result;
  };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-')));
    repo = join(base, 'repo');
    home = join(base, 'home');
    outside = join(base, 'outside');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'secrets'));
    mkdirSync(join(home, '.tools'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(repo, '.git', 'config'), '[core]\n');
    writeFileSync(join(repo, 'AGENTS.md'), 'rules\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=abc\n');
    writeFileSync(join(repo, 'secrets', 'k'), 'secret\n');
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    writeFileSync(join(home, '.tools', 'credentials'), 'login\n');
    writeFileSync(join(home, '.tools', 'tool'), 'tool\n');
    writeFileSync(join(home, '.bashrc'), 'private\n');
    writeFileSync(join(outside, 'x'), 'x\n');
    emptyFile = join(base, 'empty');
    writeFileSync(emptyFile, '');
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('runs a command, merges its output and gives the exit code', async () => {
    const result = await exec('echo out; echo err >&2; exit 3');
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, backend: 'BWRAP' });
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
  });

  it('works in the repository and can write inside its writable roots', async () => {
    const result = await exec('cat a.txt && echo new > b.txt && pwd');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('new\n');
    expect(result.output).toContain(repo);
  });

  it('reads masked secret files as empty and cannot see a masked directory', async () => {
    const result = await exec('wc -c < .env; ls secrets | wc -l; cat secrets/k 2>&1; echo done');
    expect(result.output.split('\n')[0]?.trim()).toBe('0');
    expect(result.output).toContain('done');
    expect(result.output).not.toMatch(/^secret$/mu);
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('TOKEN=abc\n');
  });

  it('hides the home directory except the read-only tool chains, and masks their credentials', async () => {
    const result = await exec(
      `cat ${home}/.bashrc 2>&1; cat ${home}/.tools/tool; wc -c < ${home}/.tools/credentials; touch ${home}/.tools/w 2>&1`,
    );
    expect(result.output).not.toContain('private');
    expect(result.output).toContain('tool');
    expect(result.output).not.toContain('login');
    expect(result.output).toContain('Read-only file system');
    expect(result.denials).toBeGreaterThan(0);
  });

  it('cannot write outside the writable roots or to the filesystem root', async () => {
    const result = await exec(`touch ${outside}/y 2>&1; touch /etc/y 2>&1; echo end`);
    // /tmp is private, so the outside directory is not even there; either way nothing is written.
    expect(
      result.output.match(/Read-only file system|Permission denied|No such file or directory/gu),
    ).toHaveLength(2);
    expect(existsSync(join(outside, 'y'))).toBe(false);
  });

  it('writes only inside a narrower writable root', async () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    const result = await exec('touch src/ok 2>&1; touch top 2>&1; echo end', {
      writableRoots: ['src'],
    });
    expect(existsSync(join(repo, 'src', 'ok'))).toBe(true);
    expect(existsSync(join(repo, 'top'))).toBe(false);
    expect(result.output).toContain('Read-only file system');
  });

  it('keeps existing .git and AGENTS.md read-only inside the writable root', async () => {
    const result = await exec('echo x >> .git/config 2>&1; echo x >> AGENTS.md 2>&1; echo end');
    expect(result.output.match(/Read-only file system/gu)?.length).toBe(2);
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe('[core]\n');
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe('rules\n');
  });

  it('has no network unless the profile says so', async () => {
    const result = await exec('exec 3<>/dev/tcp/127.0.0.1/9 2>&1; echo status=$?');
    expect(result.output).toContain('status=1');
    const loopback = await exec('cat /proc/net/dev | grep -c "^ *lo:" ; cat /proc/net/dev | wc -l');
    expect(loopback.exitCode).toBe(0);
    // Only the loopback device (and its two header lines) is there.
    expect(loopback.output.trim().split('\n').at(-1)).toBe('3');
  });

  it('gives the command only the whitelisted environment', async () => {
    process.env['SANDBOX_TEST_API_KEY'] = 'leak';
    try {
      const result = await exec('env | sort');
      const names = result.output
        .split('\n')
        .map((line) => line.split('=')[0])
        .filter((name) => name !== undefined && name !== '');
      expect(result.output).not.toContain('leak');
      expect(names).toEqual(expect.arrayContaining(['HOME', 'PATH', 'LANG']));
      expect(names.every((name) => !/KEY|SECRET|TOKEN/u.test(name ?? ''))).toBe(true);
    } finally {
      delete process.env['SANDBOX_TEST_API_KEY'];
    }
  });

  it('refuses a command that is not the one that was approved', async () => {
    const { scope } = scopeFor('rm -rf x', {}, { command: 'echo hi' });
    const result = await runner().run({
      scope,
      command: 'rm -rf x',
      timeoutMs: 5_000,
      maxOutputBytes: 1000,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ kind: 'REFUSED', reason: 'APPROVAL_MISMATCH' });
  });

  it('refuses a work directory that is a link out of the repository', async () => {
    const link = join(repo, 'escape');
    spawnSync('ln', ['-s', outside, link]);
    const result = await runner().run({
      ...scopeFor('ls', { workdir: 'escape' }),
      timeoutMs: 5_000,
      maxOutputBytes: 1000,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ kind: 'REFUSED', reason: 'WORKDIR_INVALID' });
  });

  it('ends a command at its timeout and reports it with what it printed', async () => {
    const result = await exec('echo before; sleep 30', {}, 400);
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain('before');
  });

  it('stops a command that ignores SIGTERM with SIGKILL and leaves no process behind', async () => {
    const controller = new AbortController();
    const marker = join(base, 'alive');
    const { scope, command } = scopeFor(
      `trap '' TERM; (trap '' TERM; while true; do echo up > ${marker}; sleep 0.1; done) & wait`,
    );
    const started = Date.now();
    const pending = runner().run({
      scope,
      command,
      timeoutMs: 30_000,
      maxOutputBytes: 1000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();
    const result = await pending;
    expect(result.kind).toBe('RAN');
    expect(Date.now() - started).toBeLessThan(5_000);
    rmSync(marker, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(marker)).toBe(false);
  });

  it('runs the same command without isolation when the user approved that', async () => {
    const { scope } = scopeFor('echo plain; pwd; touch /tmp/unisolated-probe-$ && echo wrote');
    const command = 'echo plain; pwd';
    const unisolated: SandboxScope = {
      ...scope,
      backend: 'UNISOLATED',
      approvalDigest: approvalDigestOf({
        command,
        workdir: '',
        network: false,
        writableRoots: ['.'],
        backend: 'UNISOLATED',
      }),
    };
    const result = await runner().run({
      scope: unisolated,
      command,
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ kind: 'RAN', exitCode: 0, backend: 'UNISOLATED' });
    expect(result.kind === 'RAN' && result.output).toContain(repo);
  });

  it('refuses an unisolated command whose approval does not match', async () => {
    const { scope } = scopeFor('echo hi');
    const result = await runner().run({
      scope: { ...scope, backend: 'UNISOLATED' },
      command: 'echo hi',
      timeoutMs: 5_000,
      maxOutputBytes: 1000,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ kind: 'REFUSED', reason: 'APPROVAL_MISMATCH' });
  });

  it('sees no runtime directory of the host and no other disk', async () => {
    const result = await exec('ls -A /run | wc -l; find /mnt /media -mindepth 1 2>&1 | wc -l');
    const [run, other] = result.output.trim().split('\n');
    expect(run?.trim()).toBe('0');
    expect(other?.trim()).toBe('0');
  });

  it('shows .git/config without the credentials of a remote', async () => {
    writeFileSync(
      join(repo, '.git', 'config'),
      '[remote "origin"]\n\turl = https://me:ghp_secret@host/o/r.git\n',
    );
    try {
      const result = await exec('cat .git/config');
      expect(result.output).toContain('https://host/o/r.git');
      expect(result.output).not.toContain('ghp_secret');
      expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toContain('ghp_secret');
    } finally {
      writeFileSync(join(repo, '.git', 'config'), '[core]\n');
    }
  });

  it('gives a command a /tmp of limited size and a limit on new processes', async () => {
    const { scope, command } = scopeFor(
      'head -c 3000000 /dev/zero > /tmp/big; echo size:$(stat -c %s /tmp/big); for i in 1 2 3 4 5 6 7 8; do sleep 2 >/dev/null 2>&1 & done; echo forked:$(jobs -p | wc -l)',
    );
    const limited = createSandboxRunner({
      emptyFile,
      cancelGraceMs: 400,
      killGraceMs: 400,
      home,
      tmpBytes: 1_000_000,
      maxProcesses: 6,
    });
    const result = await limited.run({
      scope,
      command,
      timeoutMs: 25_000,
      maxOutputBytes: 100_000,
      signal: new AbortController().signal,
    });
    if (result.kind !== 'RAN') throw new Error('refused');
    expect(result.output).toMatch(/size:1000000|No space left/u);
    expect(result.output).not.toContain('size:3000000');
    expect(result.output).not.toContain('forked:8');
  }, 40_000);

  it('cannot write anywhere in the repository when it has no writable root, and still reads and runs git', async () => {
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const result = await exec(
      'git status --short 2>&1; echo status:$?; touch new.txt 2>&1; echo w:$?; cat a.txt',
      { writableRoots: [] },
    );
    expect(result.output).toContain('status:0');
    expect(result.output).toMatch(/Read-only file system/u);
    expect(result.output).toContain('w:1');
    expect(result.output).toContain('hello');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
  });

  it('lets a command that fills memory fail instead of the machine', async () => {
    const { scope, command } = scopeFor(
      `python3 -c "
import sys
x = bytearray(600 * 1024 * 1024)
print('allocated')
" 2>&1 | tail -2; echo done`,
    );
    const limited = createSandboxRunner({
      emptyFile,
      cancelGraceMs: 400,
      killGraceMs: 400,
      home,
      maxDataBytes: 200 * 1024 * 1024,
    });
    const result = await limited.run({
      scope,
      command,
      timeoutMs: 20_000,
      maxOutputBytes: 100_000,
      signal: new AbortController().signal,
    });
    if (result.kind !== 'RAN') throw new Error('refused');
    expect(result.output).toMatch(/MemoryError|Cannot allocate/u);
    expect(result.output).not.toContain('allocated');
    expect(result.output).toContain('done');
  });

  it('never keeps more output than it was allowed', async () => {
    const { scope, command } = scopeFor('yes | head -c 200000');
    const result = await runner().run({
      scope,
      command,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ kind: 'RAN', truncated: true });
    expect(result.kind === 'RAN' && result.output.length).toBe(1_000);
  });
});
