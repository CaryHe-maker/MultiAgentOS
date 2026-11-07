/**
 * `tsx .../run-web-eval.ts --yes --out <dir> [--budget N] [W-T1 ... W-T7]`: the experiments of
 * M2TechStack 3.3 (task S6-T-1) against DeepSeek's search and fetch interface. Every call is
 * counted against `--budget` (at most 200 requests by default, about 0.15 dollars at the published
 * price); raw facts go to `<out>/records.jsonl` and a table to `<out>/summary.json`. The key comes
 * from `DEEPSEEK_API_KEY` or the file named by `MAO_ENV_FILE` and is never printed or recorded.
 * Nothing runs without `--yes`.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import dotenv from 'dotenv';

const BASE = 'https://api.deepseek.com';
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
if (!argv.includes('--yes')) {
  process.stdout.write(
    'Nothing was run. Add --yes (and --out <dir>). It costs about 0.15 dollars.\n',
  );
  process.exit(0);
}
const out = option('--out');
if (out === undefined) throw new Error('--out <dir> is required');
const budget = Number(option('--budget') ?? '200');
const wanted = argv.filter((arg) => /^W-T[1-7]$/u.test(arg));
const runs = (id: string) => wanted.length === 0 || wanted.includes(id);
dotenv.config({ path: process.env['MAO_ENV_FILE'] ?? '.env', quiet: true });
const key = (process.env['DEEPSEEK_API_KEY'] ?? '').trim();
if (key === '') {
  process.stderr.write('DEEPSEEK_API_KEY is not set\n');
  process.exit(2);
}
await mkdir(out, { recursive: true });

let used = 0;
interface Call {
  readonly status: number;
  readonly ms: number;
  readonly json?: unknown;
  readonly text: string;
}
const recordsFile = join(out, 'records.jsonl');
const record = (entry: Record<string, unknown>) =>
  appendFile(recordsFile, `${JSON.stringify(entry)}\n`);

/** One call; the key is only ever in the header of the request. */
async function call(
  task: string,
  tool: 'search' | 'fetch',
  body: unknown,
  options: { readonly key?: string; readonly count?: boolean } = {},
): Promise<Call> {
  if (options.count !== false) {
    if (used >= budget) throw new Error(`the budget of ${String(budget)} requests is used`);
    used += 1;
  }
  const started = Date.now();
  let status: number;
  let text: string;
  try {
    const response = await fetch(`${BASE}/v1/tools/${tool}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.key ?? key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    status = 0;
    text = error instanceof Error ? error.message : 'failed';
  }
  const ms = Date.now() - started;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const summary =
    json !== null && typeof json === 'object' && 'results' in json
      ? { results: (json as { results: unknown[] }).results.length }
      : { bytes: text.length, head: text.slice(0, 160) };
  await record({ task, tool, request: body, status, ms, ...summary });
  return { status, ms, ...(json === undefined ? {} : { json }), text };
}

async function balance(): Promise<number | undefined> {
  try {
    const response = await fetch(`${BASE}/user/balance`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await response.json()) as { balance_infos?: { total_balance?: string }[] };
    const value = Number(data.balance_infos?.[0]?.total_balance);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

interface Result {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly summary: string;
  readonly date: string | null;
  readonly rerank_score: number;
  readonly authority: number;
}
const resultsOf = (call: Call): Result[] =>
  call.json !== null && typeof call.json === 'object' && 'results' in call.json
    ? ((call.json as { results: Result[] }).results ?? [])
    : [];
const contentOf = (call: Call): { title: string; content: string } | undefined =>
  call.status === 200 &&
  call.json !== null &&
  typeof call.json === 'object' &&
  'content' in call.json
    ? (call.json as { title: string; content: string })
    : undefined;
const p = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

const summary: Record<string, unknown> = { startedAt: new Date().toISOString(), budget };
const balanceBefore = await balance();
summary['balanceBefore'] = balanceBefore;

// --- W-T1: the protocol -------------------------------------------------------------------------
if (runs('W-T1')) {
  const rows: Record<string, unknown>[] = [];
  const add = (name: string, expected: string, got: Call, ok: boolean) =>
    rows.push({ name, expected, status: got.status, ok, body: got.text.slice(0, 160) });
  const search = await call('W-T1', 'search', { query: 'Node.js release schedule', count: 3 });
  add(
    'search ok',
    '200 with results',
    search,
    search.status === 200 && resultsOf(search).length > 0,
  );
  const fetched = await call('W-T1', 'fetch', {
    url: 'https://nodejs.org/en/about/previous-releases',
  });
  add(
    'fetch ok',
    '200 with content',
    fetched,
    fetched.status === 200 && contentOf(fetched) !== undefined,
  );
  const bad = await call('W-T1', 'search', { query: 'x' }, { key: 'sk-wrong' });
  add('wrong key', '401', bad, bad.status === 401);
  const long = await call('W-T1', 'search', { query: 'a'.repeat(129) });
  add('query over 128', '400', long, long.status === 400);
  const over = await call('W-T1', 'search', { query: 'node', count: 51 });
  add('count over 50', '400', over, over.status === 400);
  const missing = await call('W-T1', 'fetch', {
    url: 'https://example.com/definitely-not-here-9f3a7c',
  });
  add('missing page', '404', missing, missing.status === 404);
  for (const url of [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
  ]) {
    const refused = await call('W-T1', 'fetch', { url });
    add(
      `forbidden ${url}`,
      '403 or 400, no body',
      refused,
      [400, 403, 404].includes(refused.status) && contentOf(refused) === undefined,
    );
  }
  const empty = await call('W-T1', 'search', { query: 'zzqxjv kkwpplm 9482 qwexyz plmokn' });
  add('empty result', '200 with []', empty, empty.status === 200 && resultsOf(empty).length === 0);
  const unknown = await call('W-T1', 'search', { query: 'Node.js', count: 1, nonsense: true });
  add('unknown field', '200 (ignored)', unknown, unknown.status === 200);
  summary['W-T1'] = {
    passed: rows.filter((row) => row['ok'] === true).length,
    total: rows.length,
    rows,
  };
}

// --- W-T2: search quality -----------------------------------------------------------------------
interface Query {
  readonly q: string;
  /** Any of these in the title, url or summary of one of the first three results makes it relevant. */
  readonly expect: readonly string[];
  readonly operator?: 'site' | 'after';
  readonly arg?: string;
}
const QUERIES: readonly Query[] = [
  { q: 'Node.js fs.promises readFile documentation', expect: ['nodejs.org', 'readFile'] },
  {
    q: 'TypeError: Cannot read properties of undefined (reading map)',
    expect: ['undefined', 'stackoverflow'],
  },
  { q: 'latest stable version of TypeScript', expect: ['typescript'] },
  { q: 'Python asyncio gather official documentation', expect: ['docs.python.org', 'gather'] },
  { q: 'React useEffect cleanup function', expect: ['react.dev', 'useEffect'] },
  { q: 'Rust ownership and borrowing explained', expect: ['rust-lang.org', 'ownership'] },
  { q: 'git rebase vs merge difference', expect: ['rebase', 'merge'] },
  { q: 'Docker compose healthcheck depends_on condition', expect: ['docker', 'healthcheck'] },
  { q: 'PostgreSQL index types btree gin gist', expect: ['postgresql', 'gin'] },
  { q: 'Kubernetes liveness readiness probe', expect: ['kubernetes', 'probe'] },
  { q: 'Express.js 中间件 错误处理', expect: ['express', '中间件'] },
  { q: 'Vue 3 组合式 API 教程', expect: ['vue', '组合式'] },
  { q: 'Linux 查看端口占用 命令', expect: ['端口', 'lsof', 'netstat'] },
  { q: 'DeepSeek API pricing', expect: ['deepseek'] },
  { q: 'OpenAI Responses API reference', expect: ['openai'] },
  { q: 'sqlite WAL mode explained', expect: ['wal', 'sqlite'] },
  { q: 'vite config proxy site:vite.dev', expect: ['vite.dev'], operator: 'site', arg: 'vite.dev' },
  { q: 'react hooks site:react.dev', expect: ['react.dev'], operator: 'site', arg: 'react.dev' },
  {
    q: 'typescript release notes after:2025-06-01',
    expect: ['typescript'],
    operator: 'after',
    arg: '2025-06-01',
  },
  {
    q: 'node.js security release after:2025-01-01',
    expect: ['node'],
    operator: 'after',
    arg: '2025-01-01',
  },
];
if (runs('W-T2')) {
  const rows: Record<string, unknown>[] = [];
  const scores: number[] = [];
  let relevant = 0;
  let operatorsOk = 0;
  let operatorsTotal = 0;
  for (const query of QUERIES) {
    const result = await call('W-T2', 'search', { query: query.q, count: 10 });
    const results = resultsOf(result);
    for (const item of results) scores.push(item.rerank_score);
    const top = results.slice(0, 3);
    const hit = top.some((item) =>
      query.expect.some((word) =>
        `${item.title} ${item.url} ${item.summary}`.toLowerCase().includes(word.toLowerCase()),
      ),
    );
    if (query.operator === undefined && hit) relevant += 1;
    let operator: boolean | undefined;
    if (query.operator === 'site')
      operator = results.length > 0 && results.every((item) => item.url.includes(query.arg ?? ''));
    if (query.operator === 'after')
      operator =
        results.length > 0 &&
        results.every(
          (item) => item.date === null || Date.parse(item.date) >= Date.parse(query.arg ?? ''),
        );
    if (operator !== undefined) {
      operatorsTotal += 1;
      if (operator) operatorsOk += 1;
    }
    rows.push({
      q: query.q,
      status: result.status,
      results: results.length,
      relevantInTop3: hit,
      operatorHeld: operator,
      withDate: results.filter((item) => item.date !== null).length,
      top: top.map(
        (item) => `${item.rerank_score.toFixed(2)} a${String(item.authority)} ${item.url}`,
      ),
    });
  }
  const plain = QUERIES.filter((query) => query.operator === undefined).length;
  summary['W-T2'] = {
    relevantInTop3: `${String(relevant)}/${String(plain)}`,
    operators: `${String(operatorsOk)}/${String(operatorsTotal)}`,
    rerankP10P50P90: [p(scores, 0.1), p(scores, 0.5), p(scores, 0.9)],
    rows,
  };
}

// --- W-T3: fetching -------------------------------------------------------------------------------
interface Target {
  readonly category: string;
  readonly url: string;
  /** Text a good page must contain, so a login wall or an empty shell does not count. */
  readonly must?: string;
}
const TARGETS: readonly Target[] = [
  { category: 'static docs', url: 'https://nodejs.org/api/fs.html', must: 'readFile' },
  {
    category: 'static docs',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map',
    must: 'map',
  },
  {
    category: 'static docs',
    url: 'https://docs.python.org/3/library/asyncio-task.html',
    must: 'gather',
  },
  {
    category: 'static docs',
    url: 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html',
    must: 'string',
  },
  { category: 'github readme', url: 'https://github.com/microsoft/TypeScript', must: 'TypeScript' },
  { category: 'github readme', url: 'https://github.com/facebook/react', must: 'React' },
  {
    category: 'github source',
    url: 'https://github.com/expressjs/express/blob/master/lib/express.js',
    must: 'createApplication',
  },
  {
    category: 'github raw',
    url: 'https://raw.githubusercontent.com/expressjs/express/master/package.json',
    must: 'express',
  },
  {
    category: 'github issue',
    url: 'https://github.com/microsoft/TypeScript/issues/1',
    must: 'TypeScript',
  },
  { category: 'spa', url: 'https://angular.dev/overview', must: 'Angular' },
  { category: 'spa', url: 'https://www.reddit.com/r/programming/', must: 'programming' },
  {
    category: 'pdf',
    url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    must: 'Dummy',
  },
  {
    category: 'long page',
    url: 'https://en.wikipedia.org/wiki/List_of_programming_languages',
    must: 'Python',
  },
  { category: 'chinese', url: 'https://zh.wikipedia.org/wiki/JavaScript', must: 'JavaScript' },
  {
    category: 'chinese',
    url: 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript',
    must: 'JavaScript',
  },
  { category: 'redirect', url: 'http://github.com/microsoft/vscode', must: 'Visual Studio Code' },
  { category: 'redirect', url: 'https://httpbin.org/redirect/3', must: undefined },
  {
    category: 'missing',
    url: 'https://github.com/this-does-not-exist-xyz-123/none',
    must: undefined,
  },
  { category: 'disallowed', url: 'https://www.google.com/search?q=test', must: undefined },
  { category: 'login', url: 'https://github.com/settings/profile', must: undefined },
];
const fetched = new Map<string, Call>();
if (runs('W-T3')) {
  const rows: Record<string, unknown>[] = [];
  for (const target of TARGETS) {
    const result = await call('W-T3', 'fetch', { url: target.url });
    fetched.set(target.url, result);
    const page = contentOf(result);
    const text = page?.content ?? '';
    rows.push({
      category: target.category,
      url: target.url,
      status: result.status,
      ok: page !== undefined && (target.must === undefined || text.includes(target.must)),
      ms: result.ms,
      bytes: text.length,
      headings: (text.match(/^#{1,6} /gmu) ?? []).length,
      codeBlocks: Math.floor((text.match(/```/gu) ?? []).length / 2),
      links: (text.match(/\]\(http/gu) ?? []).length,
      tables: (text.match(/^\|.*\|$/gmu) ?? []).length,
      truncated: /truncat/iu.test(text.slice(-300)),
    });
  }
  const statics = rows.filter((row) =>
    ['static docs', 'github readme', 'github source', 'github raw', 'github issue'].includes(
      String(row['category']),
    ),
  );
  summary['W-T3'] = {
    staticAndGithub: `${String(statics.filter((row) => row['ok'] === true).length)}/${String(statics.length)}`,
    byCategory: Object.fromEntries(
      [...new Set(rows.map((row) => String(row['category'])))].map((category) => {
        const some = rows.filter((row) => row['category'] === category);
        return [
          category,
          `${String(some.filter((row) => row['ok'] === true).length)}/${String(some.length)}`,
        ];
      }),
    ),
    rows,
  };
}

