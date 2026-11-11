// Text-level duplicate check across all candidate tasks: 5-word shingles, Jaccard similarity.
// Pairs at or above THRESHOLD are reported; the split script treats them as one group later.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const META = process.env.META ?? `${process.env.HOME}/benchmeta`;
const THRESHOLD = Number(process.env.THRESHOLD ?? '0.5');
const docs = [];

for (const name of readdirSync(join(META, 'tb2'))) {
  const f = join(META, 'tb2', name, 'instruction.md');
  if (existsSync(f)) docs.push({ id: `tb2/${name}`, text: readFileSync(f, 'utf8') });
}
for (const name of readdirSync(join(META, 'sbp', 'v2', 'tasks'))) {
  const f = join(META, 'sbp', 'v2', 'tasks', name, 'instruction.md');
  if (existsSync(f)) docs.push({ id: `sbp/${name}`, text: readFileSync(f, 'utf8') });
}
const fb = JSON.parse(readFileSync(join(META, 'fb.json'), 'utf8'));
for (const r of fb['default/full'])
  docs.push({ id: `fb/${r.instance_id}`, text: r.problem_statement });
for (const name of readdirSync(join(META, 'lbt', 'tasks'))) {
  const dir = join(META, 'lbt', 'tasks', name);
  const yaml = readFileSync(join(dir, 'module_dag.yaml'), 'utf8');
  const reqs = readdirSync(join(dir, 'requirements'))
    .map((f) => readFileSync(join(dir, 'requirements', f), 'utf8'))
    .join('\n');
  docs.push({ id: `lb/${name}`, text: yaml + '\n' + reqs });
}

const shingles = (text) => {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_ ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 5 <= words.length; i++) set.add(words.slice(i, i + 5).join(' '));
  return set;
};
for (const d of docs) d.set = shingles(d.text);

const pairs = [];
for (let i = 0; i < docs.length; i++) {
  for (let j = i + 1; j < docs.length; j++) {
    const a = docs[i].set;
    const b = docs[j].set;
    if (a.size === 0 || b.size === 0) continue;
    const [small, large] = a.size < b.size ? [a, b] : [b, a];
    if (small.size / large.size < THRESHOLD) continue; // Jaccard cannot reach the threshold
    let inter = 0;
    for (const s of small) if (large.has(s)) inter++;
    const jac = inter / (a.size + b.size - inter);
    if (jac >= THRESHOLD)
      pairs.push({ a: docs[i].id, b: docs[j].id, jaccard: Number(jac.toFixed(3)) });
  }
}
pairs.sort((x, y) => y.jaccard - x.jaccard);
console.log('docs', docs.length, 'pairs>=', THRESHOLD, pairs.length);
for (const p of pairs.slice(0, 40)) console.log(p.jaccard, p.a, '|', p.b);
writeFileSync(process.env.OUT ?? 'dups.json', JSON.stringify(pairs, null, 1));
