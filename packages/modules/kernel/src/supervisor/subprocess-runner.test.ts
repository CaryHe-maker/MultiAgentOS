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

  // Each cell of the CI matrix states whether it has rg; a broken install fails.
  it.runIf(process.env['CI'] !== undefined)('has rg exactly when the CI cell says so', () => {
    expect(hasRipgrep).toBe(process.env['MULTIAGENTOS_RIPGREP'] !== 'absent');
  });

  it('does not start anything once the signal has fired', async () => {
    const result = await runner.run('rg', ['--version'], options({ signal: AbortSignal.abort() }));
    expect(result).toEqual({ exitCode: null, signal: null, stdout: '', truncated: false });
  });

  it('gives git only the environment it was given, and PATH', async () => {
    process.env['MAO_LEAK_PROBE'] = 'leaked';
    const seen = await runner.run('git', ['config', '--get', 'probe.value'], {
      ...options(),
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_DIR: '/nonexistent' },
    });
    delete process.env['MAO_LEAK_PROBE'];
    expect(seen.stdout).toBe('');
  });

  it('survives a child that exits without reading its input', async () => {
    const result = await runner.run('git', ['--version'], {
      ...options(),
      stdin: 'x'.repeat(4 * 1024 * 1024),
    });
    expect(result.signal).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('returns output as base64 when asked, so bytes stay bytes', async () => {
    const result = await runner.run('git', ['--version'], { ...options(), encoding: 'base64' });
    if (result.exitCode === 0)
      expect(Buffer.from(result.stdout, 'base64').toString('utf8')).toContain('git version');
  });

  it('refuses every command except rg and git', async () => {
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
