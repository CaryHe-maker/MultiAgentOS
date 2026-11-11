// Builds the candidate manifest and the tier split of the public sets.
// Isolation rule: the unit of the split is a GROUP (a repository or a task family), never a single
// task, and the group key is shared by all sources, so one repository or family lives in exactly one
// tier. The tier of a group is a pure function of (SALT, group key): it does not depend on any run.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SALT = 'mao-phase1-taskset-v1';
const META = process.env.META ?? `${process.env.HOME}/benchmeta`;
const FINAL_SHARE = Number(process.env.FINAL_SHARE ?? '0.5');
const CAP_FINAL = 3;
const CAP_DEV = 5;

const h = (s) => createHash('sha256').update(`${SALT}|${s}`).digest('hex');
const unit = (s) => parseInt(h(s).slice(0, 8), 16) / 2 ** 32;

// ---- Terminal-Bench 2.0: families written by hand from the task names -------------------------
const TB_FAMILIES = [
  ['polyglot', /^polyglot-/],
  ['path-tracing', /^path-tracing/],
  ['dna', /^dna-/],
  ['feal', /^feal-/],
  ['filter-js', /filter-js-from-html$/],
  ['qemu', /^qemu-/],
  ['mteb', /^mteb-/],
  ['sqlite', /^sqlite-/],
  ['pytorch', /^pytorch-/],
  ['git', /^git-|^fix-git$|^merge-diff-arc-agi/],
  ['chess', /chess/],
  ['cobol', /cobol/],
  ['compile', /^(build|compile)-|^cross-compile/],
  ['crack', /crack|password|hash|vulnerable|secret|leak/],
  ['model-train', /^(train|fasttext|hf-|torch)/],
];
const tbFamily = (name) => {
  for (const [fam, re] of TB_FAMILIES) if (re.test(name)) return `tb-family:${fam}`;
  return `tb:${name}`;
};

// ---- LoopsBench: repositories keep their name, course projects are put in themes ---------------
const LB_THEMES = [
  ['compiler', /^compiler|^dbcompiler$|^framework$/],
  ['riscv-hw', /riscv|verilog|gem5|architecture/],
  ['os-kernel', /^os_|_os_|^systems_|^linux011|^security_labs|^net_os/],
  ['database', /^db_|^mysql|^sql_|^lsm_|^calcite|^nandteris$|^stream_mining/],
  ['distributed', /^dist|^hadoop|^distributed|^spring_/],
  ['network', /^ns3|^mininet|^rdma|^dcqcn|^tcp|^networks|^rdma/],
  ['graphics-engines', /raylib|panda3d|godot|monogame|cocos2dx|opengl|graphics/],
  ['ml-course', /^ml|^mlp|^numpy|^deep|^sklearn|^mlsys|^deep_rl/],
  [
    'static-analysis',
    /^soot|^doop|^frama|^cpachecker|^evosuite|^jpf|^angr|^afl|^alloy|^boogie|^z3|^cvc|^sat_|^llvm|^perses|^mlir|^xjqkl/,
  ],
  ['java-course', /^java_|^datastructs|^cs61b|^ds_|^sicp/],
];
const lbGroup = (name) => {
  const base = name.replace(/^task_/, '').replace(/_seg\d+$/, '');
  const lower = base.toLowerCase();
  if (
    [
      'navidrome',
      'nodebb',
      'ansible',
      'django',
      'echarts',
      'jenkins',
      'rails',
      'node',
      'typescript',
      'clickhouse',
    ].includes(lower)
  )
    return `repo:${lower}`;
  for (const [theme, re] of LB_THEMES) if (re.test(lower)) return `lb-theme:${theme}`;
  return `lb:${lower}`;
};

const tasks = [];

// Terminal-Bench 2.0
{
  const root = join(META, 'tb2');
  for (const name of readdirSync(root)) {
    const toml = join(root, name, 'task.toml');
    if (!existsSync(toml)) continue;
    const text = readFileSync(toml, 'utf8');
    const get = (re) => text.match(re)?.[1];
    tasks.push({
      id: `tb2/${name}`,
      source: 'terminal-bench-2.0',
      group: tbFamily(name),
      difficulty: get(/difficulty = "(\w+)"/),
      category: get(/category = "([^"]+)"/),
      agentTimeoutSec: Number(get(/\[agent\]\s*timeout_sec = ([\d.]+)/) ?? 0),
      gpus: Number(get(/gpus = (\d+)/) ?? 0),
      cpus: Number(get(/cpus = (\d+)/) ?? 1),
      memoryMb: Number(get(/memory_mb = (\d+)/) ?? 0),
      internet: get(/allow_internet = (\w+)/) === 'true',
    });
  }
}

