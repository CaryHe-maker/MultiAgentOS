import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { release } from 'node:os';
import { dirname, join, posix } from 'node:path';
import {
  StopUnconfirmedError,
  approvalDigestOf,
  buildSandboxEnvironment,
  countSandboxDenials,
  type SandboxRefusal,
  type SandboxRunResult,
  type SandboxRunner,
  type SandboxScope,
} from '@multiagentos/contracts';
import { buildBwrapArgs } from './bwrap-args.js';
import { sanitizeGitConfig } from './git-config.js';

/**
 * Starts a command in `bwrap` and ends it (M2Design 4.7, 6.1; Kernel/Supervisor 5). It checks
 * again, before it starts anything, that what runs is what the user approved. The process is a
 * session leader inside its own PID namespace: SIGTERM goes to the group `bwrap` reports as
 * `child-pid`, SIGKILL to the outer group, which ends the namespace and everything in it.
 */
export interface SandboxRunnerDeps {
  /** An existing empty regular file to mask files with. */
  readonly emptyFile: string;
  readonly cancelGraceMs: number;
  readonly killGraceMs: number;
  /** The real home directory; it is hidden from the command. */
  readonly home: string;
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly bwrapPath?: string;
  readonly shell?: string;
  readonly now?: () => number;
  /** Size of the private /tmp of a command; default 512 MiB. */
  readonly tmpBytes?: number;
  /** Processes a command may add to what the user already runs; default 2048. */
  readonly maxProcesses?: number;
  /** Size of the biggest file a command may write; default 2 GiB. */
  readonly maxFileBytes?: number;
}

export interface TrackedSandboxRunner extends SandboxRunner {
  /** Ends every live command at once; synchronous and safe to repeat. */
  killAll(): void;
  /** Number of commands still running. */
  active(): number;
}

const STATUS_FD = 3;
const PRLIMIT = '/usr/bin/prlimit';

/**
 * Since Linux 5.14 the process limit counts the processes of the user namespace `bwrap` makes;
 * before, it counted every process of the user, so the user's other processes are added.
 */
function countsPerNamespace(): boolean {
  const [major = 0, minor = 0] = release()
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  return major > 5 || (major === 5 && minor >= 14);
}

/** Processes of the current user, anywhere: the limit counts all of them, not the command's. */
function userProcesses(): number {
  const uid = process.getuid?.();
  let count = 0;
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/u.test(name)) continue;
      try {
        if (statSync(`/proc/${name}`).uid === uid) count += 1;
      } catch {
        // Gone while counting.
      }
    }
  } catch {
    return 1_000;
  }
  return count;
}

