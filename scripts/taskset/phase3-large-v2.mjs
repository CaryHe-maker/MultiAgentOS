// Second version of the large final set (docs/M2/Phase3Plan.md section 3.3, 2026-11-15). dsh finished
// every first pick in 8-14 minutes, under the 25-minute rule, and DeepSWE's largest tasks are of the
// same size. Cary chose, after reading the task contents: two LoopsBench tasks picked by hand plus two
// tasks designed in this project. The tasks dsh already ran keep their ids and move to the development
// set. Run once; it rewrites `finalLarge` and `devLarge` of phase3.json and keeps the first version
// under `finalLargeV1`. The designed tasks are added by `--designed <id>=<dir> ...` once they exist.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const META = process.env.META ?? `${process.env.HOME}/benchmeta`;
const OUT = process.env.OUT ?? join(here, 'phase3.json');
const sealed = JSON.parse(readFileSync(OUT, 'utf8'));

function hashDir(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const s = statSync(path, { throwIfNoEntry: false });
      if (s === undefined) continue;
      if (s.isDirectory()) walk(path, r);
      else if (s.isFile()) files.push([r, path]);
    }
  };
  walk(dir, '');
  const hash = createHash('sha256');
  for (const [r, path] of files) hash.update(`${r}\0`).update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}

const designed = process.argv
  .slice(process.argv.indexOf('--designed') + 1)
  .filter((a) => process.argv.includes('--designed') && a.includes('='))
  .map((a) => a.split('='));

if (!sealed.finalLargeV1) {
  sealed.finalLargeV1 = sealed.finalLarge;
  // The first picks and reserves that dsh ran keep their ids as development tasks.
  const ran = [
    'lb/task_cs61b_extra_java_bundle',
    'lb/task_compiler_sysy_rust',
    'lb/task_java_ds_coursework',
    'lb/task_compiler_rustlike_rv32',
    'deepswe/bandit-interprocedural-taint-checks',
    'deepswe/arcane-drift-detection-baselines',
  ];
  sealed.devLarge = [
    ...sealed.devLarge,
    ...sealed.finalLarge
      .filter((t) => ran.includes(t.id))
      .map((t) => ({ ...t, role: 'dev', from: 'finalLargeV1' })),
  ];
  sealed.finalLarge = ['task_os_labs_asm_kernel', 'task_compiler_cmm_mips'].map((name) => ({
    id: `lb/${name}`,
    source: 'loopsbench',
    role: 'picked',
    chosenBy: 'Cary, 2026-11-15, after reading the contents; phase-1 final half, not used before',
    sha256: hashDir(join(META, 'lb-data/tasks', name)),
  }));
}
// `--designed id=dir` adds a designed task to the final set, `--designed dev:id=dir` to the
// development set; `--to-dev id` moves a final task that dsh finished in under 25 minutes to the
// development set (Cary, 2026-11-15: every task run with DeepSeek is kept).
for (const [key, dir] of designed) {
  const dev = key.startsWith('dev:');
  const id = dev ? key.slice(4) : key;
  sealed.finalLarge = sealed.finalLarge.filter((t) => t.id !== id);
  sealed.devLarge = sealed.devLarge.filter((t) => t.id !== id);
  (dev ? sealed.devLarge : sealed.finalLarge).push({
    id,
    source: 'designed',
    role: dev ? 'dev' : 'picked',
    sha256: hashDir(dir),
  });
}
const toDev = process.argv.indexOf('--to-dev');
if (toDev >= 0) {
  for (const id of process.argv.slice(toDev + 1).filter((a) => !a.startsWith('--'))) {
    const t = sealed.finalLarge.find((x) => x.id === id);
    if (!t) continue;
    sealed.finalLarge = sealed.finalLarge.filter((x) => x.id !== id);
    sealed.devLarge.push({ ...t, role: 'dev', reason: 'dsh finished in under 25 minutes' });
  }
}
sealed.largeRules.v2 =
  'v1 picks all ran under 25 minutes with dsh; v2 = two LoopsBench tasks chosen by hand (os_labs_asm_kernel, compiler_cmm_mips) + two tasks designed in this project; each must also take dsh at least 25 minutes in its one control run';
sealed.resealedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(sealed, null, 1) + '\n');
console.log(sealed.finalLarge.map((t) => t.id).join('\n'));
