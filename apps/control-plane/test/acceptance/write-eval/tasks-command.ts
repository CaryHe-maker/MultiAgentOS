/**
 * The four tasks of acceptance group C (M2Design 13): the model changes a small repository AND
 * runs its tests through `run_command` in the sandbox. A task passes when the tests that the model
 * never saw pass, nothing outside the expected range changed, the model really ran commands, and
 * the reply says what was done. Every repository has its own tests, so the model can check its
 * own work; the hidden tests are stricter than the visible ones.
 */
import type { Judged, WriteTask } from './tasks.js';

const say = (text: string) => ({ say: text });
const nodeTest = ['node', '--test', 'hidden.test.ts'];
const TS = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n";
const PACKAGE = (name: string): string =>
  `${JSON.stringify({ name, private: true, type: 'module', scripts: { test: 'node --test test/*.test.ts' } }, null, 2)}\n`;

const problems = (...found: readonly (string | undefined)[]): readonly string[] =>
  found.filter((message): message is string => message !== undefined);
const only = (changed: readonly string[], allowed: readonly RegExp[]): string | undefined => {
  const outside = changed.filter((path) => !allowed.some((pattern) => pattern.test(path)));
  return outside.length === 0
    ? undefined
    : `changed outside the expected range: ${outside.join(', ')}`;
};
const saysSomething = (replies: readonly string[]): string | undefined =>
  replies.join('\n').trim().length < 30 ? 'the reply does not say what was done' : undefined;
/** The exit codes of the commands the model ran, in order, from the results it was shown. */
const exitCodes = (results: readonly string[]): number[] =>
  results.flatMap((text) => {
    const match = /^exit code (\d+)/u.exec(text);
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });

/**
 * Whether a test run in the results failed. A pipe such as `npm test | tail` hides the exit code,
 * so the report of the test runner counts as much as the code does.
 */
const failedRun = (text: string): boolean =>
  /^exit code [1-9]/u.test(text) || /✖|ℹ fail [1-9]|# fail [1-9]/u.test(text);
const passedRun = (text: string): boolean => /^exit code 0/u.test(text) && !failedRun(text);

