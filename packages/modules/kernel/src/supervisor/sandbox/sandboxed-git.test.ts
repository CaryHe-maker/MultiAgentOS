import { describe, expect, it } from 'vitest';
import {
  approvalDigestOf,
  type SandboxRunner,
  type SubprocessRunner,
} from '@multiagentos/contracts';
import { createSandboxedGit } from './sandboxed-git.js';

const root = '/repo';
const signal = new AbortController().signal;
const options = {
  cwd: root,
  signal,
  maxOutputBytes: 1000,
  env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_PAGER: 'cat' },
};

const plain = (log: string[]): SubprocessRunner => ({
  run: (_command, args) => {
    log.push(`plain ${args.join(' ')}`);
    return Promise.resolve({ exitCode: 0, signal: null, stdout: 'plain', truncated: false });
  },
});

describe('git in the sandbox', () => {
  it('runs read-only, without the network, with an approval digest that matches the command', async () => {
    const seen: Parameters<SandboxRunner['run']>[0][] = [];
    const sandbox: SandboxRunner = {
      run: (request) => {
        seen.push(request);
        return Promise.resolve({
          kind: 'RAN',
          exitCode: 0,
          signal: null,
          output: 'ok',
          truncated: false,
          timedOut: false,
          denials: 0,
          backend: 'BWRAP',
        });
      },
    };
    const git = createSandboxedGit(plain([]), sandbox, root);
    const result = await git.run('git', ['log', "it's", '--', 'a b'], options);
    expect(result).toEqual({ exitCode: 0, signal: null, stdout: 'ok', truncated: false });
    const [request] = seen;
    expect(request?.command).toBe(
      `GIT_CONFIG_GLOBAL='/dev/null' GIT_PAGER='cat' git 'log' 'it'\\''s' '--' 'a b' 2>/dev/null`,
    );
    expect(request?.scope.profile).toMatchObject({
      repositoryRoot: root,
      writableRoots: [],
      network: false,
    });
    expect(request?.scope.approvalDigest).toBe(
      approvalDigestOf({
        command: request?.command ?? '',
        workdir: '',
        network: false,
        writableRoots: [],
        backend: 'BWRAP',
      }),
    );
  });

  it('falls back to the plain runner only where no sandbox can start', async () => {
    const log: string[] = [];
    const unavailable: SandboxRunner = {
      run: () => Promise.resolve({ kind: 'REFUSED', reason: 'SANDBOX_UNAVAILABLE' }),
    };
    const git = createSandboxedGit(plain(log), unavailable, root);
    expect((await git.run('git', ['status'], options)).stdout).toBe('plain');
    expect(log).toEqual(['plain status']);
  });

  it('does not fall back when the sandbox refused for another reason', async () => {
    const log: string[] = [];
    const refused: SandboxRunner = {
      run: () => Promise.resolve({ kind: 'REFUSED', reason: 'APPROVAL_MISMATCH' }),
    };
    const git = createSandboxedGit(plain(log), refused, root);
    expect(await git.run('git', ['status'], options)).toMatchObject({ exitCode: null });
    expect(log).toEqual([]);
  });

  it('leaves another directory and another program to the plain runner', async () => {
    const log: string[] = [];
    const never: SandboxRunner = {
      run: () => Promise.reject(new Error('not used')),
    };
    const git = createSandboxedGit(plain(log), never, root);
    await git.run('git', ['status'], { ...options, cwd: '/elsewhere' });
    await git.run('rg', ['x'], options);
    expect(log).toEqual(['plain status', 'plain x']);
  });
});
