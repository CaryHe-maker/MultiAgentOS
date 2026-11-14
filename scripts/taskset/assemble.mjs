// Writes the task lists of both tiers (coding from selection.json, parallel from the generated
// directories) and the hash of each list, so a later change to a sealed list is visible.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const home = process.env.HOME;
const sel = JSON.parse(readFileSync(`${home}/benchmeta/selection.json`, 'utf8'));
const hash = (ids) =>
  createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
const out = { salt: sel.salt, tiers: {} };
for (const tier of ['dev', 'final']) {
  const coding = Object.values(sel.selection[tier]).flatMap((v) => v.picked);
  const reserve = Object.values(sel.selection[tier]).flatMap((v) => v.reserve);
  const parallel = readdirSync(`${home}/taskset/${tier}/parallel`)
    .sort()
    .map((d) => `parallel/${tier}/${d}`);
  out.tiers[tier] = {
    coding,
    parallel,
    reserve,
    counts: { coding: coding.length, parallel: parallel.length },
    sha256: hash([...coding, ...parallel]),
  };
}
out.oracleBad = sel.oracleBad;
writeFileSync(process.argv[2] ?? 'taskset.json', JSON.stringify(out, null, 1) + '\n');
console.log(
  JSON.stringify({
    dev: out.tiers.dev.counts,
    final: out.tiers.final.counts,
    devHash: out.tiers.dev.sha256,
    finalHash: out.tiers.final.sha256,
  }),
);
