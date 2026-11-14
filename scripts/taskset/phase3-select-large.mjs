// Picks the large tasks of phase 3 (docs/M2/Phase3Plan.md section 3): two LoopsBench and two DeepSWE
// tasks for the final set, each source with three reserves in order, and one of each for the
// development set. Only static properties decide (size of the reference solution, number of units,
// timeouts, language, repository); no result of any model does. Run after phase3-select.mjs: it
// fills `finalLarge` and `devLarge` of phase3.json with the content hash of every task.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const META = process.env.META ?? `${process.env.HOME}/benchmeta`;
const OUT = process.env.OUT ?? join(here, 'phase3.json');
const sealed = JSON.parse(readFileSync(OUT, 'utf8'));
const h = (s) => createHash('sha256').update(`${sealed.salt}|pick|${s}`).digest('hex');
const manifest = JSON.parse(readFileSync(`${META}/manifest.json`, 'utf8'));
const tierOf = new Map(manifest.tasks.map((t) => [t.id, t.tier]));

// Repositories the small final set already uses: a large task must not come from them.
const smallRepos = new Set(
  sealed.finalSmall.map((t) => t.bucket.replace(/^repo:/, '').toLowerCase()),
);

const changedLines = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;

// ---- LoopsBench: several connected units of moderate size, so one agent needs a long time and
// the work can be split; not the giant segments (hundreds of units) nor the two-unit ones.
const LB = `${META}/lb-data/tasks`;
const loops = [];
for (const name of readdirSync(LB)) {
  const dir = join(LB, name);
  if (!name.startsWith('task_') || !statSync(dir).isDirectory()) continue;
  const yaml = readFileSync(join(dir, 'task.yaml'), 'utf8');
  const field = (k) => yaml.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1].trim();
  const gold = existsSync(join(dir, 'gold_patches'))
    ? readdirSync(join(dir, 'gold_patches')).reduce(
        (sum, f) => sum + changedLines(join(dir, 'gold_patches', f)),
        0,
      )
    : 0;
  const units = readdirSync(join(dir, 'requirements')).length;
  loops.push({
    id: `lb/${name}`,
    dir,
    repo: name
      .replace(/^task_/, '')
      .replace(/_seg\d+$/, '')
      .toLowerCase(),
    category: field('category'),
    timeout: Number(field('max_agent_timeout_sec')),
    units,
    gold,
  });
}
const loopsEligible = (t) =>
  t.units >= 6 &&
  t.units <= 30 &&
  t.gold >= 1500 &&
  t.gold <= 6000 &&
  t.timeout >= 3600 &&
  !smallRepos.has(t.repo);

// ---- DeepSWE: the largest reference solutions (top quarter, at least 5 files), so one agent needs
// a long time and the work has parts.
const DS = `${META}/deepswe/tasks`;
const deep = [];
for (const name of readdirSync(DS)) {
  const dir = join(DS, name);
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'task.toml'))) continue;
  const toml = readFileSync(join(dir, 'task.toml'), 'utf8');
  const field = (k) => toml.match(new RegExp(`^${k}\\s*=\\s*"?([^"\\n]+)"?`, 'm'))?.[1];
  const patch = readFileSync(join(dir, 'solution', 'solution.patch'), 'utf8');
  deep.push({
    id: `deepswe/${name}`,
    dir,
    repo: (field('repository_url') ?? '')
      .split('/')
      .pop()
      .replace(/\.git$/, '')
      .toLowerCase(),
    language: field('language'),
    files: (patch.match(/^diff --git /gm) ?? []).length,
    gold: changedLines(join(dir, 'solution', 'solution.patch')),
  });
}
const goldSorted = deep.map((t) => t.gold).sort((a, b) => a - b);
const topQuarter = goldSorted[Math.floor((goldSorted.length * 3) / 4)];
const deepEligible = (t) => t.gold >= topQuarter && t.files >= 5 && !smallRepos.has(t.repo);

// Seeded order, at most one task per category (LoopsBench) or language (DeepSWE) among the picks.
function pick(pool, bucketOf, n, reserves) {
  const ordered = [...pool].sort((a, b) => h(a.id).localeCompare(h(b.id)));
  const seen = new Set();
  const taken = [];
  for (const t of ordered) {
    if (taken.length < n && seen.has(bucketOf(t))) continue;
    seen.add(bucketOf(t));
    taken.push(t);
    if (taken.length >= n + reserves) break;
  }
  return taken;
}

// LoopsBench: final from the sealed half of phase 1's split, development from the other half.
const lbFinal = pick(
  loops.filter((t) => tierOf.get(t.id) === 'final' && loopsEligible(t)),
  (t) => t.category,
  2,
  3,
);
const lbDev = pick(
  loops.filter(
    (t) =>
      tierOf.get(t.id) === 'dev' &&
      loopsEligible(t) &&
      !lbFinal.some((f) => f.category === t.category || f.repo === t.repo),
  ),
  (t) => t.category,
  1,
  0,
);
// DeepSWE was not split before: final first, development from what is left, in another language.
const dsFinal = pick(deep.filter(deepEligible), (t) => t.language, 2, 3);
const dsDev = pick(
  deep.filter(
    (t) =>
      deepEligible(t) &&
      !dsFinal.some((f) => f.id === t.id || f.repo === t.repo) &&
      !dsFinal.slice(0, 2).some((f) => f.language === t.language),
  ),
  (t) => t.language,
  1,
  0,
);

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
const entry = (t, source, role) => ({
  id: t.id,
  source,
  role,
  bucket: t.category ?? t.language,
  repo: t.repo,
  units: t.units,
  goldLines: t.gold,
  sha256: hashDir(t.dir),
});
sealed.finalLarge = [
  ...lbFinal.map((t, i) => entry(t, 'loopsbench', i < 2 ? 'picked' : `reserve${i - 1}`)),
  ...dsFinal.map((t, i) => entry(t, 'deepswe', i < 2 ? 'picked' : `reserve${i - 1}`)),
];
sealed.devLarge = [
  ...lbDev.map((t) => entry(t, 'loopsbench', 'dev')),
  ...dsDev.map((t) => entry(t, 'deepswe', 'dev')),
  { id: 'study.findex', source: 'study', role: 'dev' },
  { id: 'study.taskq', source: 'study', role: 'dev' },
];
sealed.largeRules = {
  loopsbench:
    'phase-1 final half; 6-30 units; 1500-6000 changed lines in the gold patches; timeout >= 3600 s; repository not in the small final set; one per category',
  deepswe: `reference solution >= ${topQuarter} changed lines (top quarter) and >= 5 files; repository not in the small final set; one per language`,
  replacement:
    'a picked task that dsh finishes in under 25 minutes is replaced by the next reserve of the same source, in order',
};
sealed.sealedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(sealed, null, 1) + '\n');
console.log(
  'LoopsBench pool',
  loops.filter((t) => tierOf.get(t.id) === 'final' && loopsEligible(t)).length,
  'DeepSWE pool',
  deep.filter(deepEligible).length,
);
