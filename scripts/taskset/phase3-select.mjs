// Picks the small-task final set of phase 3 (docs/M2/Phase3Plan.md section 3) from the sealed half of
// the public pools, by STATIC properties only: no result of any model decides what is picked. It
// writes the selection with the content hash of every task, so the set can be shown later to be the
// one sealed here.
//   node phase3-select.mjs            (META defaults to ~/benchmeta, OUT to phase3.json beside it)
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const META = process.env.META ?? `${process.env.HOME}/benchmeta`;
const OUT = process.env.OUT ?? join(here, 'phase3.json');
const SALT = 'mao-phase3-final-v1';
const h = (s) => createHash('sha256').update(`${SALT}|pick|${s}`).digest('hex');

const manifest = JSON.parse(readFileSync(`${META}/manifest.json`, 'utf8'));
const phase1 = JSON.parse(readFileSync(join(here, 'taskset.json'), 'utf8'));

// Everything phase 1 touched, in any tier, is out of the new final set. The sealed half of SWE-bench Pro
// holds five repositories only; those of the development set are excluded, so the rest may repeat.
const used = new Set();
for (const tier of Object.values(phase1.tiers))
  for (const key of ['coding', 'parallel', 'reserve'])
    for (const id of tier[key] ?? []) used.add(id);
const byId = new Map(manifest.tasks.map((t) => [t.id, t]));

// The small-task development set (section 3.1): the final set must not resemble it.
const DEV_SMALL = [
  'sbp/instance_qutebrowser__qutebrowser-36ade4bba504eb96f05d32ceab9972df7eb17bcc-v2ef375ac784985212b1805e1d0431dc8f1b3c171',
  'tb2/tune-mjcf',
  'sbp/instance_future-architect__vuls-7e91f5ef7e5712b1a3d7d5066ad6607e9debc21c',
  'tb2/configure-git-webserver',
  'tb2/gcode-to-text',
  'tb2/raman-fitting',
  'tb2/polyglot-c-py',
  'tb2/chess-best-move',
  'sbp/instance_NodeBB__NodeBB-da0211b1a001d45d73b4c84c6417a4f1b0312575-vf2cf3cbd463b7ad942381f1c6d077626485a1e9e',
  'parallel/dev/research-then-implement-s1-n6',
];
const devCategories = new Set(
  DEV_SMALL.filter((id) => id.startsWith('tb2/')).map((id) => byId.get(id)?.category),
);
const devRepos = new Set(
  DEV_SMALL.filter((id) => id.startsWith('sbp/')).map((id) => byId.get(id)?.group),
);

// Tasks whose oracle check failed (reference solution fails, or an empty solution passes) are out;
// the checks are in ~/screen/*.jsonl ({ task, mode: oracle | empty, reward }).
const broken = new Set();
const SCREEN = process.env.SCREEN ?? `${process.env.HOME}/screen`;
for (const file of existsSync(SCREEN) ? readdirSync(SCREEN) : [])
  if (file.endsWith('.jsonl')) {
    const seen = {};
    for (const line of readFileSync(join(SCREEN, file), 'utf8').split('\n').filter(Boolean)) {
      const j = JSON.parse(line);
      (seen[j.task] ??= {})[j.mode] = j.reward;
    }
    for (const [task, r] of Object.entries(seen))
      if (r.oracle === 0 || r.empty === 1) broken.add(task);
  }
const nameOf = (id) => id.slice(id.indexOf('/') + 1);

const eligible = {
  // one container, no GPU, at most 30 minutes; medium or hard, so the set separates systems
  'terminal-bench-2.0': (t) =>
    t.agentTimeoutSec <= 1800 &&
    t.gpus === 0 &&
    t.memoryMb <= 4096 &&
    !['mathematics', 'model-training'].includes(t.category) &&
    ['medium', 'hard'].includes(t.difficulty),
  // a small bug fix in a repository the development set does not use
  'swe-bench-pro': (t) => t.patchFiles <= 3 && t.patchLines <= 150 && !devRepos.has(t.group),
};
const QUOTA = { 'terminal-bench-2.0': 6, 'swe-bench-pro': 4 };
const RESERVE = 3;

const selection = {};
for (const [source, n] of Object.entries(QUOTA)) {
  const pool = manifest.tasks
    .filter(
      (t) =>
        t.tier === 'final' &&
        t.source === source &&
        !used.has(t.id) &&
        !broken.has(nameOf(t.id)) &&
        eligible[source](t),
    )
    .sort((a, b) => h(a.id).localeCompare(h(b.id)));
  // round-robin over the buckets (category for Terminal-Bench, repository for SWE-bench Pro) in the
  // seeded order: one per category; at most two per repository, since only three are left
  const bucketOf = (t) => (source === 'terminal-bench-2.0' ? t.category : t.group);
  const cap = source === 'terminal-bench-2.0' ? 1 : 2;
  const buckets = new Map();
  for (const t of pool)
    (buckets.get(bucketOf(t)) ?? buckets.set(bucketOf(t), []).get(bucketOf(t))).push(t);
  // categories of the development set come last: taken only when the others run out (checked by hand)
  const order = [...buckets.keys()].sort(
    (a, b) =>
      Number(devCategories.has(a)) - Number(devCategories.has(b)) || h(a).localeCompare(h(b)),
  );
  const taken = [];
  for (let round = 0; round < cap && taken.length < n + RESERVE; round++)
    for (const key of order) {
      const t = buckets.get(key)[round];
      if (t !== undefined && taken.length < n + RESERVE) taken.push(t);
    }
  selection[source] = {
    quota: n,
    poolSize: pool.length,
    picked: taken.slice(0, n).map((t) => t.id),
    reserve: taken.slice(n).map((t) => t.id),
  };
}

// The content hash of a task directory: every file, by relative path, in sorted order.
function hashDir(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, r);
      else files.push([r, path]);
    }
  };
  walk(dir, '');
  const hash = createHash('sha256');
  for (const [r, path] of files) hash.update(`${r}\0`).update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}
const dirOf = (id) =>
  id.startsWith('tb2/') ? `${META}/tb2/${id.slice(4)}` : `${META}/sbp/v2/tasks/${id.slice(4)}`;

const small = [];
for (const [source, v] of Object.entries(selection))
  for (const [role, ids] of [
    ['picked', v.picked],
    ['reserve', v.reserve],
  ])
    for (const id of ids) {
      const t = byId.get(id);
      small.push({
        id,
        source,
        role,
        bucket: t.category ?? t.group,
        difficulty: t.difficulty,
        sha256: hashDir(dirOf(id)),
      });
    }

writeFileSync(
  OUT,
  JSON.stringify(
    {
      salt: SALT,
      sealedAt: new Date().toISOString(),
      rules: 'docs/M2/Phase3Plan.md section 3',
      devSmall: DEV_SMALL,
      finalSmall: small,
      finalLarge: [],
      devLarge: [],
    },
    null,
    1,
  ) + '\n',
);
for (const [s, v] of Object.entries(selection))
  console.log(
    s.padEnd(20),
    `pool ${v.poolSize} picked ${v.picked.length} reserve ${v.reserve.length}`,
  );
