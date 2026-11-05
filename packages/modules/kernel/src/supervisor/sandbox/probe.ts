import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDigestOf, type SandboxProfile } from '@multiagentos/contracts';
import { createSandboxRunner } from './sandbox-runner.js';

/**
 * Whether commands can run isolated here (M2Design 6.2). It runs `true` under the real profile
 * once; looking for the `bwrap` binary alone is not a probe. The answer is written to the audit
 * and decides what `sandbox.unavailable` does for the whole Session.
 */
export type SandboxProbe =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: 'NO_BWRAP' | 'USERNS_DENIED' | 'PROFILE_FAILED';
      /** What the user can do about it; the usage notes carry the full steps. */
      readonly hint: string;
    };

const APPARMOR_HINT =
  'Ubuntu 23.10+ restricts unprivileged user namespaces. Add an AppArmor profile for /usr/bin/bwrap (see the usage notes), or set kernel.apparmor_restrict_unprivileged_userns=0.';

export async function probeSandbox(
  repositoryRoot: string,
  options: { readonly bwrapPath?: string } = {},
): Promise<SandboxProbe> {
  const bwrapPath = options.bwrapPath ?? 'bwrap';
  if (process.platform !== 'linux')
    return {
      available: false,
      reason: 'NO_BWRAP',
      hint: 'Commands are isolated with bubblewrap, which needs Linux (Ubuntu 24.04 or WSL).',
    };
  if (spawnSync(bwrapPath, ['--version'], { stdio: 'ignore' }).status !== 0)
    return {
      available: false,
      reason: 'NO_BWRAP',
      hint: 'Install bubblewrap (apt install bubblewrap).',
    };

  const base = mkdtempSync(join(tmpdir(), 'mas-probe-'));
  try {
    const emptyFile = join(base, 'empty');
    writeFileSync(emptyFile, '');
    const profile: SandboxProfile = {
      repositoryRoot,
      workdir: '',
      writableRoots: ['.'],
      network: false,
      homeReadOnly: [],
      homeMaskedFiles: [],
      maskedFiles: [],
      maskedDirs: [],
      protectedExisting: [],
    };
    const runner = createSandboxRunner({
      emptyFile,
      cancelGraceMs: 1_000,
      killGraceMs: 1_000,
      home: homedir(),
      bwrapPath,
    });
    const result = await runner.run({
      scope: {
        kind: 'SANDBOX',
        backend: 'BWRAP',
        profile,
        approvalDigest: approvalDigestOf({
          command: 'true',
          workdir: '',
          network: false,
          writableRoots: ['.'],
          backend: 'BWRAP',
        }),
      },
      command: 'true',
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
      signal: new AbortController().signal,
    });
    if (result.kind === 'RAN' && result.exitCode === 0) return { available: true };
    const text = result.kind === 'RAN' ? result.output : '';
    return /RTM_NEWADDR|Operation not permitted|user namespace|setting up uid map/iu.test(text)
      ? { available: false, reason: 'USERNS_DENIED', hint: APPARMOR_HINT }
      : {
          available: false,
          reason: 'PROFILE_FAILED',
          hint: 'bubblewrap is installed but the sandbox profile could not start.',
        };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
