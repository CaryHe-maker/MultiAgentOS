import {
  approvalDigestOf,
  type SandboxProfile,
  type SandboxRunner,
  type SubprocessRunner,
} from '@multiagentos/contracts';

/**
 * `git` for GIT_INSPECT runs in the same sandbox as a command (M2Design 8.1): the repository
 * read-only, no network, no home. A repository that was cloned from elsewhere can carry filter
 * or helper settings in `.git/config`; they run, if at all, inside the sandbox and cannot write.
 * Where no sandbox can start, the plain runner is used, with the same fixed flags as before.
 */
const GIT_TIMEOUT_MS = 120_000;

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** `NAME=value ... git args`; names are the fixed ones of the executor, values are quoted. */
function commandLine(
  args: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
): string {
  const assignments = Object.entries(env ?? {})
    .filter(([name]) => /^[A-Z][A-Z0-9_]*$/u.test(name))
    .map(([name, value]) => `${name}=${quote(value)}`);
  return [...assignments, 'git', ...args.map(quote)].join(' ');
}

export function createSandboxedGit(
  plain: SubprocessRunner,
  sandbox: SandboxRunner,
  repositoryRoot: string,
): SubprocessRunner {
  return {
    run: async (command, args, options) => {
      if (command !== 'git' || options.cwd !== repositoryRoot || options.stdin !== undefined)
        return plain.run(command, args, options);
      const line = `${commandLine(args, options.env)} 2>/dev/null`;
      const profile: SandboxProfile = {
        repositoryRoot,
        workdir: '',
        writableRoots: [],
        network: false,
        homeReadOnly: [],
        homeMaskedFiles: [],
        maskedFiles: [],
        maskedDirs: [],
        protectedExisting: [],
      };
      const result = await sandbox.run({
        scope: {
          kind: 'SANDBOX',
          backend: 'BWRAP',
          profile,
          approvalDigest: approvalDigestOf({
            command: line,
            workdir: '',
            network: false,
            writableRoots: [],
            backend: 'BWRAP',
          }),
        },
        // Standard error would mix into the diff; the exit code says whether it worked.
        command: line,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: options.maxOutputBytes,
        signal: options.signal,
      });
      if (result.kind === 'REFUSED') {
        if (result.reason === 'SANDBOX_UNAVAILABLE') return plain.run(command, args, options);
        return { exitCode: null, signal: null, stdout: '', truncated: false };
      }
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.output,
        truncated: result.truncated,
      };
    },
  };
}