// --- W-T4: latency and limits --------------------------------------------------------------------
if (runs('W-T4')) {
  const searchMs: number[] = [];
  const fetchMs: number[] = [];
  for (let i = 0; i < 12; i += 1)
    searchMs.push(
      (await call('W-T4', 'search', { query: `node.js release ${String(i)}`, count: 3 })).ms,
    );
  for (let i = 0; i < 12; i += 1)
    fetchMs.push((await call('W-T4', 'fetch', { url: 'https://nodejs.org/api/path.html' })).ms);
  const burst = await Promise.all(
    Array.from({ length: 30 }, () =>
      call('W-T4', 'fetch', { url: 'https://nodejs.org/api/os.html' }),
    ),
  );
  const statuses = new Map<number, number>();
  for (const each of burst) statuses.set(each.status, (statuses.get(each.status) ?? 0) + 1);
  summary['W-T4'] = {
    searchMs: { p50: p(searchMs, 0.5), p95: p(searchMs, 0.95) },
    fetchMs: { p50: p(fetchMs, 0.5), p95: p(fetchMs, 0.95) },
    burstOf30: Object.fromEntries(statuses),
    note: 'serial runs are 12 each and the burst 30 to stay inside the budget',
  };
}

// --- W-T6: injected text is passed on unchanged --------------------------------------------------
if (runs('W-T6')) {
  const page = await call('W-T6', 'fetch', {
    url: 'https://en.wikipedia.org/wiki/Prompt_injection',
  });
  const text = contentOf(page)?.content ?? '';
  summary['W-T6'] = {
    status: page.status,
    bytes: text.length,
    containsInjectionWording: /ignore (all )?(previous|prior) instructions/iu.test(text),
    note: 'the wrapper that marks the text untrusted is ours and is tested apart (web-exit)',
  };
}

