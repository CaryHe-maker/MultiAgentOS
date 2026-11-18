import { beforeAll, describe, expect, it } from 'vitest';
import { createCommandParser, type CommandParser } from './command-parser.js';
import { isReadOnlyLine, readsRepository } from './read-only-commands.js';

let parser: CommandParser;
beforeAll(async () => {
  parser = await createCommandParser();
});

const readOnly = (line: string) => isReadOnlyLine(parser.parse(line));

describe('the read-only list', () => {
  it.each([
    'ls -la',
    'cat package.json',
    'ls -a; cat package.json; cat tsconfig.json',
    'grep -rn "Callback\\|done" src | head -30',
    'grep -rn foo src | wc -l',
    'git status',
    'git diff --stat HEAD~1',
    'git log --oneline -5 && git show HEAD',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    'head -n 20 src/a.ts 2>&1',
    'cat missing.txt 2>/dev/null || echo none',
    'echo "a > b"',
    'test -f package.json && echo yes',
    'node --version',
    'python3 --version; tsc -v',
    'command -v tsc',
    'for f in src/*.ts; do wc -l $f; done',
    'cd pkg && ls',
    'cat <<EOF\nhello\nEOF',
  ])('lets %j run without a question', (line) => {
    expect(readOnly(line)).toBe(true);
  });

  it.each([
    ['writes a file', 'echo hi > out.txt'],
    ['appends to a file', 'cat a >> b'],
    ['writes both streams to a file', 'ls &> out.txt'],
    ['removes', 'rm -rf dist'],
    ['builds', 'npm run build'],
    ['tests', 'npm test'],
    ['runs a script', 'node script.js'],
    ['runs a shell', 'bash -c "ls"'],
    ['pipes into a shell', 'cat x | sh'],
    ['wraps another command', 'env ls'],
    ['substitutes a command', 'cat $(which node)'],
    ['has a name that is not a word', '$CMD file'],
    ['runs a file of the repository', './tools/ls'],
    ['has a file of the repository as its name', 'tools/ls'],
    ['finds and deletes', 'find . -name "*.tmp" -delete'],
    ['finds and executes', 'find . -type f -exec cat {} \\;'],
    ['sorts into a file', 'sort -o out.txt in.txt'],
    ['sorts into a file with a long option', 'sort --output=out.txt in.txt'],
    ['runs a preprocessor', 'rg --pre cat foo'],
    ['writes with git', 'git diff --output=patch.diff'],
    ['changes history', 'git commit -m x'],
    ['has no git subcommand', 'git'],
    ['is not a version probe', 'node script.js --version'],
    ['has a parse error', 'echo "unterminated'],
    ['is empty', ''],
  ])('asks when the line %s', (_why, line) => {
    expect(readOnly(line)).toBe(false);
  });

  it('knows a list that was given instead of the default', () => {
    expect(isReadOnlyLine(parser.parse('make -n'), ['make'])).toBe(true);
    expect(isReadOnlyLine(parser.parse('ls'), ['make'])).toBe(false);
  });
});

describe('which lines read the repository', () => {
  const reads = (line: string) => readsRepository(parser.parse(line));

  it('does not count a line that opens no file of it', () => {
    for (const line of ['echo hi', 'pwd', 'cd src && pwd', 'node --version', 'true || false'])
      expect(reads(line)).toBe(false);
  });

  it('counts a line with a command that can', () => {
    for (const line of ['ls', 'cat a.txt', 'echo hi; cat a.txt', 'git status', 'grep x -r .'])
      expect(reads(line)).toBe(true);
  });
});
