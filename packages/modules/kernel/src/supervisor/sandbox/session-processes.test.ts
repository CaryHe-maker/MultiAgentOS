import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDigestOf, type SandboxScope } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { createSandboxRunner } from './sandbox-runner.js';
import { sessionMembers, statFields } from './session-processes.js';

describe('the processes of a session (D84)', () => {
  it('reads state and session after the name, whatever the name holds', () => {
    expect(statFields('4242 (python3) S 1 4240 4200 0 -1 4194560 ...')).toEqual({
      state: 'S',
      session: 4200,
    });
    expect(statFields('77 (a (weird) name) Z 1 77 70 0')).toEqual({ state: 'Z', session: 70 });
    expect(statFields('garbage')).toBeUndefined();
  });

  it('lists the live members of a session and leaves out zombies', () => {
    const proc = mkdtempSync(join(tmpdir(), 'proc-'));
    try {
      const put = (pid: number, stat: string) => {
        mkdirSync(join(proc, String(pid)));
        writeFileSync(join(proc, String(pid), 'stat'), stat);
      };
      put(10, '10 (bash) S 1 10 10 0');
      put(11, '11 (timeout) S 10 11 10 0');
      put(12, '12 (python3) R 11 11 10 0');
      put(13, '13 (tail) Z 1 10 10 0');
      put(20, '20 (other) S 1 20 20 0');
      expect(sessionMembers(10, proc).sort()).toEqual([10, 11, 12]);
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'linux')('stopping an unisolated command (D84)', () => {
  it('ends the program under timeout, which runs in a group of its own, at once', async () => {
    const base = realpathSync(mkdtempSync(join(homedir(), '.session-test-')));
    try {
      const repo = join(base, 'repo');
      mkdirSync(repo);
      const emptyFile = join(base, 'empty');
      writeFileSync(emptyFile, '');
      // `timeout` puts sleep in a new process group; a signal to the group of bash misses it.
      const command = 'timeout 60 sleep 61; echo after';
      const scope: SandboxScope = {
        kind: 'SANDBOX',
        backend: 'UNISOLATED',
        profile: {
          repositoryRoot: repo,
          workdir: '',
          writableRoots: ['.'],
          network: false,
          homeReadOnly: [],
          homeMaskedFiles: [],
          maskedFiles: [],
          maskedDirs: [],
          protectedExisting: [],
        },
        approvalDigest: approvalDigestOf({
          command,
          workdir: '',
          network: false,
          writableRoots: ['.'],
          backend: 'UNISOLATED',
        }),
      };
      const runner = createSandboxRunner({
        emptyFile,
        cancelGraceMs: 2_000,
        killGraceMs: 2_000,
        home: base,
        landlock: false,
      });
      const stop = new AbortController();
      setTimeout(() => {
        stop.abort();
      }, 500);
      const started = Date.now();
      const result = await runner.run({
        scope,
        command,
        timeoutMs: 30_000,
        maxOutputBytes: 10_000,
        signal: stop.signal,
      });
      // Ended by the first signal, not after both grace periods, and before sleep's own limit.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result).toMatchObject({ kind: 'RAN' });
      expect(result.kind === 'RAN' && result.output).not.toContain('after');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