export const COMMAND_TASKS: readonly WriteTask[] = [
  // C1: one bug, found by running the tests.
  {
    id: 'c1-fix-bug-and-run-tests',
    category: 'command',
    language: 'ts',
    mustRunCommands: 1,
    files: {
      'package.json': PACKAGE('stats'),
      'README.md':
        '# stats\n\nSmall statistics helpers.\n\n- `average(values)`: the arithmetic mean; an empty list gives 0.\n- `median(values)`: the middle value; for an even count the mean of the two middle ones.\n\nRun the tests with `npm test`.\n',
      'src/stats.ts':
        'export function average(values: readonly number[]): number {\n  if (values.length === 0) return 0;\n  let sum = 0;\n  for (let i = 1; i < values.length; i += 1) sum += values[i] ?? 0;\n  return sum / values.length;\n}\n\nexport function median(values: readonly number[]): number {\n  if (values.length === 0) return 0;\n  const sorted = [...values].sort((a, b) => a - b);\n  const middle = Math.floor(sorted.length / 2);\n  return sorted.length % 2 === 1\n    ? (sorted[middle] ?? 0)\n    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;\n}\n',
      'src/index.ts': "export { average, median } from './stats.ts';\n",
      'test/stats.test.ts': `${TS}import { average, median } from '../src/index.ts';
test('average of three numbers', () => assert.equal(average([2, 4, 6]), 4));
test('average of an empty list is 0', () => assert.equal(average([]), 0));
test('median of an odd count', () => assert.equal(median([5, 1, 3]), 3));
test('median of an even count', () => assert.equal(median([4, 1, 3, 2]), 2.5));
`,
    },
    steps: [
      say(
        'The tests in this repository fail. Find the bug, fix it in the source (not in the tests), and run the tests again to show that they pass.',
      ),
    ],
    hidden: {
      'hidden.test.ts': `${TS}import { average, median } from './src/index.ts';
test('first element counts', () => assert.equal(average([10, 20]), 15));
test('single element', () => assert.equal(average([7]), 7));
test('negatives', () => assert.equal(average([-2, 2, -4, 4]), 0));
test('empty', () => assert.equal(average([]), 0));
test('median untouched', () => { assert.equal(median([9, 1, 5, 3]), 4); assert.equal(median([2]), 2); });
`,
    },
    run: nodeTest,
    check: ({ changed, replies, toolResults }: Judged) =>
      problems(
        only(changed, [/^src\/stats\.ts$/u]),
        saysSomething(replies),
        exitCodes(toolResults ?? []).at(-1) === 0 ? undefined : 'the last test run did not pass',
      ),
  },

  // C2: a rename across source, tests and documentation.
  {
    id: 'c2-rename-across-files',
    category: 'command',
    language: 'ts',
    mustRunCommands: 1,
    files: {
      'package.json': PACKAGE('shop'),
      'README.md':
        '# shop\n\nPrices are shown with `fmtPrice(cents, currency)`, for example `fmtPrice(1999, "EUR")` is `19.99 EUR`.\n\nRun the tests with `npm test`.\n',
      'src/money.ts':
        'export function fmtPrice(cents: number, currency = "EUR"): string {\n  const sign = cents < 0 ? "-" : "";\n  const abs = Math.abs(cents);\n  const units = Math.floor(abs / 100);\n  const rest = String(abs % 100).padStart(2, "0");\n  return `${sign}${String(units)}.${rest} ${currency}`;\n}\n',
      'src/cart.ts':
        'import { fmtPrice } from "./money.ts";\n\nexport interface Line {\n  name: string;\n  cents: number;\n  quantity: number;\n}\n\nexport function total(lines: readonly Line[]): number {\n  return lines.reduce((sum, line) => sum + line.cents * line.quantity, 0);\n}\n\nexport function summary(lines: readonly Line[]): string {\n  return `${String(lines.length)} lines, ${fmtPrice(total(lines))}`;\n}\n',
      'src/receipt.ts':
        'import { fmtPrice } from "./money.ts";\nimport type { Line } from "./cart.ts";\n\nexport function receipt(lines: readonly Line[]): string {\n  return lines\n    .map((line) => `${line.name} x${String(line.quantity)}  ${fmtPrice(line.cents * line.quantity)}`)\n    .join("\\n");\n}\n',
      'src/tax.ts':
        'export function withTax(cents: number, rate: number): number {\n  return Math.round(cents * (1 + rate));\n}\n',
      'src/index.ts':
        'export { fmtPrice } from "./money.ts";\nexport { total, summary } from "./cart.ts";\nexport { receipt } from "./receipt.ts";\nexport { withTax } from "./tax.ts";\n',
      'test/money.test.ts': `${TS}import { fmtPrice } from '../src/index.ts';
test('formats cents', () => assert.equal(fmtPrice(1999, 'EUR'), '19.99 EUR'));
test('negative', () => assert.equal(fmtPrice(-5), '-0.05 EUR'));
`,
      'test/cart.test.ts': `${TS}import { receipt, summary } from '../src/index.ts';
const lines = [{ name: 'pen', cents: 150, quantity: 2 }, { name: 'book', cents: 1200, quantity: 1 }];
test('summary', () => assert.equal(summary(lines), '2 lines, 15.00 EUR'));
test('receipt', () => assert.equal(receipt(lines), 'pen x2  3.00 EUR\\nbook x1  12.00 EUR'));
`,
    },
    steps: [
      say(
        'Rename the function fmtPrice to formatPrice everywhere: the source, the tests and the README. Its behaviour must not change. Run the tests afterwards.',
      ),
    ],
    hidden: {
      'hidden.test.ts': `${TS}import { formatPrice, receipt, summary, withTax } from './src/index.ts';
test('same output', () => { assert.equal(formatPrice(1999, 'USD'), '19.99 USD'); assert.equal(formatPrice(0), '0.00 EUR'); });
test('used by the cart', () => assert.equal(summary([{ name: 'a', cents: 250, quantity: 4 }]), '1 lines, 10.00 EUR'));
test('used by the receipt', () => assert.equal(receipt([{ name: 'a', cents: 5, quantity: 1 }]), 'a x1  0.05 EUR'));
test('unrelated code is intact', () => assert.equal(withTax(1000, 0.2), 1200));
`,
    },
    run: nodeTest,
    check: ({ files, changed, replies, toolResults }: Judged) => {
      const holders = [...files]
        .filter(([, text]) => text.includes('fmtPrice'))
        .map(([path]) => path);
      const users = [...files]
        .filter(([, text]) => text.includes('formatPrice'))
        .map(([path]) => path);
      return problems(
        holders.length === 0 ? undefined : `the old name is still in ${holders.join(', ')}`,
        users.length >= 5 ? undefined : `formatPrice is in only ${String(users.length)} files`,
        files.get('src/tax.ts')?.includes('withTax') === true && !changed.includes('src/tax.ts')
          ? undefined
          : 'src/tax.ts was touched',
        only(changed, [/^src\//u, /^test\//u, /^README\.md$/u]),
        saysSomething(replies),
        exitCodes(toolResults ?? []).at(-1) === 0 ? undefined : 'the last test run did not pass',
      );
    },
  },

  // C3: the test first, seen to fail, then the fix.
  {
    id: 'c3-test-first-then-fix',
    category: 'command',
    language: 'ts',
    mustRunCommands: 2,
    files: {
      'package.json': PACKAGE('duration'),
      'README.md':
        '# duration\n\n`parseDuration("1h30m")` gives the number of seconds: units are `h`, `m` and `s`, in any combination, for example `2m10s` is 130.\n\nRun the tests with `npm test`.\n',
      'src/duration.ts':
        'const SECONDS: Record<string, number> = { h: 360, m: 60, s: 1 };\n\nexport function parseDuration(text: string): number {\n  let total = 0;\n  for (const [, amount, unit] of text.matchAll(/(\\d+)([hms])/gu)) {\n    total += Number(amount) * (SECONDS[unit ?? ""] ?? 0);\n  }\n  return total;\n}\n',
      'src/index.ts': "export { parseDuration } from './duration.ts';\n",
      'test/duration.test.ts': `${TS}import { parseDuration } from '../src/index.ts';
test('seconds', () => assert.equal(parseDuration('45s'), 45));
test('minutes and seconds', () => assert.equal(parseDuration('2m10s'), 130));
`,
    },
    steps: [
      say(
        'parseDuration("1h30m") should be 5400 but it is not. Work test-first: add a test to test/duration.test.ts that reproduces the problem, run the tests and show that the new test fails, then fix the code and run the tests again until they all pass.',
      ),
    ],
    hidden: {
      'hidden.test.ts': `${TS}import { parseDuration } from './src/index.ts';
test('hours', () => assert.equal(parseDuration('2h'), 7200));
test('mixed', () => assert.equal(parseDuration('1h30m'), 5400));
test('all three', () => assert.equal(parseDuration('1h1m1s'), 3661));
test('minutes still fine', () => assert.equal(parseDuration('2m10s'), 130));
test('nothing', () => assert.equal(parseDuration(''), 0));
`,
    },
    run: nodeTest,
    check: ({ files, changed, replies, toolResults }: Judged) => {
      const runs = (toolResults ?? []).filter((text) => /^exit code \d+/u.test(text));
      const firstFail = runs.findIndex(failedRun);
      return problems(
        only(changed, [/^src\/duration\.ts$/u, /^test\/duration\.test\.ts$/u]),
        files.get('test/duration.test.ts')?.includes('1h30m') === true &&
          files.get('test/duration.test.ts')?.includes('5400') === true
          ? undefined
          : 'the reproducing test is not in test/duration.test.ts',
        firstFail >= 0
          ? undefined
          : `the new test was never seen to fail (results: ${JSON.stringify((toolResults ?? []).map((t) => t.slice(0, 40)))})`,
        firstFail >= 0 && runs.slice(firstFail + 1).some(passedRun)
          ? undefined
          : 'no passing run after the failing one',
        runs.length > 0 && passedRun(runs.at(-1) ?? '')
          ? undefined
          : 'the last test run did not pass',
        saysSomething(replies),
      );
    },
  },

  // C4: a new function with its tests, in the style of the repository.
  {
    id: 'c4-add-feature-with-tests',
    category: 'command',
    language: 'ts',
    mustRunCommands: 1,
    files: {
      'package.json': PACKAGE('arrays'),
      'README.md': '# arrays\n\nHelpers for arrays. Run the tests with `npm test`.\n',
      'src/array.ts':
        '/** The distinct items, in order of first appearance. */\nexport function unique<T>(items: readonly T[]): T[] {\n  return [...new Set(items)];\n}\n\n/** The last item, or undefined for an empty array. */\nexport function last<T>(items: readonly T[]): T | undefined {\n  return items[items.length - 1];\n}\n',
      'src/index.ts': "export { unique, last } from './array.ts';\n",
      'test/array.test.ts': `${TS}import { last, unique } from '../src/index.ts';
test('unique keeps the first of each', () => assert.deepEqual(unique([3, 1, 3, 2, 1]), [3, 1, 2]));
test('last of an empty array', () => assert.equal(last([]), undefined));
test('last', () => assert.equal(last([1, 2, 3]), 3));
`,
    },
    steps: [
      say(
        'Add a function chunk(items, size) to src/array.ts and export it from src/index.ts. It splits an array into arrays of at most `size` items, in order; the last one may be shorter; an empty array gives an empty result; a size that is not a positive integer throws a RangeError. Add tests for it to test/array.test.ts in the style of the existing ones, and run the tests.',
      ),
    ],
    hidden: {
      'hidden.test.ts': `${TS}import { chunk, last, unique } from './src/index.ts';
test('even split', () => assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]));
test('remainder', () => assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));
test('bigger than the array', () => assert.deepEqual(chunk([1, 2], 5), [[1, 2]]));
test('empty', () => assert.deepEqual(chunk([], 3), []));
test('not mutated', () => { const a = [1, 2, 3]; chunk(a, 2); assert.deepEqual(a, [1, 2, 3]); });
test('invalid sizes', () => { for (const size of [0, -1, 1.5, Number.NaN]) assert.throws(() => chunk([1], size), RangeError); });
test('the others still work', () => { assert.deepEqual(unique([1, 1]), [1]); assert.equal(last([1, 2]), 2); });
`,
    },
    run: nodeTest,
    check: ({ files, changed, replies, toolResults }: Judged) => {
      const tests = files.get('test/array.test.ts') ?? '';
      return problems(
        only(changed, [/^src\/array\.ts$/u, /^src\/index\.ts$/u, /^test\/array\.test\.ts$/u]),
        tests.includes('chunk') ? undefined : 'no test for chunk was added',
        (tests.match(/\btest\(/gu) ?? []).length >= 6
          ? undefined
          : 'too few tests for chunk were added',
        saysSomething(replies),
        exitCodes(toolResults ?? []).at(-1) === 0 ? undefined : 'the last test run did not pass',
      );
    },
  },
];
