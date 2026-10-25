import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/**
 * Shows, for every run of a saved evaluation that missed an answer-key issue, the report lines
 * that mention a keyword, so a miss can be checked by hand: a real miss, or a correct finding
 * the answer key's patterns do not recognize (as M0 found when it calibrated v2 of the key).
 *
 *   pnpm --filter @multiagentos/executor-set exec tsx eval/inspect-misses.ts \
 *     --issue append-name-unchecked --grep duplicate_slice eval/runs/<file>.json
 */
const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--')),
  allowPositionals: true,
  options: { issue: { type: 'string' }, grep: { type: 'string', multiple: true } },
});
if (values.issue === undefined || positionals.length === 0) {
  console.error('usage: inspect-misses.ts --issue <id> [--grep <keyword>]... <run file>...');
  process.exit(2);
}

interface SavedRow {
  readonly repeat: number;
  readonly grade: { readonly missed: readonly string[] };
  readonly result: { readonly report: string };
}

const keywords = (values.grep ?? []).map((keyword) => keyword.toLowerCase());
let missed = 0;
for (const file of positionals) {
  const rows = (JSON.parse(readFileSync(file, 'utf8')) as { rows: SavedRow[] }).rows;
  for (const row of rows) {
    if (!row.grade.missed.includes(values.issue)) continue;
    missed += 1;
    const lines = row.result.report
      .split('\n')
      .filter(
        (line) =>
          keywords.length === 0 || keywords.some((keyword) => line.toLowerCase().includes(keyword)),
      );
    console.log(`--- ${file} #${row.repeat}`);
    console.log(lines.length === 0 ? '(no line mentions the keywords)' : lines.join('\n'));
  }
}
console.log(`\n${missed} runs missed ${values.issue}.`);
