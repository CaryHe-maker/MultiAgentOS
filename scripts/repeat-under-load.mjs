#!/usr/bin/env node
/**
 * Runs test files again and again while the machine is busy, to find the tests that only pass
 * when nothing else is going on (docs/M2/M2FrozenTests.md 8): a wait that was too short, a log
 * that was read a moment before it was written, a name that happened to look like something else.
 *
 *   node scripts/repeat-under-load.mjs [--times 5] [--load 4] <test file or directory> ...
 *
 * `--load` is the number of processes that burn a CPU for the whole time. Exits non-zero when
 * any run failed, and names the runs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const number = (name, fallback) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : Number(argv[index + 1]);
};
const times = number('--times', 5);
const load = number('--load', 4);
const targets = argv.filter(
  (arg, index) =>
    !arg.startsWith('--') && argv[index - 1] !== '--times' && argv[index - 1] !== '--load',
);
if (targets.length === 0) {
  process.stderr.write('usage: repeat-under-load.mjs [--times N] [--load N] <test file> ...\n');
  process.exit(2);
}

process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const burners = Array.from({ length: load }, () =>
  spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }),
);
const failed = [];
try {
  for (let run = 1; run <= times; run += 1) {
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...targets], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      // pnpm is a .cmd file on Windows.
      shell: process.platform === 'win32',
    });
    if (result.error !== undefined) throw result.error;
    const summary = /Tests\s+[^\n]*/u.exec(result.stdout)?.[0] ?? 'no summary';
    process.stdout.write(
      `run ${String(run)}/${String(times)}: ${result.status === 0 ? 'ok' : 'FAILED'} (${summary.trim()})\n`,
    );
    if (result.status !== 0) {
      failed.push(run);
      process.stdout.write(
        `${result.stdout
          .split('\n')
          .filter((line) => line.includes('×') || line.includes('FAIL'))
          .join('\n')}\n`,
      );
    }
  }
} finally {
  for (const burner of burners) burner.kill('SIGKILL');
}
process.stdout.write(
  failed.length === 0 ? 'no run failed\n' : `failed runs: ${failed.join(', ')}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
