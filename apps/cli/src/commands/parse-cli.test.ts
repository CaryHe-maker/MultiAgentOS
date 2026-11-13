import { describe, expect, it } from 'vitest';
import { EXIT_CODE_USAGE, parseCli } from './parse-cli.js';

async function parse(...argv: string[]) {
  let written = '';
  const result = await parseCli(argv, (text) => void (written += text));
  return { result, written };
}

describe('the options of each command', () => {
  // The program once took `--repo` and `--readonly` from anywhere on the line, so after a
  // subcommand they were dropped and `mas run --repo X` ran on the working directory.
  it('reach `mas run`, before or after the template', async () => {
    for (const argv of [
      ['run', '--repo', '/x', '--readonly', 'analyze', 'goal'],
      ['run', 'analyze', 'goal', '--repo', '/x', '--readonly'],
    ]) {
      const { result } = await parse(...argv);
      expect(result, argv.join(' ')).toEqual({
        ok: true,
        command: {
          kind: 'RUN',
          repo: '/x',
          readonly: true,
          template: 'analyze',
          goal: 'goal',
        },
      });
    }
  });

  it('reach the interactive conversation', async () => {
    const { result } = await parse('--repo', '/x', '--readonly');
    expect(result).toEqual({
      ok: true,
      command: { kind: 'INTERACTIVE', repo: '/x', readonly: true },
    });
  });
});

describe('mas log', () => {
  it('reads its options and says it reads a log, not that it runs a conversation', async () => {
    const { result } = await parse(
      'log',
      '2',
      '--repo',
      '/work',
      '--input',
      '3',
      '--full',
      '--json',
    );
    expect(result).toEqual({
      ok: true,
      command: {
        kind: 'LOG',
        repo: '/work',
        session: '2',
        input: 3,
        full: true,
        json: true,
        list: false,
      },
    });
  });

  it('needs nothing: no session means the latest one', async () => {
    const { result } = await parse('log');
    expect(result).toEqual({
      ok: true,
      command: { kind: 'LOG', full: false, json: false, list: false },
    });
  });

  it('refuses a Turn that is not a positive whole number', async () => {
    for (const turn of ['0', '-1', 'x', '1.5', '1000000']) {
      const { result, written } = await parse('log', '--input', turn);
      expect(result, turn).toEqual({ ok: false, exitCode: EXIT_CODE_USAGE });
      expect(written).toContain('--input 要给一个正整数');
    }
  });
});
