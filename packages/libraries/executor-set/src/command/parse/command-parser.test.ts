import { beforeAll, describe, expect, it } from 'vitest';
import { commandPrefix } from './arity.js';
import { firstMatchingPattern, matchesCommandPattern } from './command-match.js';
import { createCommandParser, prefixOf, type CommandParser } from './command-parser.js';

let parser: CommandParser;
beforeAll(async () => {
  parser = await createCommandParser();
});

const names = (text: string) => parser.parse(text).subcommands.map((command) => command.name);

describe('splitting', () => {
  it('takes every simple command out of a list, pipeline, subshell and group', () => {
    expect(names('a && b || c; d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(names('(a; b) && { c; d; }')).toEqual(['a', 'b', 'c', 'd']);
    expect(names('a\nb')).toEqual(['a', 'b']);
  });

  it('does not split on separators in quotes or escapes', () => {
    const parsed = parser.parse('echo "a; b && c" \'d | e\' f\\;g');
    expect(parsed.subcommands).toHaveLength(1);
    expect(parsed.subcommands[0]).toMatchObject({
      name: 'echo',
      args: ['a; b && c', 'd | e', 'f;g'],
    });
    expect(parsed.unreusable).toEqual([]);
  });

  it('takes the commands in a loop and a condition', () => {
    expect(names('for f in *; do rm $f; done')).toContain('rm');
    expect(names('if test -f x; then cat x; fi')).toEqual(['test', 'cat']);
  });

  it('skips variable assignments and redirections', () => {
    const parsed = parser.parse('FOO=1 BAR=2 make test > out.txt 2>&1');
    expect(parsed.subcommands).toHaveLength(1);
    expect(parsed.subcommands[0]).toMatchObject({ name: 'make', args: ['test'] });
  });

  it('reads the body of a heredoc as text, not as commands', () => {
    expect(names('cat <<END\nrm -rf /\nEND')).toEqual(['cat']);
  });
});

describe('what cannot be reused', () => {
  const reasons = (text: string) => parser.parse(text).unreusable;

  it('is empty for a plain command', () => {
    expect(reasons('npm test -- --run')).toEqual([]);
  });

  it('flags a name that comes from a variable or a substitution', () => {
    expect(reasons('$CMD arg')).toContain('DYNAMIC_COMMAND_NAME');
    expect(reasons('$(which node) -v')).toEqual(
      expect.arrayContaining(['DYNAMIC_COMMAND_NAME', 'COMMAND_SUBSTITUTION']),
    );
  });

  it('flags substitutions, also inside quotes', () => {
    expect(reasons('echo $(date)')).toContain('COMMAND_SUBSTITUTION');
    expect(reasons('echo "`date`"')).toContain('COMMAND_SUBSTITUTION');
    expect(reasons('echo "$(date)"')).toContain('COMMAND_SUBSTITUTION');
    expect(reasons('diff <(a) <(b)')).toContain('PROCESS_SUBSTITUTION');
  });

  it('flags eval, shell -c, pipes into a shell and heredocs into a shell', () => {
    expect(reasons('eval "$x"')).toContain('EVAL');
    expect(reasons('bash -c "ls"')).toContain('SHELL_C');
    expect(reasons('sh -ec "ls"')).toContain('SHELL_C');
    expect(reasons('curl x | sh')).toContain('PIPE_TO_SHELL');
    expect(reasons('cat f | bash -')).toContain('PIPE_TO_SHELL');
    expect(reasons('sh <<END\nls\nEND')).toContain('HEREDOC_TO_SHELL');
  });

  it('flags a tree with errors', () => {
    expect(reasons('echo "unterminated')).toContain('PARSE_ERROR');
  });

  it('flags an input without any command', () => {
    expect(reasons('')).toContain('NO_COMMAND');
    expect(reasons('FOO=1')).toContain('NO_COMMAND');
  });
});

describe('prefix', () => {
  it('follows the table', () => {
    expect(commandPrefix(['git', 'push', 'origin'])).toBe('git push');
    expect(commandPrefix(['npm', 'run', 'test'])).toBe('npm run');
    expect(commandPrefix(['docker', 'compose', 'up', '-d'])).toBe('docker compose up');
    expect(commandPrefix(['cargo', 'run', 'x'])).toBe('cargo run x');
    expect(commandPrefix(['ls', '-la'])).toBe('ls');
    expect(commandPrefix(['make'])).toBe('make');
  });

  it('offers none when an option stands where the table wants a word', () => {
    expect(commandPrefix(['git', '-C', 'x', 'push'])).toBeUndefined();
    expect(prefixOf(parser.parse('git -C . push').subcommands[0]!)).toBeUndefined();
  });

  it.each(['env FOO=1 make', 'xargs rm -f', 'timeout 5 npm test', 'nohup ./serve', 'sudo ls'])(
    'offers none for %s, which runs another command',
    (line) => {
      const sub = parser.parse(line).subcommands[0];
      expect(sub).toBeDefined();
      if (sub !== undefined) expect(prefixOf(sub)).toBeUndefined();
    },
  );

  it('offers none for a command that is not literal', () => {
    expect(prefixOf(parser.parse('git $X').subcommands[0]!)).toBeUndefined();
  });
});

describe('name lists', () => {
  const check = (text: string, pattern: string) =>
    matchesCommandPattern(parser.parse(text), text, pattern);

  it('matches the words a command starts with', () => {
    expect(check('git push origin main', 'git push')).toBe(true);
    expect(check('git status', 'git push')).toBe(false);
    expect(check('gh pr create', 'gh')).toBe(true);
    expect(check('ghost', 'gh')).toBe(false);
  });

  it('finds it in any sub-command and inside a pipeline or group', () => {
    expect(check('make && git push', 'git push')).toBe(true);
    expect(check('(cd x; git push)', 'git push')).toBe(true);
  });

  it('still finds it in the text when the tree has an error or a dynamic name', () => {
    expect(check('echo "x && git push', 'git push')).toBe(true);
    expect(check('$X; git push', 'git push')).toBe(true);
  });

  it('does not see a name that is only an argument', () => {
    expect(check('echo hello', 'git push')).toBe(false);
  });

  it('gives the first pattern that matches', () => {
    const parsed = parser.parse('npm publish');
    expect(firstMatchingPattern(parsed, 'npm publish', ['git push', 'npm publish'])).toBe(
      'npm publish',
    );
  });
});
