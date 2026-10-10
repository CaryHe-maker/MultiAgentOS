import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createSubprocessRunner } from './subprocess-runner.js';

const runner = createSubprocessRunner();
const options = (overrides: { signal?: AbortSignal; maxOutputBytes?: number } = {}) => ({
  cwd: tmpdir(),
  signal: new AbortController().signal,
  maxOutputBytes: 65_536,
  ...overrides,
});
/** `rg` is optional on a development machine; each test states what holds either way. */
const version = await runner.run('rg', ['--version'], options());
const hasRipgrep = version.exitCode === 0;

describe('SubprocessRunner', () => {
  it('runs rg, or reports a missing binary without throwing', () => {
    if (hasRipgrep) expect(version.stdout).toContain('ripgrep');
    else expect(version).toEqual({ exitCode: null, signal: null, stdout: '', truncated: false });
  });

  it('does not start anything once the signal has fired', async () => {
    const result = await runner.run('rg', ['--version'], options({ signal: AbortSignal.abort() }));
    expect(result).toEqual({ exitCode: null, signal: null, stdout: '', truncated: false });
  });

  it('refuses every command except rg', async () => {
    const result = await runner.run('node' as 'rg', ['--version'], options());
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe('');
  });

  it('stops at maxOutputBytes and says so', async () => {
    const result = await runner.run('rg', ['--version'], options({ maxOutputBytes: 4 }));
    if (!hasRipgrep) return;
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(4);
  });

  it('passes arguments as an array, never through a shell', async () => {
    const result = await runner.run('rg', ['--version; echo injected'], options());
    expect(result.stdout).not.toContain('injected');
    if (hasRipgrep) expect(result.exitCode).not.toBe(0);
  });
});