// --- W-T7: the smallest local fetcher, for comparison --------------------------------------------
if (runs('W-T7')) {
  const rows: Record<string, unknown>[] = [];
  for (const target of TARGETS) {
    const started = Date.now();
    let status: number;
    let text: string;
    try {
      const response = await fetch(target.url, {
        redirect: 'follow',
        headers: { 'user-agent': 'multiagentos-web-eval/0.1' },
        signal: AbortSignal.timeout(30_000),
      });
      status = response.status;
      const type = response.headers.get('content-type') ?? '';
      const body = await response.text();
      text = type.includes('html')
        ? body
            .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/giu, '')
            .replace(/<(h[1-6])[^>]*>/giu, '\n# ')
            .replace(/<[^>]+>/gu, ' ')
            .replace(/\s+/gu, ' ')
        : type.includes('text') || type.includes('json')
          ? body
          : '';
    } catch {
      status = 0;
      text = '';
    }
    rows.push({
      category: target.category,
      url: target.url,
      status,
      ok:
        status === 200 &&
        text.length > 0 &&
        (target.must === undefined || text.includes(target.must)),
      ms: Date.now() - started,
      bytes: text.length,
    });
  }
  summary['W-T7'] = {
    ok: `${String(rows.filter((row) => row['ok'] === true).length)}/${String(rows.length)}`,
    byCategory: Object.fromEntries(
      [...new Set(rows.map((row) => String(row['category'])))].map((category) => {
        const some = rows.filter((row) => row['category'] === category);
        return [
          category,
          `${String(some.filter((row) => row['ok'] === true).length)}/${String(some.length)}`,
        ];
      }),
    ),
    rows,
  };
}

// --- W-T5: billing, read from the account balance over the whole run ---------------------------
const balanceAfter = await balance();
summary['balanceAfter'] = balanceAfter;
summary['requestsMade'] = used;
if (runs('W-T5'))
  summary['W-T5'] = {
    balanceBefore,
    balanceAfter,
    spent:
      balanceBefore === undefined || balanceAfter === undefined
        ? undefined
        : Number((balanceBefore - balanceAfter).toFixed(6)),
    requests: used,
    expectedAtMost: Number(((used * 0.75) / 1000).toFixed(4)),
    note: 'the balance has the resolution the account shows; compare with the price per successful request',
  };
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
process.stdout.write(
  `${JSON.stringify({ ...summary, rowsOmitted: true }, (k, v: unknown) => (k === 'rows' ? undefined : v), 2)}\n`,
);
process.exit(0);
