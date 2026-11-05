import { beforeAll, describe, expect, it } from 'vitest';
import { createCommandAnalyzer } from './command-analyzer.js';
import { createCommandParser } from './parse/command-parser.js';

let analyze: ReturnType<typeof createCommandAnalyzer>;
beforeAll(async () => {
  analyze = createCommandAnalyzer(await createCommandParser(), {
    deniedCommands: ['rm -rf /'],
    criticalCommands: ['kubectl apply'],
  });
});

describe('createCommandAnalyzer', () => {
  it('keeps the line as written and splits it into simple commands with prefixes', () => {
    const result = analyze('npm   run build && git status');
    expect(result.text).toBe('npm   run build && git status');
    expect(result.subcommands).toEqual([
      { text: 'npm run build', words: ['npm', 'run', 'build'], prefix: 'npm run' },
      { text: 'git status', words: ['git', 'status'], prefix: 'git status' },
    ]);
    expect(result.unreusable).toEqual([]);
    expect(result.denied).toBeUndefined();
    expect(result.critical).toBeUndefined();
  });

  it('finds the default critical commands and the ones that were added', () => {
    expect(analyze('git push origin main').critical).toBe('git push');
    expect(analyze('gh pr create').critical).toBe('gh');
    expect(analyze('kubectl apply -f x.yaml').critical).toBe('kubectl apply');
  });

  it('cannot be talked out of a critical command by wrapping it', () => {
    expect(analyze('env git push').critical).toBe('git push');
    expect(analyze('echo hi; (git push)').critical).toBe('git push');
  });

  it('finds a denied command, also when the tree is broken', () => {
    expect(analyze('rm -rf /').denied).toBe('rm -rf /');
    expect(analyze('echo "x; rm -rf /').denied).toBe('rm -rf /');
  });

  it('says why a line cannot be allowed from now on', () => {
    expect(analyze('echo $(date)').unreusable).toContain('COMMAND_SUBSTITUTION');
  });
});