// SWE-bench Pro (task ids are the directory names of run_scripts)
{
  const dir = join(META, 'sbp', 'v2', 'tasks');
  const hard = new Set(
    readFileSync(join(META, 'sbp', 'v2', 'hard51_ids.txt'), 'utf8')
      .split('\n')
      .filter(Boolean),
  );
  for (const name of readdirSync(dir)) {
    const m = name.match(/^instance_([^_]+(?:-[^_]+)*)__(.+?)-([0-9a-f]{40})/);
    if (!m) continue;
    const toml = readFileSync(join(dir, name, 'task.toml'), 'utf8');
    tasks.push({
      id: `sbp/${name}`,
      source: 'swe-bench-pro',
      group: `repo:${m[2].toLowerCase()}`,
      hard51: hard.has(name),
      difficulty: toml.match(/difficulty = "(\w+)"/)?.[1],
      agentTimeoutSec: Number(toml.match(/\[agent\][^[]*?timeout_sec = ([\d.]+)/s)?.[1] ?? 0),
      ...(() => {
        const gold = readFileSync(join(dir, name, 'solution', 'gold_patch.diff'), 'utf8');
        return {
          patchFiles: (gold.match(/^diff --git /gm) ?? []).length,
          patchLines: gold.split('\n').length,
        };
      })(),
    });
  }
}

// FeatureBench (the `full` split; `fast` and `lite` are subsets of it)
{
  const all = JSON.parse(readFileSync(join(META, 'fb.json'), 'utf8'));
  const fast = new Set(all['default/fast'].map((r) => r.instance_id));
  const lite = new Set(all['default/lite'].map((r) => r.instance_id));
  for (const r of all['default/full']) {
    const files = (r.patch.match(/^diff --git /gm) ?? []).length;
    tasks.push({
      id: `fb/${r.instance_id}`,
      source: 'featurebench',
      group: `repo:${r.repo.split('/')[1].toLowerCase()}`,
      level: r.instance_id.match(/\.(lv\d)$/)?.[1],
      patchFiles: files,
      patchLines: r.patch.split('\n').length,
      inFast: fast.has(r.instance_id),
      inLite: lite.has(r.instance_id),
    });
  }
}

// LoopsBench
{
  const root = join(META, 'lbt', 'tasks');
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const yaml = readFileSync(join(dir, 'task.yaml'), 'utf8');
    const requirements = readdirSync(join(dir, 'requirements')).length;
    tasks.push({
      id: `lb/${name}`,
      source: 'loopsbench',
      group: lbGroup(name),
      difficulty: yaml.match(/^difficulty:\s*(\w+)/m)?.[1],
      requirements,
      agentTimeoutSec: Number(yaml.match(/max_agent_timeout_sec:\s*(\d+)/)?.[1] ?? 0),
    });
  }
}

// ---- the split ----------------------------------------------------------------------------------
const groups = [...new Set(tasks.map((t) => t.group))].sort();
const tierOf = new Map(groups.map((g) => [g, unit(g) < FINAL_SHARE ? 'final' : 'dev']));
for (const t of tasks) t.tier = tierOf.get(t.group);

// Within a group the order is by hash of the id; the first CAP take part (the cap bounds repeats).
// FeatureBench ships the same target twice (lv1 and lv2): only one of each pair may take part.
const twinKey = (t) => (t.source === 'featurebench' ? t.id.replace(/\.lv[0-9]+$/, '') : t.id);
const twins = new Map();
for (const t of tasks) (twins.get(twinKey(t)) ?? twins.set(twinKey(t), []).get(twinKey(t))).push(t);
for (const list of twins.values()) {
  list.sort((a, b) => h(a.id).localeCompare(h(b.id)));
  list.slice(1).forEach((t) => (t.twinOf = list[0].id));
}
const byGroup = new Map();
for (const t of tasks.filter((x) => !x.twinOf))
  (byGroup.get(t.group) ?? byGroup.set(t.group, []).get(t.group)).push(t);
for (const list of byGroup.values()) {
  list.sort((a, b) => h(a.id).localeCompare(h(b.id)));
  list.forEach((t, i) => {
    t.rank = i;
    t.capped = i >= (t.tier === 'final' ? CAP_FINAL : CAP_DEV);
  });
}

const summary = {};
for (const t of tasks.filter((x) => !x.twinOf)) {
  const k = `${t.tier}/${t.source}`;
  summary[k] ??= { all: 0, withinCap: 0 };
  summary[k].all++;
  if (!t.capped) summary[k].withinCap++;
}
console.log(JSON.stringify({ groups: groups.length, summary }, null, 1));

// no group may sit in two tiers
const seen = new Map();
for (const t of tasks) {
  if (seen.has(t.group) && seen.get(t.group) !== t.tier)
    throw new Error(`group ${t.group} in two tiers`);
  seen.set(t.group, t.tier);
}
const out = process.env.OUT ?? 'manifest.json';
writeFileSync(out, JSON.stringify({ salt: SALT, finalShare: FINAL_SHARE, tasks }, null, 1));
console.log('wrote', out, tasks.length, 'tasks');
