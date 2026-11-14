// Freezes the phase-3 task sets (docs/M2/Phase3TaskSet.md): gives every entry of phase3.json a content hash
// and marks the file frozen (`--fill`, run once), or recomputes every hash and reports differences
// (`--verify`, the default). Run in WSL, where the task data lives.
//   node phase3-freeze.mjs [--fill | --verify]
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const META = process.env.META ?? `${process.env.HOME}/benchmeta`;
const TASKSET = process.env.TASKSET ?? `${process.env.HOME}/taskset`;
const OUT = join(here, 'phase3.json');
const sealed = JSON.parse(readFileSync(OUT, 'utf8'));

function hashDir(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '__pycache__') continue;
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

// Where each kind of task id lives.
function locate(id) {
  const [kind, ...rest] = id.split('/');
  const name = rest.join('/');
  if (kind === 'designed') return join(here, 'designed', name);
  if (kind === 'tb2') return join(META, 'tb2', name);
  if (kind === 'sbp') return join(META, 'sbp/v2/tasks', name);
  if (kind === 'lb') return join(META, 'lb-data/tasks', name);
  if (kind === 'deepswe') return join(META, 'deepswe/tasks', name);
  if (kind === 'parallel') return join(TASKSET, rest[0], 'parallel', rest.slice(1).join('/'));
  if (id.startsWith('study.'))
    return join(repo, 'apps/control-plane/test/eval/fixtures/study', id.slice(6));
  return null;
}

const mode = process.argv.includes('--fill') ? 'fill' : 'verify';
const lists = ['finalSmall', 'finalLarge', 'devSmall', 'devLarge'];
let bad = 0;
for (const list of lists) {
  sealed[list] = sealed[list].map((t) => (typeof t === 'string' ? { id: t, role: 'dev' } : t));
  for (const t of sealed[list]) {
    const dir = locate(t.id);
    if (!dir || !existsSync(dir)) {
      console.log(`missing  ${list} ${t.id}`);
      bad += 1;
      continue;
    }
    const h = hashDir(dir);
    if (!t.sha256) {
      if (mode === 'fill') t.sha256 = h;
      else {
        console.log(`no hash  ${list} ${t.id}`);
        bad += 1;
      }
    } else if (t.sha256 !== h) {
      console.log(`CHANGED  ${list} ${t.id}`);
      bad += 1;
    }
  }
}
if (mode === 'fill') {
  sealed.frozen = {
    at: new Date().toISOString(),
    by: 'Cary, 2026-11-15',
    note: 'final and development sets fixed; every task has had one dsh control run; see docs/M2/Phase3TaskSet.md',
    counts: Object.fromEntries(
      lists.map((l) => [
        l,
        sealed[l].filter((t) => !['reserve', 'voided'].includes(t.role)).length,
      ]),
    ),
  };
  writeFileSync(OUT, JSON.stringify(sealed, null, 1) + '\n');
}
console.log(`${mode}: ${bad === 0 ? 'all entries match' : `${bad} problem(s)`}`);
process.exit(bad === 0 ? 0 : 1);
