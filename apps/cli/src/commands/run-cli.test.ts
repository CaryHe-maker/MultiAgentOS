import type { AnalyzeCommand } from '@multiagentos/user-interaction';
import { describe, expect, it } from 'vitest';
import { parseCli, runCli } from './run-cli.js';

function harness(exitCode = 0) {
  const commands: AnalyzeCommand[] = [];
  const written: string[] = [];
  return {
    commands,
    written,
    target: {
      analyze: (command: AnalyzeCommand) => {
        commands.push(command);
        return Promise.resolve(exitCode);
      },
    },
    terminal: { write: (text: string) => written.push(text) },
  };
}
const absolute = process.platform === 'win32' ? 'C:\\repo' : '/repo';

describe('runCli', () => {
  it('returns a validated command without running it', async () => {
    const { terminal } = harness();
    expect(await parseCli(['analyze', '--repo', absolute, 'Explain X'], terminal)).toEqual({
      ok: true,
      command: { goal: 'Explain X', repositoryPath: absolute, details: false },
    });
    expect(await parseCli(['analyze', '--repo', 'relative', 'Explain X'], terminal)).toEqual({
      ok: false,
      exitCode: 64,
    });
  });

  it('passes the analyze command on and returns its exit code', async () => {
    const { commands, target, terminal } = harness(3);
    const code = await runCli(
      ['analyze', '--repo', absolute, '--details', 'Explain X'],
      target,
      terminal,
    );
    expect(code).toBe(3);
    expect(commands).toEqual([{ goal: 'Explain X', repositoryPath: absolute, details: true }]);
  });

  it('defaults --details to false', async () => {
    const { commands, target, terminal } = harness();
    await runCli(['analyze', '--repo', absolute, 'Explain X'], target, terminal);
    expect(commands[0]?.details).toBe(false);
  });

  it('rejects missing arguments and relative paths before calling analyze', async () => {
    for (const argv of [
      ['analyze', '--repo', absolute],
      ['analyze', 'Explain X'],
      ['analyze', '--repo', 'relative/path', 'Explain X'],
      ['unknown'],
    ]) {
      const { commands, target, terminal } = harness();
      expect(await runCli(argv, target, terminal)).toBe(64);
      expect(commands).toEqual([]);
    }
  });

  it.each([[], ['--help'], ['analyze', '--help']].map((argv) => ({ argv })))(
    'shows Chinese help for $argv',
    async ({ argv }) => {
      const test = harness();
      await parseCli(argv, test.terminal);
      expect(test.written.join('')).toContain('用法');
      expect(test.written.join('')).not.toMatch(/Usage:|Options:|Commands:|Analyse a repository/u);
      expect(test.commands).toEqual([]);
    },
  );

  it.each(
    [
      ['unknown'],
      ['analyze', '--unknown'],
      ['analyze', '--repo', absolute],
      ['analyze', '--repo', 'relative', '分析仓库'],
    ].map((argv) => ({ argv })),
  )('shows Chinese validation errors for $argv', async ({ argv }) => {
    const test = harness();
    expect(await runCli(argv, test.target, test.terminal)).toBe(64);
    expect(test.written.join('')).toMatch(/[\u4e00-\u9fff]/u);
    expect(test.written.join('')).not.toMatch(/error:|required|unknown command|must be/u);
    expect(test.commands).toEqual([]);
  });
});
