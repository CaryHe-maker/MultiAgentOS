import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import type { SandboxProfile } from '@multiagentos/contracts';

/**
 * Where `bwrap` cannot run (a container without user namespaces, Orchestration D79), a command
 * still writes only where its task may: before the shell starts, a small helper restricts writes
 * with Landlock, which needs no privilege and holds for every process the command starts. Reads
 * are not restricted, as they are not under `UNISOLATED` either. Node cannot make the three
 * system calls itself, so the helper is Python with `ctypes` (no compiler needed); it is passed
 * with `-I -c`, so no file is installed and nothing on the path is imported.
 *
 * Usage: `python3 -I -c SOURCE --probe` prints the Landlock ABI (0 when there is none) and the
 * interpreter's absolute path;
 * `python3 -I -c SOURCE DIR... -- SHELL ARG...` restricts writes to the DIRs and runs the shell
 * in the same process (same pid, so signals and the process group are unchanged). When the
 * restriction cannot be set up the command does not run (exit 126), never without it.
 */
const LANDLOCK_EXEC_SOURCE = `
import ctypes, os, struct, sys
libc = ctypes.CDLL(None, use_errno=True)
CREATE, ADD, RESTRICT = 444, 445, 446
abi = libc.syscall(CREATE, None, 0, 1)
if sys.argv[1:] == ['--probe']:
    print(abi if abi > 0 else 0, sys.executable)
    sys.exit(0)
def fail(why):
    sys.stderr.write('could not restrict where this command writes (%s); it did not run\\n' % why)
    sys.exit(126)
if abi < 1:
    fail('Landlock is not available')
args = sys.argv[1:]
cut = args.index('--')
dirs, command = args[:cut], args[cut + 1:]
rights = (1 << 1) | sum(1 << n for n in range(4, 13))
if abi >= 2:
    rights |= 1 << 13
if abi >= 3:
    rights |= 1 << 14
attr = struct.pack('Q', rights)
ruleset = libc.syscall(CREATE, ctypes.c_char_p(attr), len(attr), 0)
if ruleset < 0:
    fail('ruleset, errno %d' % ctypes.get_errno())
for path in dirs:
    try:
        fd = os.open(path, os.O_PATH | os.O_DIRECTORY)
    except OSError:
        continue
    rule = struct.pack('=Qi', rights, fd)
    if libc.syscall(ADD, ruleset, 1, ctypes.c_char_p(rule), 0) < 0:
        fail('rule for %s, errno %d' % (path, ctypes.get_errno()))
    os.close(fd)
if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.syscall(RESTRICT, ruleset, 0) != 0:
    fail('restrict, errno %d' % ctypes.get_errno())
os.close(ruleset)
os.execv(command[0], command)
`;

/** The Python that runs the helper, when Landlock works with it here; probed once. */
export function probeLandlock(python = 'python3'): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const probe = spawnSync(python, ['-I', '-c', LANDLOCK_EXEC_SOURCE, '--probe'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    // The interpreter by its absolute path: a command's environment may not have it on its path.
    const [abi = '0', executable = ''] = probe.stdout.trim().split(' ');
    return probe.status === 0 && Number(abi) > 0 && executable.startsWith('/')
      ? executable
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directories an unisolated command may write: its task's write roots that exist (one not
 * created yet is not writable by a command, as under `bwrap`), the system's temporary
 * directories, `/dev` (for `/dev/null` and the terminal), and the caches tools keep in the home.
 */
export function landlockWritable(profile: SandboxProfile, home: string): string[] {
  const roots = profile.writableRoots.map((root) =>
    root === '.' || root === '' ? profile.repositoryRoot : posix.join(profile.repositoryRoot, root),
  );
  // Landlock only allows: a directory that holds the repository would open all of it, so a
  // temporary directory the repository lives in is left out (the write roots still hold).
  const holdsRepository = (path: string) =>
    profile.repositoryRoot === path || profile.repositoryRoot.startsWith(`${path}/`);
  const system = [
    '/tmp',
    '/var/tmp',
    '/dev',
    posix.join(home, '.cache'),
    posix.join(home, '.npm'),
  ].filter((path) => !holdsRepository(path));
  return [...roots, ...system].filter((path) => existsSync(path));
}

/** The argument vector that runs `shell -c command` with writes restricted to `writable`. */
export function landlockArgs(
  python: string,
  writable: readonly string[],
  shell: string,
  command: string,
): { readonly file: string; readonly args: string[] } {
  return {
    file: python,
    args: ['-I', '-c', LANDLOCK_EXEC_SOURCE, ...writable, '--', shell, '-c', command],
  };
}
