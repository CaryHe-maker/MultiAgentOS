// Summarises the lines of results.jsonl of one label as a markdown table, paired by task.
//   node summarize.mjs <results.jsonl> <label> [--md]
import { readFileSync } from 'node:fs';

const [, , file, label] = process.argv;
const rows = readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((r) => label.split(',').includes(r.label));
const tasks = [...new Set(rows.map((r) => r.task))].sort();
const by = (system, task) => rows.filter((r) => r.system === system && r.task === task).at(-1);
// Prompt tokens in total: what the model read, cached or not (mas counts them apart from the cache).
// mas records the prompt tokens with the cache hits inside them (OpenAI form); dsh records them apart
// from the cache (Anthropic form). Both are brought to "everything the model read".
const prompt = (r) =>
  r?.usage
    ? r.system === 'mas'
      ? (r.usage.input ?? 0)
      : (r.usage.input ?? 0) + (r.usage.cacheRead ?? 0) + (r.usage.cacheWrite ?? 0)
    : null;
const hit = (r) => (r?.usage ? (r.usage.cacheRead ?? 0) : 0);
const fmt = (r) =>
  r === undefined
    ? '—'
    : `${r.reward === 1 ? 'pass' : r.reward === 0 ? 'FAIL' : 'n/a'} ${r.agentSeconds}s ${((prompt(r) ?? 0) / 1000).toFixed(0)}k/${((r.usage?.output ?? 0) / 1000).toFixed(1)}k r${r.usage?.requests ?? '?'} c${prompt(r) ? Math.round((100 * hit(r)) / prompt(r)) : 0}%`;
console.log('| task | mas | dsh |');
console.log('|---|---|---|');
for (const t of tasks) console.log(`| ${t.replace(/^instance_/, '').slice(0, 44)} | ${fmt(by('mas', t))} | ${fmt(by('dsh', t))} |`);
const total = (system) => {
  const rs = tasks.map((t) => by(system, t)).filter(Boolean);
  const passes = rs.filter((r) => r.reward === 1).length;
  const secs = rs.reduce((s, r) => s + (r.agentSeconds ?? 0), 0);
  const tok = rs.reduce((s, r) => s + (prompt(r) ?? 0) + (r.usage?.output ?? 0), 0);
  const req = rs.reduce((s, r) => s + (r.usage?.requests ?? 0), 0);
  return `${system}: ${passes}/${rs.length} pass, ${secs.toFixed(0)} s agent time, ${(tok / 1000).toFixed(0)}k tokens (prompt+output), ${req} requests`;
};
console.log('\n' + total('mas') + '\n' + total('dsh'));
console.log('(per cell: result, agent seconds, prompt tokens / output tokens, model requests)');
