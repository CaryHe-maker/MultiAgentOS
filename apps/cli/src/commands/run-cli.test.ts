import type { AnalyzeCommand } from '@multiagentos/user-interaction';
import { describe, expect, it } from 'vitest';
import { runCli } from './run-cli.js';

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

  it('rejects a missing goal, a missing --repo and a relative path without calling analyze', async () => {
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
});