/** The credential-free copy of `.git/config` for one command, and how to remove it. */
function gitConfigCopy(
  repositoryRoot: string,
  directory: string,
): { path: string; remove: () => void } | undefined {
  try {
    const text = readFileSync(posix.join(repositoryRoot, '.git/config'), 'utf8');
    const folder = mkdtempSync(join(directory, 'gitconfig-'));
    const path = join(folder, 'config');
    writeFileSync(path, sanitizeGitConfig(text), { mode: 0o644 });
    return { path, remove: () => rmSync(folder, { recursive: true, force: true }) };
  } catch {
    return undefined;
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Why a workdir or write root cannot be used: it must be a real directory inside the repository. */
function insideRepository(root: string, relative: string): string | undefined {
  const absolute = relative === '' || relative === '.' ? root : posix.join(root, relative);
  try {
    const real = realpathSync(absolute);
    return real === root || real.startsWith(`${root}/`) ? real : undefined;
  } catch {
    return undefined;
  }
}

function checkBeforeStart(scope: SandboxScope, command: string): SandboxRefusal | undefined {
  const { profile } = scope;
  const digest = approvalDigestOf({
    command,
    workdir: profile.workdir,
    network: profile.network,
    writableRoots: profile.writableRoots,
    backend: scope.backend,
  });
  if (digest !== scope.approvalDigest) return 'APPROVAL_MISMATCH';
  let root: string;
  try {
    root = realpathSync(profile.repositoryRoot);
  } catch {
    return 'WORKDIR_INVALID';
  }
  if (root !== profile.repositoryRoot) return 'WORKDIR_INVALID';
  const workdir = insideRepository(root, profile.workdir);
  if (workdir === undefined || !isDirectory(workdir)) return 'WORKDIR_INVALID';
  for (const writable of profile.writableRoots) {
    const absolute = writable === '.' ? root : posix.join(root, writable);
    // A write root that is a link would let the bind land somewhere else.
    if (insideRepository(root, writable) !== absolute) return 'WORKDIR_INVALID';
  }
  return undefined;
}

export function createSandboxRunner(deps: SandboxRunnerDeps): TrackedSandboxRunner {
  const live = new Set<ChildProcess>();
  const hostEnv = deps.hostEnv ?? process.env;
  const bwrap = deps.bwrapPath ?? 'bwrap';

  const run: SandboxRunner['run'] = (options) =>
    new Promise<SandboxRunResult>((resolve, reject) => {
      const { scope, command, signal } = options;
      if (process.platform === 'win32') {
        resolve({ kind: 'REFUSED', reason: 'SANDBOX_UNAVAILABLE' });
        return;
      }
      const refusal = checkBeforeStart(scope, command);
      if (refusal !== undefined) {
        resolve({ kind: 'REFUSED', reason: refusal });
        return;
      }
      const environment = buildSandboxEnvironment(hostEnv, deps.home);
      if (!environment.ok) {
        resolve({ kind: 'REFUSED', reason: 'ENV_ASSERTION_FAILED' });
        return;
      }
      if (signal.aborted) {
        resolve(ranNothing(scope));
        return;
      }
      // `UNISOLATED` is what the user approved when the sandbox is not available: the same shell,
      // the same whitelisted environment and the same work directory, but no isolation.
      const unisolated = scope.backend === 'UNISOLATED';
      const gitConfig = unisolated
        ? undefined
        : gitConfigCopy(scope.profile.repositoryRoot, dirname(deps.emptyFile));
      const args = buildBwrapArgs({
        tmpBytes: deps.tmpBytes ?? 512 * 1024 * 1024,
        ...(existsSync(PRLIMIT)
          ? {
              limits: {
                maxProcesses:
                  (deps.maxProcesses ?? 2048) + (countsPerNamespace() ? 0 : userProcesses()),
                maxFileBytes: deps.maxFileBytes ?? 2 * 1024 * 1024 * 1024,
              },
            }
          : {}),
        ...(gitConfig === undefined ? {} : { gitConfig: gitConfig.path }),
        profile: scope.profile,
        command,
        home: deps.home,
        emptyFile: deps.emptyFile,
        statusFd: STATUS_FD,
        env: environment.env,
        ...(deps.shell === undefined ? {} : { shell: deps.shell }),
        exists: existsSync,
      });
      let child: ChildProcess;
      try {
        child = unisolated
          ? spawn(deps.shell ?? '/bin/bash', ['-c', command], {
              cwd: workdirOf(scope),
              detached: true,
              shell: false,
              windowsHide: true,
              env: environment.env,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          : spawn(bwrap, args, {
              detached: true,
              shell: false,
              windowsHide: true,
              env: {},
              stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
            });
      } catch {
        gitConfig?.remove();
        resolve({ kind: 'REFUSED', reason: 'SANDBOX_UNAVAILABLE' });
        return;
      }
      live.add(child);

      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let innerPid: number | undefined = unisolated ? child.pid : undefined;
      let timedOut = false;
      let stopRequested = false;
      let exited = false;
      let started = false;
      let settled = false;
      const timers: NodeJS.Timeout[] = [];

      const capture = (chunk: Buffer) => {
        started = true;
        const room = options.maxOutputBytes - size;
        if (chunk.byteLength > room) {
          truncated = true;
          if (room > 0) chunks.push(chunk.subarray(0, room));
          size = options.maxOutputBytes;
          return;
        }
        chunks.push(chunk);
        size += chunk.byteLength;
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      let status = '';
      child.stdio[STATUS_FD]?.on('data', (chunk: Buffer) => {
        status = (status + chunk.toString('utf8')).slice(-512);
        const match = /"child-pid"\s*:\s*(\d+)/u.exec(status);
        if (match?.[1] !== undefined) innerPid = Number(match[1]);
      });

      const sendGroup = (pid: number | undefined, kill: NodeJS.Signals) => {
        if (pid === undefined) return;
        try {
          process.kill(-pid, kill);
        } catch {
          // Already gone.
        }
      };
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        gitConfig?.remove();
        live.delete(child);
        finish();
      };
      const output = () => Buffer.concat(chunks).toString('utf8');

      /** SIGTERM to the command's own group, SIGKILL to the outer group, then wait for the exit. */
      function stop(): void {
        if (stopRequested || exited) return;
        stopRequested = true;
        sendGroup(innerPid, 'SIGTERM');
        if (innerPid === undefined) child.kill('SIGTERM');
        timers.push(
          setTimeout(() => {
            if (exited) return;
            sendGroup(child.pid, 'SIGKILL');
            child.kill('SIGKILL');
            timers.push(
              setTimeout(() => {
                if (exited) return;
                settle(() => reject(new StopUnconfirmedError(child.pid)));
              }, deps.killGraceMs),
            );
          }, deps.cancelGraceMs),
        );
      }

      signal.addEventListener('abort', stop, { once: true });
      timers.push(
        setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeoutMs),
      );

      child.on('error', () => {
        exited = true;
        settle(() => resolve({ kind: 'REFUSED', reason: 'SANDBOX_UNAVAILABLE' }));
      });
      child.on('close', (exitCode, exitSignal) => {
        exited = true;
        settle(() => {
          const text = output();
          // bwrap itself failing to set up its namespaces says so before the command prints.
          if (
            !unisolated &&
            !started &&
            exitCode === 1 &&
            /bwrap: /u.test(text) &&
            innerPid === undefined
          ) {
            resolve({ kind: 'REFUSED', reason: 'SANDBOX_UNAVAILABLE' });
            return;
          }
          resolve({
            kind: 'RAN',
            exitCode,
            signal: exitSignal,
            output: text,
            truncated,
            timedOut,
            denials: countSandboxDenials(text),
            backend: scope.backend,
          });
        });
      });
    });

  return {
    run,
    killAll: () => {
      for (const child of live) {
        if (child.pid !== undefined)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
      }
    },
    active: () => live.size,
  };
}

const workdirOf = (scope: SandboxScope): string =>
  scope.profile.workdir === '' || scope.profile.workdir === '.'
    ? scope.profile.repositoryRoot
    : posix.join(scope.profile.repositoryRoot, scope.profile.workdir);

function ranNothing(scope: SandboxScope): SandboxRunResult {
  return {
    kind: 'RAN',
    exitCode: null,
    signal: 'SIGTERM',
    output: '',
    truncated: false,
    timedOut: false,
    denials: 0,
    backend: scope.backend,
  };
}
