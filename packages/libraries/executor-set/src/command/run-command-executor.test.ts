import type { ExecutionScope, SandboxRunner } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { environmentFor } from '../test-support/environments.js';
import { createRunCommandExecutor } from './run-command-executor.js';

const scope: ExecutionScope = {
  kind: 'SANDBOX',
  backend: 'BWRAP',
  approvalDigest: 'a'.repeat(64),
  profile: {
    repositoryRoot: '/repo',
    workdir: '',
    writableRoots: ['.'],
    network: false,
    homeReadOnly: [],
    homeMaskedFiles: [],
    maskedFiles: [],
    maskedDirs: [],
    protectedExisting: [],
  },
};

/** A command that takes `ms` by the clock of the environment. */
const timed = async (ms: number) => {
  let now = 0;
  const sandbox: SandboxRunner = {
    run: () => {
      now += ms;
      return Promise.resolve({
        kind: 'RAN',
        exitCode: 0,
        signal: null,
        output: 'all good\n',
        truncated: false,
        timedOut: false,
        denials: 0,
        backend: 'BWRAP',
      });
    },
  };
  const outcome = await createRunCommandExecutor().execute(
    { command: 'make test', timeoutMs: 120_000 },
    environmentFor('COMMAND', scope, { sandbox, now: () => new Date(now) }),
  );
  if (outcome.outcome !== 'COMPLETED') throw new Error(outcome.outcome);
  const { artifact } = outcome.result as { readonly artifact: { readonly text: string } };
  return artifact.text;
};

describe('run_command results (D70)', () => {
  it('says how long a slow command took, so a check run again and again shows its cost', async () => {
    expect(await timed(42_400)).toMatch(/^exit code 0, took 42 s\n/u);
  });

  it('says nothing of the time of a quick one', async () => {
    expect(await timed(2_000)).toMatch(/^exit code 0\n/u);
  });
});
