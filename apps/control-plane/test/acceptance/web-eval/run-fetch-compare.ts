/**
 * `tsx .../run-fetch-compare.ts --yes --out <file> --budget N [ids...]`: the same real addresses
 * read three ways (docs/History/M2/Evaluation/Stage6FetchOrder.md): by this program's own fetch alone, by
 * DeepSeek's fetch alone, and by the combination the product uses (own first, DeepSeek when it
 * cannot). A case is good when it completed, held a word that only the real page has, and gave
 * the answer the case expects (a missing page and a PDF are expected to fail, an address that
 * moves to another host is expected to say where). One line per case is appended to `--out`;
 * cases already there are skipped. `--budget` caps the DeepSeek requests of the whole run; the key
 * comes from `DEEPSEEK_API_KEY` or the file named by `MAO_ENV_FILE`, and is never written down.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import dotenv from 'dotenv';
import {
  DENY_SANDBOX,
  type ExecutorEnvironment,
  type ExecutorOutcome,
} from '@multiagentos/contracts';
import {
  DEFAULT_WEB_CONFIG,
  createDeepSeekFetch,
  createWebFetchExecutor,
  type WebConfig,
} from '@multiagentos/executor-set';

type Expect = 'page' | 'missing' | 'not-text' | 'moved';

interface Case {
  readonly id: string;
  readonly category: string;
  readonly url: string;
  /** Any of these (case-insensitive) must be in a good page. */
  readonly markers: readonly string[];
  /** A good page has at least this much text of its own (the frame the tool adds is not counted). */
  readonly minChars?: number;
  readonly expect?: Expect;
}

const C = (
  category: string,
  id: string,
  url: string,
  markers: readonly string[],
  expect: Expect = 'page',
): Case => ({
  id,
  category,
  url,
  markers,
  expect,
  ...(category === 'hard' || category === 'spa'
    ? { minChars: 1_500 }
    : category === 'data'
      ? { minChars: 50 }
      : {}),
});

