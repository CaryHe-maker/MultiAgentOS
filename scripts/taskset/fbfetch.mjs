// Downloads the FeatureBench rows (all splits) through the Hugging Face datasets server.
import { writeFileSync } from 'node:fs';

const base = 'https://datasets-server.huggingface.co';
const splits = await (await fetch(`${base}/splits?dataset=LiberCoders/FeatureBench`)).json();
console.log(JSON.stringify(splits.splits));
const all = {};
for (const { config, split } of splits.splits) {
  const rows = [];
  for (let offset = 0; ; offset += 20) {
    const r = await fetch(
      `${base}/rows?dataset=LiberCoders/FeatureBench&config=${config}&split=${split}&offset=${offset}&length=20`,
    );
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const j = await r.json();
    for (const row of j.rows) rows.push(row.row);
    if (rows.length >= j.num_rows_total || j.rows.length === 0) break;
  }
  all[`${config}/${split}`] = rows;
  console.log(config, split, rows.length);
}
writeFileSync(process.env.OUT ?? 'fb.json', JSON.stringify(all));
