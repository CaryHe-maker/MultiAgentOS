#!/usr/bin/env node
/**
 * The check every phase has to pass before it is released (docs/M2/M2FrozenTests.md 5):
 *
 *   node scripts/phase-gate.mjs
 *
 * It runs the frozen system tests (every file the inventory in
 * apps/control-plane/test/system/frozen.json names, the inventory test itself, the adversarial
 * cases of a compromised model, the kill-anywhere cases, and the tests of the evaluation system),
 * on Ubuntu 24.04 only, and fails when any test fails or is skipped: a test that does not run on
 * the gate platform is a hole, not a pass. The result is printed, and written under
 * `.multiagentos/gate/` for the acceptance evidence.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);

function platformOk() {
  if (process.env.MAS_GATE_ANY_PLATFORM === '1') return true;
  try {
    const release = readFileSync('/etc/os-release', 'utf8');
    return /^ID=ubuntu$/mu.test(release) && /^VERSION_ID="?24\.04"?$/mu.test(release);
  } catch {
    return false;
  }
}

if (!platformOk()) {
  process.stderr.write(
    'The phase gate runs on Ubuntu 24.04 only (set MAS_GATE_ANY_PLATFORM=1 to try it elsewhere; the result is then not evidence).\n',
  );
  process.exit(2);
}

const manifest = JSON.parse(readFileSync('apps/control-plane/test/system/frozen.json', 'utf8'));
const files = new Set([
  'apps/control-plane/test/system',
  'apps/control-plane/test/eval',
  ...manifest.flatMap((entry) => entry.tests.map((test) => test.file)),
]);

const out = join(tmpdir(), `mas-gate-${String(process.pid)}.json`);
const run = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${out}`],
  { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, MAS_GATE: '1' } },
);

let report;
try {
  report = JSON.parse(readFileSync(out, 'utf8'));
} catch {
  process.stderr.write('The test run left no report.\n');
  process.exit(1);
}

const skipped = [];
const failed = [];
for (const file of report.testResults ?? [])
  for (const test of file.assertionResults ?? []) {
    if (test.status === 'pending' || test.status === 'skipped' || test.status === 'todo')
      skipped.push(`${file.name} :: ${test.fullName}`);
    if (test.status === 'failed') failed.push(`${file.name} :: ${test.fullName}`);
  }

let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  /* no git: the commit stays unknown */
}
const summary = {
  commit,
  at: new Date().toISOString(),
  platform: process.platform,
  files: files.size,
  total: report.numTotalTests,
  passed: report.numPassedTests,
  failed: failed.length,
  skipped: skipped.length,
  ok: run.status === 0 && failed.length === 0 && skipped.length === 0,
};
mkdirSync('.multiagentos/gate', { recursive: true });
writeFileSync(
  `.multiagentos/gate/${commit}.json`,
  `${JSON.stringify({ ...summary, failedTests: failed, skippedTests: skipped }, null, 2)}\n`,
);
process.stdout.write(`\nphase gate: ${JSON.stringify(summary)}\n`);
for (const each of failed) process.stdout.write(`FAILED  ${each}\n`);
for (const each of skipped) process.stdout.write(`SKIPPED ${each}\n`);
process.exit(summary.ok ? 0 : 1);