const CASES: readonly Case[] = [
  C('docs', 'py-json', 'https://docs.python.org/3/library/json.html', ['json.dumps']),
  C('docs', 'py-asyncio', 'https://docs.python.org/3/library/asyncio-task.html', ['create_task']),
  C(
    'docs',
    'mdn-array-map',
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map',
    ['callbackFn'],
  ),
  C('docs', 'mdn-fetch', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', [
    'Fetch API',
  ]),
  C('docs', 'node-fs', 'https://nodejs.org/api/fs.html', ['fs.readFile']),
  C('docs', 'ts-generics', 'https://www.typescriptlang.org/docs/handbook/2/generics.html', [
    'generic',
  ]),
  C('docs', 'rust-ownership', 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', [
    'ownership',
  ]),
  C('docs', 'go-effective', 'https://go.dev/doc/effective_go', ['Effective Go']),
  C('docs', 'k8s-pods', 'https://kubernetes.io/docs/concepts/workloads/pods/', ['Pods']),
  C('docs', 'react-learn', 'https://react.dev/learn', ['component']),
  C('docs', 'vue-intro', 'https://vuejs.org/guide/introduction.html', ['Vue']),
  C('docs', 'tailwind-install', 'https://tailwindcss.com/docs/installation', ['Tailwind']),
  C('docs', 'nextjs-docs', 'https://nextjs.org/docs', ['Next.js']),
  C('docs', 'aws-s3', 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html', ['S3']),
  C('wiki', 'wiki-http', 'https://en.wikipedia.org/wiki/HTTP', ['Hypertext Transfer Protocol']),
  C('wiki', 'wiki-list', 'https://en.wikipedia.org/wiki/List_of_programming_languages', ['Python']),
  C('wiki', 'wiki-zh', 'https://zh.wikipedia.org/wiki/HTTP', ['超文本传输协议']),
  C('github', 'gh-readme', 'https://github.com/microsoft/TypeScript', ['TypeScript']),
  C('github', 'gh-issue', 'https://github.com/facebook/react/issues/1', ['react']),
  C('github', 'gh-raw', 'https://raw.githubusercontent.com/microsoft/TypeScript/main/README.md', [
    'TypeScript',
  ]),
  C('github', 'gh-blob', 'https://github.com/vitejs/vite/blob/main/package.json', ['vite']),
  C('github', 'gh-api', 'https://api.github.com/repos/nodejs/node', ['full_name']),
  C('github', 'gh-releases', 'https://github.com/microsoft/vscode/releases', ['release']),
  C(
    'qa-blog',
    'so-branch',
    'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
    ['branch prediction'],
  ),
  C('qa-blog', 'hn', 'https://news.ycombinator.com/', ['Hacker News']),
  C('qa-blog', 'dev-to', 'https://dev.to/', ['DEV']),
  C('qa-blog', 'rust-blog', 'https://blog.rust-lang.org/', ['Rust']),
  C('qa-blog', 'ruanyifeng', 'https://www.ruanyifeng.com/blog/2016/07/yaml.html', ['YAML']),
  C('papers', 'arxiv-abs', 'https://arxiv.org/abs/1706.03762', ['Attention Is All You Need']),
  C('papers', 'arxiv-pdf', 'https://arxiv.org/pdf/1706.03762', [], 'not-text'),
  C('papers', 'rfc-txt', 'https://www.rfc-editor.org/rfc/rfc9110.txt', ['HTTP Semantics']),
  C('papers', 'rfc-html', 'https://www.rfc-editor.org/rfc/rfc9110.html', ['HTTP Semantics']),
  C('hard', 'reddit', 'https://www.reddit.com/r/programming/', ['programming']),
  C('hard', 'x-profile', 'https://x.com/nodejs', ['Node']),
  C('hard', 'npm-express', 'https://www.npmjs.com/package/express', ['express']),
  C('hard', 'bbc-news', 'https://www.bbc.com/news', ['BBC']),
  C('hard', 'medium', 'https://medium.com/', ['Medium']),
  C('hard', 'cloudflare', 'https://www.cloudflare.com/', ['Cloudflare']),
  C('hard', 'zhihu', 'https://www.zhihu.com/', ['知乎']),
  C('spa', 'todomvc-react', 'https://todomvc.com/examples/react/dist/', ['todos']),
  C('spa', 'openai-docs', 'https://platform.openai.com/docs/overview', ['OpenAI']),
  C('data', 'json-api', 'https://jsonplaceholder.typicode.com/todos/1', ['userId']),
  C('edge', 'py-404', 'https://docs.python.org/3/library/nonexistent-page.html', [], 'missing'),
  C('edge', 'http-to-https', 'http://docs.python.org/3/', ['Python']),
  C(
    'edge',
    'pep8-offhost',
    'https://www.python.org/dev/peps/pep-0008/',
    ['peps.python.org'],
    'moved',
  ),
  C('docs', 'docker-run', 'https://docs.docker.com/reference/cli/docker/container/run/', [
    'docker container run',
  ]),
  C('docs', 'ms-learn', 'https://learn.microsoft.com/en-us/dotnet/csharp/tour-of-csharp/', ['C#']),
  C('docs', 'go-pkg-http', 'https://pkg.go.dev/net/http', ['ListenAndServe']),
  C('docs', 'hf-transformers', 'https://huggingface.co/docs/transformers/index', ['Transformers']),
  C('docs', 'sqlite-select', 'https://www.sqlite.org/lang_select.html', ['SELECT']),
  C('docs', 'pg-select', 'https://www.postgresql.org/docs/current/sql-select.html', ['SELECT']),
  C('edge', 'w3-offhost', 'https://www.w3.org/TR/html52/', ['html.spec.whatwg.org'], 'moved'),
  C('wiki', 'wiki-redirect', 'https://en.wikipedia.org/wiki/HTML5', ['HTML']),
  C('qa-blog', 'fowler-micro', 'https://martinfowler.com/articles/microservices.html', [
    'microservice',
  ]),
  C('qa-blog', 'paulgraham', 'https://paulgraham.com/greatwork.html', ['work']),
  C('qa-blog', 'cf-blog', 'https://blog.cloudflare.com/', ['Cloudflare']),
  C('qa-blog', 'lobsters', 'https://lobste.rs/', ['Lobsters']),
  C('hard', 'pypi-requests', 'https://pypi.org/project/requests/', ['requests']),
  C('hard', 'crates-serde', 'https://crates.io/crates/serde', ['serde']),
  C('hard', 'linkedin', 'https://www.linkedin.com/company/microsoft', ['Microsoft']),
  C('edge', 'redirect-chain', 'http://github.com/microsoft/TypeScript', ['TypeScript']),
];

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
if (!argv.includes('--yes')) {
  process.stdout.write(`${String(CASES.length)} addresses. Nothing was run. Add --yes.\n`);
  process.exit(0);
}
const out = option('--out');
if (out === undefined) throw new Error('--out <file> is required');
const budget = Number(option('--budget') ?? '0');
if (!(budget > 0)) throw new Error('--budget <DeepSeek requests> is required');
const flagValues = new Set(['--out', '--budget']);
const wanted = argv.filter(
  (arg, index) => !arg.startsWith('--') && !flagValues.has(argv[index - 1] ?? ''),
);
dotenv.config({ path: process.env['MAO_ENV_FILE'] ?? '.env', quiet: true });
const key = (process.env['DEEPSEEK_API_KEY'] ?? '').trim();
if (key === '') {
  process.stderr.write('DEEPSEEK_API_KEY is not set\n');
  process.exit(2);
}

let deepseekRequests = 0;
const countingFetch: typeof globalThis.fetch = (input, init) => {
  deepseekRequests += 1;
  if (deepseekRequests > budget) throw new Error('the DeepSeek request budget is spent');
  return globalThis.fetch(input, init);
};

