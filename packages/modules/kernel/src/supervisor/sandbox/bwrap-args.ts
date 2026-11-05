import { posix } from 'node:path';
import type { SandboxProfile } from '@multiagentos/contracts';

/**
 * The `bwrap` arguments of a SandboxProfile (M2Design 6.1). A pure function: the order matters
 * because a later mount lands on top of an earlier one, and the tests assert it item by item.
 *
 *   1. new PID, IPC and UTS namespaces, die with the parent, new session, status fd, no network unless approved
 *   2. the root read-only, then /dev and /proc
 *   3. /run, /mnt and /media emptied (the repository comes back in 5), $HOME hidden by an empty
 *      tmpfs, /tmp private and of limited size (before the repository: it may live in /tmp)
 *   4. the tool chains under $HOME back, read-only, and their credential files masked
 *   5. the repository read-only, the writable roots on top of it
 *   6. what stays read-only inside a writable root, and what is masked
 *   7. the data directory masked when it lies outside $HOME
 *   8. `.git/config` replaced by a copy without credentials (with 6)
 */
export interface BwrapInput {
  readonly profile: SandboxProfile;
  readonly command: string;
  /** The real home directory; it is hidden, and the command's HOME is an empty tmpfs there. */
  readonly home: string;
  /** An existing, empty, regular file that masks files. */
  readonly emptyFile: string;
  /** The status descriptor number given to `spawn`'s stdio. */
  readonly statusFd: number;
  readonly env: Readonly<Record<string, string>>;
  readonly shell?: string;
  /** A copy of `.git/config` without credentials, laid over the real one. */
  readonly gitConfig?: string;
  /** Size of the private /tmp. */
  readonly tmpBytes?: number;
  /** Limits of the command's processes, applied with `prlimit` inside the sandbox. */
  readonly limits?: {
    readonly maxProcesses: number;
    readonly maxFileBytes: number;
    /** Private writable memory (`RLIMIT_DATA`): a command that fills it fails, the system does not. */
    readonly maxDataBytes?: number;
  };
  /** Mounts for paths that do not exist make `bwrap` fail; the caller says which exist. */
  readonly exists: (absolutePath: string) => boolean;
}

/**
 * The host's runtime directory (sockets of docker, the session bus, agents), and the places where
 * other disks appear (in WSL, the Windows drives). A command has no use for them.
 */
const HIDDEN_HOST_DIRECTORIES = ['/run', '/mnt', '/media'] as const;
/** What name resolution needs when the network is shared. */
const RESOLVER_PATHS = ['/run/systemd/resolve', '/mnt/wsl/resolv.conf'] as const;

/** The runner checks that it is there; the command's own PATH is not relied on. */
export const PRLIMIT_PATH = '/usr/bin/prlimit';

const inside = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}/`);

const join = (root: string, relative: string): string =>
  relative === '' || relative === '.' ? root : posix.join(root, relative);

export function buildBwrapArgs(input: BwrapInput): string[] {
  const { profile, home, emptyFile } = input;
  const repo = profile.repositoryRoot;
  const args: string[] = [
    '--unshare-pid',
    // SysV shared memory and queues of the host, and its host name, are not the command's.
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--json-status-fd',
    String(input.statusFd),
  ];
  if (!profile.network) args.push('--unshare-net');

  args.push('--clearenv');
  for (const [name, value] of Object.entries(input.env)) args.push('--setenv', name, value);

  args.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc');
  for (const directory of HIDDEN_HOST_DIRECTORIES)
    if (input.exists(directory)) args.push('--tmpfs', directory);
  if (profile.network)
    for (const path of RESOLVER_PATHS) if (input.exists(path)) args.push('--ro-bind', path, path);
  args.push('--tmpfs', home);
  if (input.tmpBytes !== undefined) args.push('--size', String(input.tmpBytes));
  args.push('--tmpfs', '/tmp');

  for (const directory of profile.homeReadOnly)
    if (input.exists(directory)) args.push('--ro-bind', directory, directory);
  for (const file of profile.homeMaskedFiles)
    if (input.exists(file) && profile.homeReadOnly.some((dir) => inside(dir, file)))
      args.push('--ro-bind', emptyFile, file);

  args.push('--ro-bind', repo, repo);
  for (const root of profile.writableRoots) {
    const absolute = join(repo, root);
    args.push('--bind', absolute, absolute);
  }
  for (const path of profile.protectedExisting) {
    const absolute = join(repo, path);
    if (input.exists(absolute)) args.push('--ro-bind', absolute, absolute);
  }
  const gitConfig = join(repo, '.git/config');
  if (input.gitConfig !== undefined && input.exists(gitConfig))
    args.push('--ro-bind', input.gitConfig, gitConfig);
  for (const file of profile.maskedFiles) {
    const absolute = join(repo, file);
    if (input.exists(absolute)) args.push('--ro-bind', emptyFile, absolute);
  }
  for (const directory of profile.maskedDirs) {
    const absolute = join(repo, directory);
    if (input.exists(absolute)) args.push('--tmpfs', absolute);
  }
  if (
    profile.dataDir !== undefined &&
    !inside(home, profile.dataDir) &&
    input.exists(profile.dataDir)
  )
    args.push('--tmpfs', profile.dataDir);

  args.push('--chdir', join(repo, profile.workdir));
  args.push('--');
  if (input.limits !== undefined)
    args.push(
      PRLIMIT_PATH,
      `--nproc=${String(input.limits.maxProcesses)}`,
      `--fsize=${String(input.limits.maxFileBytes)}`,
      ...(input.limits.maxDataBytes === undefined
        ? []
        : [`--data=${String(input.limits.maxDataBytes)}`]),
      '--',
    );
  args.push(input.shell ?? '/bin/bash', '-c', input.command);
  return args;
}
