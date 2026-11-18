import { Type, type Static } from 'typebox';
import { canonicalJson, sha256Hex } from './canonical-json.js';
import { closed, text } from './schema-helpers.js';

/**
 * What a command may see and touch (M2Design 6.1; Interface/KernelSupervisor 2). Core computes the
 * part the user is shown; Execution adds the lists it finds by scanning the repository. The
 * Supervisor turns the result into `bwrap` arguments and does not widen it.
 */
export const SandboxProfileSchema = closed(
  {
    repositoryRoot: text(4096),
    /** Relative to the repository root, `''` for the root itself. */
    workdir: Type.String({ maxLength: 1024 }),
    /** Relative, `/`-separated; `.` is the repository root. */
    /** Empty for a read-only run, such as `git_inspect`. */
    writableRoots: Type.Array(text(1024)),
    network: Type.Boolean(),
    /** Absolute directories under `$HOME` that come back read-only. */
    homeReadOnly: Type.Array(text(4096)),
    /** Credential files inside those directories; masked by an empty file. */
    homeMaskedFiles: Type.Array(text(4096)),
    /** Absolute; masked on its own when it lies outside `$HOME`. */
    dataDir: Type.Optional(text(4096)),
    maskedFiles: Type.Array(text(1024)),
    maskedDirs: Type.Array(text(1024)),
    protectedExisting: Type.Array(text(1024)),
  },
  'platform.common.SandboxProfile.v1',
);
export type SandboxProfile = Static<typeof SandboxProfileSchema>;

export const SANDBOX_BACKENDS = ['BWRAP', 'UNISOLATED'] as const;
export type SandboxBackend = (typeof SANDBOX_BACKENDS)[number];

export const SandboxScopeSchema = closed(
  {
    kind: Type.Literal('SANDBOX'),
    backend: Type.Enum(SANDBOX_BACKENDS),
    profile: SandboxProfileSchema,
    approvalDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  'platform.common.SandboxScope.v1',
);
export type SandboxScope = Static<typeof SandboxScopeSchema>;

/** The parts of a command the user was shown and approved (Interface/KernelSupervisor 3). */
export interface ApprovedCommand {
  readonly command: string;
  readonly workdir: string;
  readonly network: boolean;
  readonly writableRoots: readonly string[];
  readonly backend: SandboxBackend;
}

/**
 * Computed by Core when it asks and again by the Supervisor before it starts anything: if the
 * command or the profile was changed in between, the two differ.
 */
export function approvalDigestOf(approved: ApprovedCommand): string {
  return sha256Hex(
    canonicalJson({
      command: approved.command,
      workdir: approved.workdir,
      network: approved.network,
      writableRoots: [...approved.writableRoots],
      backend: approved.backend,
    }),
  );
}

// --- Environment of a command -------------------------------------------------------------------

/** The only variables a command may inherit from the host. */
const ENV_ALLOWED = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'] as const;
/** A name that looks like a secret is never passed, whatever put it there. */
export const SECRET_NAME_PATTERN = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL/iu;

export type SandboxEnvironment =
  | { readonly ok: true; readonly env: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly offending: readonly string[] };

/**
 * Built from a whitelist, then checked: `HOME` is the sandbox's empty home, never the user's. An
 * `extra` variable (for example from a Unit definition) goes through the same check, so a
 * mistake in configuration cannot carry a credential into a command.
 */
export function buildSandboxEnvironment(
  host: Readonly<Record<string, string | undefined>>,
  home: string,
  extra: Readonly<Record<string, string>> = {},
): SandboxEnvironment {
  const env: Record<string, string> = { HOME: home };
  for (const name of ENV_ALLOWED) {
    const value = host[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  env['PATH'] ??= '/usr/local/bin:/usr/bin:/bin';
  env['LANG'] ??= 'C.UTF-8';
  Object.assign(env, extra);
  const offending = Object.keys(env).filter((name) => SECRET_NAME_PATTERN.test(name));
  return offending.length > 0 ? { ok: false, offending } : { ok: true, env };
}

// --- What the sandbox refused ------------------------------------------------------------------

const DENIAL_TEXTS = ['Read-only file system', 'Network is unreachable', 'Could not resolve host'];

/** How many lines of the output say the sandbox, not the command, refused something. */
export function countSandboxDenials(output: string): number {
  let denials = 0;
  for (const line of output.split('\n'))
    if (DENIAL_TEXTS.some((denial) => line.includes(denial))) denials += 1;
  return denials;
}

// --- Toolchains found through PATH -------------------------------------------------------------

/**
 * The directories under `$HOME` that `PATH` names come back into the sandbox read-only
 * (M2Design 6.1, v1.18): a command must find the tools the user's own shell finds, wherever
 * they were installed, without the user listing each place by hand.
 *
 * - A directory named `bin` that belongs to an install prefix deeper than one level below
 *   `$HOME` brings its prefix (`~/.local/opt/node-v24/bin` → `~/.local/opt/node-v24`), because the
 *   tools there reach their libraries through `../lib`. A prefix directly below `$HOME`
 *   (`~/.local`, `~/.cargo`) is never taken as a whole: it holds more than tools.
 * - Never mounted: `$HOME` itself or anything above it, and any directory that holds or equals
 *   something that has to stay hidden (the data directory, the repository, which comes back with
 *   its own rules).
 * - Entries that are relative, empty or outside `$HOME` are not this function's business: the
 *   rest of the system is already visible read-only.
 */
export function pathToolchainMounts(
  pathVariable: string | undefined,
  home: string,
  hidden: readonly string[] = [],
): string[] {
  const mounts = new Set<string>();
  const below = (root: string, path: string): boolean => path.startsWith(`${root}/`);
  const keeps = (path: string): boolean =>
    below(home, path) && !hidden.some((secret) => secret === path || below(path, secret));
  for (const entry of (pathVariable ?? '').split(':')) {
    const directory = entry.replace(/\/+$/u, '');
    if (!directory.startsWith('/') || !below(home, directory) || !keeps(directory)) continue;
    mounts.add(directory);
    const name = directory.slice(directory.lastIndexOf('/') + 1);
    const prefix = directory.slice(0, directory.lastIndexOf('/'));
    const depth = prefix.slice(home.length + 1).split('/').length;
    if (name === 'bin' && below(home, prefix) && depth >= 2 && keeps(prefix)) mounts.add(prefix);
  }
  // A directory inside one that is mounted anyway adds nothing.
  return [...mounts]
    .filter((path) => ![...mounts].some((other) => other !== path && below(other, path)))
    .sort();
}