const environment = (withKey: boolean): ExecutorEnvironment => ({
  scope: { kind: 'NONE' },
  limits: {
    deadline: '2099-01-01T00:00:00.000Z',
    maxOutputBytes: 8_388_608,
    preview: { maxBytes: 262_144, maxLines: 2_000 },
    maxFullOutputBytes: 8_388_608,
  },
  signal: AbortSignal.timeout(90_000),
  subprocess: {
    run: () => Promise.resolve({ exitCode: null, signal: null, stdout: '', truncated: false }),
  },
  sandbox: DENY_SANDBOX,
  credentials: { apiKeyFor: (name) => (withKey && name === 'deepseek' ? key : undefined) },
  now: () => new Date(),
});

interface Reading {
  readonly outcome: string;
  readonly reasonCode?: string;
  readonly via?: string;
  readonly bytes: number;
  readonly links: number;
  readonly fences: number;
  readonly head: string;
  readonly marker: boolean;
  readonly redirectNote: boolean;
  readonly good: boolean;
  readonly ms: number;
}

function judge(
  c: Case,
  outcome: string,
  reasonCode: string | undefined,
  text: string,
  via?: string,
  ms = 0,
): Reading {
  // What the tool adds in front of a page is not the page.
  const frame = '\n---\n';
  const body = text.includes(frame) ? text.slice(text.indexOf(frame) + frame.length) : text;
  const lower = body.toLowerCase();
  const marker = c.markers.some((word) => lower.includes(word.toLowerCase()));
  const redirectNote = text.includes('Redirected to another host');
  const completed = outcome === 'COMPLETED' || outcome === 'COMPLETED_REDIRECT';
  const good =
    c.expect === 'missing'
      ? !completed
      : c.expect === 'not-text'
        ? !completed
        : c.expect === 'moved'
          ? completed && redirectNote && marker
          : completed && !redirectNote && marker && body.trim().length >= (c.minChars ?? 400);
  return {
    outcome,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(via === undefined ? {} : { via }),
    bytes: Buffer.byteLength(body, 'utf8'),
    head: body.trim().slice(0, 160).replace(/\s+/gu, ' '),
    links: (text.match(/\]\(https?:\/\//gu) ?? []).length,
    fences: Math.floor((text.match(/^```/gmu) ?? []).length / 2),
    marker,
    redirectNote,
    good,
    ms,
  };
}

function readOutcome(c: Case, outcome: ExecutorOutcome, ms: number): Reading {
  if (outcome.outcome === 'COMPLETED') {
    const { result } = outcome;
    const text =
      ('fullOutput' in result ? result.fullOutput?.text : undefined) ?? result.artifact.text;
    const via = (outcome.result.output as { via?: string }).via;
    return judge(c, 'COMPLETED', undefined, text, via, ms);
  }
  return judge(
    c,
    outcome.outcome,
    'reasonCode' in outcome ? String(outcome.reasonCode) : undefined,
    '',
    undefined,
    ms,
  );
}

const localOnly: WebConfig = { ...DEFAULT_WEB_CONFIG, fetch: { remote: null } };

async function viaExecutor(c: Case, config: WebConfig, withKey: boolean): Promise<Reading> {
  const started = Date.now();
  const executor = createWebFetchExecutor({ config, fetch: countingFetch });
  const outcome = await executor.execute({ url: c.url }, environment(withKey));
  return readOutcome(c, outcome, Date.now() - started);
}

async function viaDeepSeekOnly(c: Case): Promise<Reading> {
  const started = Date.now();
  const provider = createDeepSeekFetch({
    baseUrl: 'https://api.deepseek.com',
    apiKey: key,
    fetch: countingFetch,
  });
  try {
    const page = await provider.fetch({ url: c.url }, AbortSignal.timeout(90_000));
    const text = `${page.title}\n${page.markdown}`;
    return judge(c, 'COMPLETED', undefined, text, 'deepseek', Date.now() - started);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    return judge(c, 'FAILED', reason, '', undefined, Date.now() - started);
  }
}

await mkdir(dirname(out), { recursive: true });
const done = new Set(
  (await readFile(out, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { id: string }).id),
);
for (const c of CASES.filter((each) => wanted.length === 0 || wanted.includes(each.id))) {
  if (done.has(c.id)) continue;
  if (deepseekRequests >= budget) {
    process.stdout.write('budget spent, stopping\n');
    break;
  }
  const local = await viaExecutor(c, localOnly, false).catch((error: unknown) =>
    judge(c, 'ERROR', error instanceof Error ? error.message : 'unknown'),
  );
  const deepseek = await viaDeepSeekOnly(c);
  const combined = await viaExecutor(c, DEFAULT_WEB_CONFIG, true).catch((error: unknown) =>
    judge(c, 'ERROR', error instanceof Error ? error.message : 'unknown'),
  );
  await appendFile(
    out,
    `${JSON.stringify({ id: c.id, category: c.category, url: c.url, expect: c.expect, local, deepseek, combined })}\n`,
  );
  process.stdout.write(
    `${c.id.padEnd(16)} local ${local.good ? 'good' : 'bad '} deepseek ${deepseek.good ? 'good' : 'bad '} combined ${combined.good ? 'good' : 'bad '} (${combined.via ?? combined.reasonCode ?? combined.outcome})\n`,
  );
}
process.stdout.write(`DeepSeek requests used: ${String(deepseekRequests)}\n`);
process.exit(0);
