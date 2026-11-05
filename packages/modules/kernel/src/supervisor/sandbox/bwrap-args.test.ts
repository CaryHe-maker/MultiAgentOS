import { describe, expect, it } from 'vitest';
import type { SandboxProfile } from '@multiagentos/contracts';
import { buildBwrapArgs, type BwrapInput } from './bwrap-args.js';

const profile: SandboxProfile = {
  repositoryRoot: '/home/me/repo',
  workdir: 'pkg',
  writableRoots: ['.'],
  network: false,
  homeReadOnly: ['/home/me/.nvm', '/home/me/.cargo', '/home/me/.volta'],
  homeMaskedFiles: ['/home/me/.cargo/credentials.toml'],
  dataDir: '/var/lib/mao',
  maskedFiles: ['.env', 'keys/id_rsa'],
  maskedDirs: ['secrets'],
  protectedExisting: ['.git', '.multiagentos', 'AGENTS.md'],
};

const input = (
  over: Partial<BwrapInput> = {},
  changed: Partial<SandboxProfile> = {},
): BwrapInput => ({
  profile: { ...profile, ...changed },
  command: 'npm test',
  home: '/home/me',
  emptyFile: '/data/tmp/empty',
  statusFd: 3,
  env: { PATH: '/usr/bin', HOME: '/home/me' },
  exists: () => true,
  ...over,
});

/** Index of the first occurrence of consecutive arguments. */
const at = (args: readonly string[], ...sequence: string[]): number => {
  for (let index = 0; index + sequence.length <= args.length; index += 1)
    if (sequence.every((value, offset) => args[index + offset] === value)) return index;
  return -1;
};

describe('buildBwrapArgs', () => {
  it('starts with the isolation flags and cuts the network by default', () => {
    const args = buildBwrapArgs(input());
    expect(args.slice(0, 7)).toEqual([
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--die-with-parent',
      '--new-session',
      '--json-status-fd',
      '3',
    ]);
    expect(args).toContain('--unshare-net');
  });

  it('shares the network only when the profile says so', () => {
    expect(buildBwrapArgs(input({}, { network: true }))).not.toContain('--unshare-net');
  });

  it('clears the environment and sets only what it is given', () => {
    const args = buildBwrapArgs(input());
    const clear = args.indexOf('--clearenv');
    expect(clear).toBeGreaterThan(-1);
    expect(at(args, '--setenv', 'PATH', '/usr/bin')).toBeGreaterThan(clear);
    expect(args.filter((value) => value === '--setenv')).toHaveLength(2);
  });

  it('mounts in the order that makes later mounts win', () => {
    const args = buildBwrapArgs(input());
    const order = [
      at(args, '--ro-bind', '/', '/'),
      at(args, '--tmpfs', '/home/me'),
      at(args, '--tmpfs', '/tmp'),
      at(args, '--ro-bind', '/home/me/.nvm', '/home/me/.nvm'),
      at(args, '--ro-bind', '/data/tmp/empty', '/home/me/.cargo/credentials.toml'),
      at(args, '--ro-bind', '/home/me/repo', '/home/me/repo'),
      at(args, '--bind', '/home/me/repo', '/home/me/repo'),
      at(args, '--ro-bind', '/home/me/repo/.git', '/home/me/repo/.git'),
      at(args, '--ro-bind', '/data/tmp/empty', '/home/me/repo/.env'),
      at(args, '--tmpfs', '/home/me/repo/secrets'),
      at(args, '--tmpfs', '/var/lib/mao'),
      at(args, '--chdir', '/home/me/repo/pkg'),
    ];
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('puts /tmp before the repository so a repository under /tmp is not hidden', () => {
    const args = buildBwrapArgs(input({}, { repositoryRoot: '/tmp/work' }));
    expect(at(args, '--tmpfs', '/tmp')).toBeLessThan(
      at(args, '--ro-bind', '/tmp/work', '/tmp/work'),
    );
  });

  it('masks files with an empty regular file, never /dev/null', () => {
    const args = buildBwrapArgs(input());
    expect(args).not.toContain('/dev/null');
    expect(at(args, '--ro-bind', '/data/tmp/empty', '/home/me/repo/keys/id_rsa')).toBeGreaterThan(
      -1,
    );
  });

  it('binds only the writable roots read-write', () => {
    const args = buildBwrapArgs(input({}, { writableRoots: ['src', 'docs'] }));
    const binds = args.flatMap((value, index) => (value === '--bind' ? [args[index + 1]] : []));
    expect(binds).toEqual(['/home/me/repo/src', '/home/me/repo/docs']);
  });

  it('skips mounts for paths that are not there', () => {
    const args = buildBwrapArgs(
      input({ exists: (path) => !path.endsWith('.nvm') && !path.endsWith('.env') }),
    );
    expect(args).not.toContain('/home/me/.nvm');
    expect(args).not.toContain('/home/me/repo/.env');
    expect(args).toContain('/home/me/.cargo');
  });

  it('does not mask the data directory twice when it lies inside the hidden home', () => {
    const args = buildBwrapArgs(input({}, { dataDir: '/home/me/.mao' }));
    expect(args).not.toContain('/home/me/.mao');
  });

  it('empties the host runtime directories and the other disks, before the repository comes back', () => {
    const args = buildBwrapArgs(input({}, { repositoryRoot: '/mnt/d/work/repo' }));
    for (const directory of ['/run', '/mnt', '/media'])
      expect(at(args, '--tmpfs', directory)).toBeGreaterThan(-1);
    expect(at(args, '--tmpfs', '/mnt')).toBeLessThan(
      at(args, '--ro-bind', '/mnt/d/work/repo', '/mnt/d/work/repo'),
    );
    expect(at(args, '--ro-bind', '/run/systemd/resolve', '/run/systemd/resolve')).toBe(-1);
  });

  it('keeps name resolution only when the network is shared', () => {
    const args = buildBwrapArgs(input({}, { network: true }));
    expect(at(args, '--ro-bind', '/run/systemd/resolve', '/run/systemd/resolve')).toBeGreaterThan(
      at(args, '--tmpfs', '/run'),
    );
    expect(at(args, '--ro-bind', '/mnt/wsl/resolv.conf', '/mnt/wsl/resolv.conf')).toBeGreaterThan(
      at(args, '--tmpfs', '/mnt'),
    );
  });

  it('sizes /tmp and limits the processes when it is told to', () => {
    const args = buildBwrapArgs(
      input({
        tmpBytes: 1024,
        limits: { maxProcesses: 300, maxFileBytes: 4096, maxDataBytes: 8192 },
      }),
    );
    expect(at(args, '--size', '1024', '--tmpfs', '/tmp')).toBeGreaterThan(-1);
    expect(args.slice(-9)).toEqual([
      '--',
      'prlimit',
      '--nproc=300',
      '--fsize=4096',
      '--data=8192',
      '--',
      '/bin/bash',
      '-c',
      'npm test',
    ]);
  });

  it('lays the credential-free copy over .git/config after .git is read-only', () => {
    const args = buildBwrapArgs(input({ gitConfig: '/data/tmp/gitconfig-x/config' }));
    expect(at(args, '--ro-bind', '/home/me/repo/.git', '/home/me/repo/.git')).toBeLessThan(
      at(args, '--ro-bind', '/data/tmp/gitconfig-x/config', '/home/me/repo/.git/config'),
    );
  });

  it('ends with the shell and the command as one argument', () => {
    const args = buildBwrapArgs(input({ command: 'echo "a b" && ls' }));
    expect(args.slice(-4)).toEqual(['--', '/bin/bash', '-c', 'echo "a b" && ls']);
  });
});
