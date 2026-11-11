// Picks the tasks of each tier from the manifest by STATIC properties only (no run result of any
// model decides what is in a tier). Quotas follow the time budget: final = one system, one run, 1.5 h;
// dev = one system, one run, 3 h; three runs in parallel; every task is cut at 15 minutes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const META = process.env.META ?? `${process.env.HOME}/benchmeta`;
const manifest = JSON.parse(readFileSync(`${META}/manifest.json`, 'utf8'));
const SALT = manifest.salt;
const h = (s) => createHash('sha256').update(`${SALT}|pick|${s}`).digest('hex');

// the oracle check (reference solution passes, empty solution fails) of tasks already screened
const bad = new Set();
const good = new Set();
const screenFile = `${process.env.HOME}/screen/tb2.jsonl`;
if (existsSync(screenFile)) {
  const seen = {};
  for (const line of readFileSync(screenFile, 'utf8').trim().split('\n')) {
    const j = JSON.parse(line);
    (seen[j.task] ??= {})[j.mode] = j.reward;
  }
  for (const [task, r] of Object.entries(seen)) {
    if (r.oracle === 0 || r.empty === 1) bad.add(`tb2/${task}`);
    else if (r.oracle === 1 && r.empty === 0) good.add(`tb2/${task}`);
  }
}

const live = manifest.tasks.filter((t) => !t.twinOf && !bad.has(t.id));
const eligible = {
  'terminal-bench-2.0': (t) =>
    t.agentTimeoutSec <= 900 &&
    t.gpus === 0 &&
    t.memoryMb <= 4096 &&
    !['mathematics', 'model-training'].includes(t.category),
  featurebench: (t) => t.inFast && t.patchLines <= 700 && t.patchFiles <= 5,
  'swe-bench-pro': (t) => t.patchFiles <= 3 && t.patchLines <= 150,
};
const quota = {
  final: { 'terminal-bench-2.0': 14, 'swe-bench-pro': 10 },
  dev: { 'terminal-bench-2.0': 22, 'swe-bench-pro': 18 },
};
const capOf = { final: 3, dev: 5 };
const RESERVE = 3;

const selection = {};
for (const tier of ['final', 'dev']) {
  selection[tier] = {};
  for (const [source, n] of Object.entries(quota[tier])) {
    const pool = live
      .filter((t) => t.tier === tier && t.source === source && eligible[source](t))
      .sort((a, b) => h(a.id).localeCompare(h(b.id)));
    // turns over the buckets (category for Terminal-Bench, repository otherwise) so no bucket dominates
    const bucketOf = (t) => (source === 'terminal-bench-2.0' ? t.category : t.group);
    const buckets = new Map();
    for (const t of pool)
      (buckets.get(bucketOf(t)) ?? buckets.set(bucketOf(t), []).get(bucketOf(t))).push(t);
    const order = [...buckets.keys()].sort((a, b) => h(a).localeCompare(h(b)));
    const taken = [];
    const perGroup = {};
    for (let round = 0; taken.length < n + RESERVE && round < 50; round++) {
      for (const key of order) {
        const t = buckets.get(key)[round];
        if (!t || taken.length >= n + RESERVE) continue;
        if ((perGroup[t.group] ?? 0) >= capOf[tier]) continue;
        perGroup[t.group] = (perGroup[t.group] ?? 0) + 1;
        taken.push(t);
      }
    }
    selection[tier][source] = {
      quota: n,
      poolSize: pool.length,
      picked: taken.slice(0, n).map((t) => t.id),
      reserve: taken.slice(n).map((t) => t.id),
    };
  }
}
for (const tier of ['final', 'dev'])
  for (const [s, v] of Object.entries(selection[tier]))
    console.log(
      tier,
      s.padEnd(20),
      `quota ${v.quota} pool ${v.poolSize} picked ${v.picked.length} reserve ${v.reserve.length}`,
    );
writeFileSync(
  process.env.OUT ?? 'selection.json',
  JSON.stringify({ salt: SALT, selection, oracleBad: [...bad], oracleGood: [...good] }, null, 1),
);
for (const tier of ['final'])
  for (const [s, v] of Object.entries(selection[tier]))
    console.log(s, '\n ' + v.picked.join('\n '));
