/**
 * The repositories and the checks of the stage 4 suite (docs/M2/Evaluation/Stage4SubAgents.md).
 * Every check runs outside the model, on the files it left, against answers fixed here.
 */
// The child-process rule guards the product's own code; this file only judges what a run left.
// eslint-disable-next-line no-restricted-imports
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Files = Readonly<Record<string, string>>;
export type Checks = Readonly<Record<string, boolean>>;

export interface CaseDef {
  readonly id: string;
  /** Whether spreading the work over SubAgents is what the task invites. */
  readonly invites: 'spawn' | 'no-spawn';
  readonly prompt: string;
  readonly files: Files;
  /** What must hold for the work to count as done; every entry true. */
  readonly check: (repository: string, replies: readonly string[]) => Promise<Checks>;
}

const PACKAGE: Files = {
  'package.json': '{ "name": "fixture", "type": "module", "private": true }\n',
};

const read = (repository: string, path: string) =>
  readFile(join(repository, path), 'utf8').catch(() => undefined);

/** `node --test` in the repository, as the user would run it. */
/** The user's own `node --test`; this harness is not the product, so it may start a process. */
export function testsPass(repository: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--test'], { cwd: repository, timeout: 60_000 }, (error) => {
      resolve(error === null);
    });
  });
}

async function importDefault(repository: string, path: string): Promise<unknown> {
  try {
    const url = `${pathToFileURL(join(repository, path)).href}?t=${String(Date.now())}`;
    return ((await import(url)) as { default?: unknown }).default;
  } catch {
    return undefined;
  }
}

async function listFiles(repository: string, directory: string): Promise<string[]> {
  return readdir(join(repository, directory)).catch(() => []);
}

// --- C1: discover, then build ------------------------------------------------------------------
// Which routes the legacy server really registers is only known from server.js; `deprecated.js` is
// not imported. Ten live endpoints, two dead ones.
const LIVE: readonly (readonly [string, string, string])[] = [
  ['GET', '/users', 'listUsers'],
  ['GET', '/users/:id', 'getUser'],
  ['POST', '/users', 'createUser'],
  ['GET', '/orders', 'listOrders'],
  ['GET', '/orders/:id', 'getOrder'],
  ['DELETE', '/orders/:id', 'cancelOrder'],
  ['GET', '/products', 'listProducts'],
  ['PUT', '/products/:id', 'updateProduct'],
  ['GET', '/health', 'health'],
  ['POST', '/admin/reindex', 'reindex'],
];
const slugOf = (method: string, path: string): string =>
  `${method.toLowerCase()}-${path.replaceAll(':', '').split('/').filter(Boolean).join('-')}`;

const routeFile = (rows: readonly (readonly [string, string, string])[], extra = ''): string =>
  `import { route } from '../router.js';\n${rows.map(([m, p, h]) => `route('${m}', '${p}', '${h}');`).join('\n')}\n${extra}`;

const legacy: Files = {
  'legacy/router.js':
    'export const routes = [];\nexport function route(method, path, handler) {\n  routes.push({ method, path, handler });\n}\n',
  'legacy/routes/users.js': routeFile(LIVE.slice(0, 3)),
  'legacy/routes/orders.js': routeFile(LIVE.slice(3, 6)),
  'legacy/routes/products.js': routeFile(LIVE.slice(6, 8)),
  'legacy/routes/health.js': routeFile(LIVE.slice(8, 9)),
  'legacy/routes/admin.js': routeFile(
    LIVE.slice(9),
    "// route('GET', '/admin/old-stats', 'oldStats');\n",
  ),
  'legacy/routes/deprecated.js': routeFile([
    ['GET', '/v0/users', 'listUsersV0'],
    ['GET', '/v0/orders', 'listOrdersV0'],
  ]),
  'legacy/server.js':
    "import './routes/users.js';\nimport './routes/orders.js';\nimport './routes/products.js';\nimport './routes/health.js';\nimport './routes/admin.js';\n// routes/deprecated.js is no longer loaded\n",
};

export const endpoints: CaseDef = {
  id: 'C1-endpoints',
  invites: 'spawn',
  prompt:
    'Migrate the legacy HTTP endpoints as described in the "Migration" section of README.md, then make sure `node --test` passes.',
  files: {
    ...PACKAGE,
    ...legacy,
    'README.md': [
      '# gateway',
      '',
      '## Migration',
      '',
      'Move every endpoint that the legacy server actually registers (see legacy/server.js for what it loads) into an adapter.',
      '',
      '- One file per endpoint in `src/adapters/`, named `<method>-<path>.js` in lower case: the path without `:` and with `/` turned into `-`, so `GET /users/:id` is `get-users-id.js` and `GET /health` is `get-health.js`.',
      '- Each file has a default export `{ method, path, handler }` with the values of the route as registered.',
      '- `src/adapters/index.js` has a default export: the array of all the adapters, in the alphabetical order of their file names.',
      '- `docs/ENDPOINTS.md` has one table row `| METHOD | path | handler |` per endpoint, in the same order.',
      '',
    ].join('\n'),
    'test/adapters.test.js':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport adapters from '../src/adapters/index.js';\n\ntest('the adapters are listed', () => {\n  assert.ok(Array.isArray(adapters) && adapters.length > 0);\n});\n",
  },
  check: async (repository) => {
    const expected = LIVE.map(([method, path, handler]) => ({
      method,
      path,
      handler,
      file: `${slugOf(method, path)}.js`,
    })).sort((a, b) => a.file.localeCompare(b.file));
    const present = (await listFiles(repository, 'src/adapters')).filter((n) => n !== 'index.js');
    const modules = await Promise.all(
      expected.map((each) => importDefault(repository, `src/adapters/${each.file}`)),
    );
    const index = await importDefault(repository, 'src/adapters/index.js');
    const docs = (await read(repository, 'docs/ENDPOINTS.md')) ?? '';
    const rows = docs.split('\n').filter((line) => /^\|\s*(GET|POST|PUT|DELETE)\s*\|/u.test(line));
    return {
      'exactly the live adapters exist':
        present.sort().join() === expected.map((e) => e.file).join(),
      'each adapter has its route': modules.every(
        (m, i) =>
          JSON.stringify(m) ===
          JSON.stringify({
            method: expected[i]?.method,
            path: expected[i]?.path,
            handler: expected[i]?.handler,
          }),
      ),
      'the index lists them in order': JSON.stringify(index) === JSON.stringify(modules),
      'the docs have one row each, in order':
        rows.length === expected.length &&
        rows.every((row, i) => {
          const cells = row
            .split('|')
            .map((c) => c.trim())
            .filter(Boolean);
          return (
            cells.join(' ') ===
            `${expected[i]?.method} ${expected[i]?.path} ${expected[i]?.handler}`
          );
        }),
      'the tests pass': await testsPass(repository),
    };
  },
};

// --- C2: a schema, four serializers that follow it, then an integration --------------------------
const FIELDS = ['id', 'customer', 'amountCents', 'currency'];
const SAMPLE = {
  id: 'inv-1',
  customer: 'Ann',
  amountCents: 1250,
  currency: 'EUR',
  discountPercent: 10,
  taxId: 'DE123',
};
const NEW_ORDER = [...FIELDS, 'discountPercent', 'taxId'];

const serializer = (kind: 'json' | 'csv' | 'xml' | 'yaml'): string => {
  const list = JSON.stringify(FIELDS);
  const body = {
    json: 'return JSON.stringify(Object.fromEntries(FIELDS.filter((f) => f in invoice).map((f) => [f, invoice[f]])));',
    csv: "return `${FIELDS.join(',')}\\n${FIELDS.map((f) => String(invoice[f] ?? '')).join(',')}`;",
    xml: "return `<invoice>${FIELDS.filter((f) => f in invoice).map((f) => `<${f}>${invoice[f]}</${f}>`).join('')}</invoice>`;",
    yaml: "return FIELDS.filter((f) => f in invoice).map((f) => `${f}: ${invoice[f]}`).join('\\n');",
  }[kind];
  return `// Fields in the order of schema/invoice.schema.json.\nconst FIELDS = ${list};\n\nexport function serialize(invoice) {\n  ${body}\n}\n`;
};

const expectedSerialized = (kind: string): string => {
  const f = NEW_ORDER;
  const value = (k: string) => String((SAMPLE as Record<string, unknown>)[k]);
  switch (kind) {
    case 'json':
      return JSON.stringify(
        Object.fromEntries(f.map((k) => [k, (SAMPLE as Record<string, unknown>)[k]])),
      );
    case 'csv':
      return `${f.join(',')}\n${f.map(value).join(',')}`;
    case 'xml':
      return `<invoice>${f.map((k) => `<${k}>${value(k)}</${k}>`).join('')}</invoice>`;
    default:
      return f.map((k) => `${k}: ${value(k)}`).join('\n');
  }
};

export const invoice: CaseDef = {
  id: 'C2-invoice',
  invites: 'spawn',
  prompt:
    'Follow SPEC.md: add the two new invoice fields everywhere the invoice format is defined or written out, and keep `node --test` passing.',
  files: {
    ...PACKAGE,
    'SPEC.md': [
      '# Invoice fields',
      '',
      'Invoices get two optional fields: `discountPercent` (a number from 0 to 100) and `taxId` (a string).',
      '',
      '- `schema/invoice.schema.json` is the single source of truth: add both properties after `currency`, and keep its `order` array in the order the serializers must write.',
      '- Each serializer in `src/serializers/` writes the fields in the order of the schema, in its own format, as it does now.',
      '- `test/serialize.test.js` must check all four serializers on an invoice that has the new fields.',
      '- Add a line to `CHANGELOG.md` under "Unreleased" that names both fields.',
      '',
    ].join('\n'),
    'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n- Initial invoice format.\n',
    'schema/invoice.schema.json': `${JSON.stringify(
      {
        type: 'object',
        order: FIELDS,
        properties: {
          id: { type: 'string' },
          customer: { type: 'string' },
          amountCents: { type: 'integer' },
          currency: { type: 'string' },
        },
      },
      null,
      2,
    )}\n`,
    'src/serializers/json.js': serializer('json'),
    'src/serializers/csv.js': serializer('csv'),
    'src/serializers/xml.js': serializer('xml'),
    'src/serializers/yaml.js': serializer('yaml'),
    'test/serialize.test.js':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { serialize } from '../src/serializers/json.js';\n\ntest('json keeps the fields', () => {\n  assert.equal(serialize({ id: 'a' }), '{\"id\":\"a\"}');\n});\n",
  },
  check: async (repository) => {
    const checks: Record<string, boolean> = {};
    const schema = JSON.parse((await read(repository, 'schema/invoice.schema.json')) ?? '{}') as {
      order?: string[];
      properties?: Record<string, unknown>;
    };
    checks['the schema has the fields in order'] =
      JSON.stringify(schema.order) === JSON.stringify(NEW_ORDER) &&
      'discountPercent' in (schema.properties ?? {}) &&
      'taxId' in (schema.properties ?? {});
    for (const kind of ['json', 'csv', 'xml', 'yaml']) {
      try {
        const url = `${pathToFileURL(join(repository, `src/serializers/${kind}.js`)).href}?t=${String(Date.now())}`;
        const module = (await import(url)) as { serialize: (value: unknown) => string };
        checks[`${kind} writes the new fields`] =
          module.serialize(SAMPLE) === expectedSerialized(kind);
      } catch {
        checks[`${kind} writes the new fields`] = false;
      }
    }
    const changelog = (await read(repository, 'CHANGELOG.md')) ?? '';
    checks['the changelog names both fields'] =
      changelog.includes('discountPercent') && changelog.includes('taxId');
    const test = (await read(repository, 'test/serialize.test.js')) ?? '';
    checks['the tests cover all four serializers'] = ['json', 'csv', 'xml', 'yaml'].every((k) =>
      test.includes(`serializers/${k}.js`),
    );
    checks['the tests pass'] = await testsPass(repository);
    return checks;
  },
};

// --- C3: a wide survey with facts only the files hold -------------------------------------------
const VENDORS = [
  { name: 'alder', license: 'MIT', limit: 4096, exports: 3 },
  { name: 'birch', license: 'Apache-2.0', limit: 1500, exports: 5 },
  { name: 'cedar', license: 'ISC', limit: 87, exports: 2 },
  { name: 'dogwood', license: 'BSD-3-Clause', limit: 25000, exports: 4 },
  { name: 'elm', license: 'MIT', limit: 640, exports: 6 },
];
const vendorFiles: Record<string, string> = {};
for (const v of VENDORS) {
  vendorFiles[`vendor/${v.name}/package.json`] =
    `${JSON.stringify({ name: v.name, license: v.license, version: '1.0.0' }, null, 2)}\n`;
  vendorFiles[`vendor/${v.name}/index.js`] =
    `export const LIMIT = ${String(v.limit)};\n${Array.from({ length: v.exports - 1 }, (_, i) => `export function fn${String(i + 1)}() {\n  return ${String(i)};\n}\n`).join('\n')}`;
}

export const survey: CaseDef = {
  id: 'C3-survey',
  invites: 'spawn',
  prompt:
    'Write docs/vendor-report.md: a markdown table with one row for each library in vendor/ and the columns name, license, limit and exports. `limit` is the value of the LIMIT constant of the library, `exports` the number of things its index.js exports in all (LIMIT included).',
  files: { ...PACKAGE, ...vendorFiles },
  check: async (repository) => {
    const text = (await read(repository, 'docs/vendor-report.md')) ?? '';
    const rows = text
      .split('\n')
      .filter((line) => line.trim().startsWith('|'))
      .map((line) =>
        line
          .split('|')
          .map((c) => c.trim())
          .filter((c) => c !== ''),
      );
    const rowOf = (name: string) => rows.find((row) => row[0]?.toLowerCase() === name);
    const checks: Record<string, boolean> = {};
    for (const v of VENDORS) {
      const row = rowOf(v.name);
      checks[`${v.name} is right`] =
        row !== undefined &&
        row[1] === v.license &&
        row[2]?.replaceAll(',', '') === String(v.limit) &&
        row[3] === String(v.exports);
    }
    return checks;
  },
};

// --- C4: several features that share one file ---------------------------------------------------
export const features: CaseDef = {
  id: 'C4-features',
  invites: 'spawn',
  prompt:
    'Implement the three features listed in FEATURES.md as described there, and make `node --test` pass.',
  files: {
    ...PACKAGE,
    'FEATURES.md': [
      '# Features',
      '',
      'Each feature is a file `src/features/<name>.js` with a named export `run(input)`, and an entry in the `features` object of `src/config.js` with `enabled: true`.',
      '',
      '- `beta`: `run(n)` returns the number doubled.',
      '- `gamma`: `run(text)` returns the text reversed.',
      '- `delta`: `run(list)` returns the sum of the numbers in the list.',
      '',
    ].join('\n'),
    'src/config.js': 'export const features = {\n  alpha: { enabled: true },\n};\n',
    'src/features/alpha.js':
      'export function run(input) {\n  return String(input).toUpperCase();\n}\n',
    'test/features.test.js':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { features } from '../src/config.js';\nimport { run } from '../src/features/alpha.js';\n\ntest('alpha', () => {\n  assert.equal(run('a'), 'A');\n  assert.ok(features.alpha.enabled);\n});\n",
  },
  check: async (repository) => {
    const checks: Record<string, boolean> = {};
    const config = (await importConfig(repository)) as
      Record<string, { enabled?: boolean }> | undefined;
    const run = async (name: string, input: unknown): Promise<unknown> => {
      try {
        const url = `${pathToFileURL(join(repository, `src/features/${name}.js`)).href}?t=${String(Date.now())}`;
        return ((await import(url)) as { run: (v: unknown) => unknown }).run(input);
      } catch {
        return undefined;
      }
    };
    checks['alpha is kept'] = config?.['alpha']?.enabled === true;
    for (const name of ['beta', 'gamma', 'delta'])
      checks[`${name} is registered`] = config?.[name]?.enabled === true;
    checks['beta works'] = (await run('beta', 21)) === 42;
    checks['gamma works'] = (await run('gamma', 'abc')) === 'cba';
    checks['delta works'] = (await run('delta', [1, 2, 3, 4])) === 10;
    checks['the tests pass'] = await testsPass(repository);
    return checks;
  },
};

async function importConfig(repository: string): Promise<unknown> {
  try {
    const url = `${pathToFileURL(join(repository, 'src/config.js')).href}?t=${String(Date.now())}`;
    return ((await import(url)) as { features?: unknown }).features;
  } catch {
    return undefined;
  }
}

// --- C5: a rename across the whole repository ---------------------------------------------------
const renameFiles: Record<string, string> = {};
const AREAS = ['cart', 'orders', 'catalog', 'reports', 'mail', 'export'];
for (const area of AREAS) {
  renameFiles[`src/${area}/price.js`] =
    `export function formatPrice(cents) {\n  return (cents / 100).toFixed(2);\n}\n`;
  renameFiles[`src/${area}/use.js`] =
    `import { formatPrice } from './price.js';\n\nexport function label(cents) {\n  return \`${area}: \${formatPrice(cents)}\`;\n}\n`;
  renameFiles[`test/${area}.test.js`] =
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/${area}/use.js';\n\ntest('${area}', () => {\n  assert.equal(label(1250), '${area}: 12.50');\n});\n`;
}
renameFiles['docs/USAGE.md'] =
  '# Usage\n\nCall `formatPrice(cents)` from each area; `formatPrice` returns a string with two decimals.\n';

export const rename: CaseDef = {
  id: 'C5-rename',
  invites: 'spawn',
  prompt:
    'Rename the function formatPrice to formatCents everywhere in this repository, in code, tests and docs, and keep `node --test` passing.',
  files: { ...PACKAGE, ...renameFiles },
  check: async (repository) => {
    const all: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const name of await listFiles(repository, directory)) {
        const path = directory === '' ? name : `${directory}/${name}`;
        if (name === 'node_modules' || name === '.git') continue;
        const info = await stat(join(repository, path)).catch(() => undefined);
        if (info?.isDirectory() === true) await walk(path);
        else all.push(path);
      }
    };
    await walk('');
    const texts = await Promise.all(all.map((p) => read(repository, p)));
    const joined = texts.join('\n');
    return {
      'no formatPrice is left': !joined.includes('formatPrice'),
      'formatCents is defined in every area': (
        await Promise.all(AREAS.map((a) => read(repository, `src/${a}/price.js`)))
      ).every((t) => t?.includes('export function formatCents') === true),
      'the docs use the new name': ((await read(repository, 'docs/USAGE.md')) ?? '').includes(
        'formatCents',
      ),
      'the tests pass': await testsPass(repository),
    };
  },
};

// --- controls: work that does not need SubAgents -----------------------------------------------
export const smallFix: CaseDef = {
  id: 'K1-small-fix',
  invites: 'no-spawn',
  prompt: '`node --test` fails. Fix the bug.',
  files: {
    ...PACKAGE,
    'src/range.js':
      'export function range(from, to) {\n  const out = [];\n  for (let i = from; i < to; i += 1) out.push(i);\n  return out;\n}\n',
    'test/range.test.js':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { range } from '../src/range.js';\n\ntest('range includes both ends', () => {\n  assert.deepEqual(range(1, 3), [1, 2, 3]);\n});\n",
  },
  check: async (repository) => ({ 'the tests pass': await testsPass(repository) }),
};

export const question: CaseDef = {
  id: 'K2-question',
  invites: 'no-spawn',
  prompt: 'Which file defines parseConfig, and what does it return when the input is empty?',
  files: {
    ...PACKAGE,
    'src/config/parse.js':
      'export function parseConfig(text) {\n  if (text.trim() === "") return {};\n  return Object.fromEntries(text.split("\\n").map((l) => l.split("=")));\n}\n',
    'src/other.js': 'export const x = 1;\n',
  },
  check: (_repository, replies) => {
    const text = replies.join('\n');
    return Promise.resolve({
      'names the file': text.includes('src/config/parse.js'),
      'says it returns an empty object': /\{\s*\}|empty object|空对象/iu.test(text),
    });
  },
};

export const greeting: CaseDef = {
  id: 'K3-greeting',
  invites: 'no-spawn',
  prompt: 'Hello!',
  files: PACKAGE,
  check: (_repository, replies) => Promise.resolve({ 'it answered': replies.length > 0 }),
};

export const CASES: readonly CaseDef[] = [
  endpoints,
  invoice,
  survey,
  features,
  rename,
  smallFix,
  question,
  greeting,
];

// --- reference solutions: the checks must pass on these and fail on the fixtures --------------------
const put = async (repository: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(repository, path)), { recursive: true });
  await writeFile(join(repository, path), content);
};

export const REFERENCES: Readonly<Record<string, (repository: string) => Promise<void>>> = {
  'C1-endpoints': async (repository) => {
    const sorted = LIVE.map(([method, path, handler]) => ({
      method,
      path,
      handler,
      file: `${slugOf(method, path)}.js`,
    })).sort((a, b) => a.file.localeCompare(b.file));
    for (const each of sorted)
      await put(
        repository,
        `src/adapters/${each.file}`,
        `export default ${JSON.stringify({ method: each.method, path: each.path, handler: each.handler })};\n`,
      );
    const names = sorted.map((_, i) => `a${String(i)}`);
    await put(
      repository,
      'src/adapters/index.js',
      `${sorted.map((e, i) => `import ${names[i] ?? ''} from './${e.file}';`).join('\n')}\nexport default [${names.join(', ')}];\n`,
    );
    await put(
      repository,
      'docs/ENDPOINTS.md',
      `| METHOD | path | handler |\n|---|---|---|\n${sorted.map((e) => `| ${e.method} | ${e.path} | ${e.handler} |`).join('\n')}\n`,
    );
  },
  'C2-invoice': async (repository) => {
    await put(
      repository,
      'schema/invoice.schema.json',
      `${JSON.stringify({ type: 'object', order: NEW_ORDER, properties: Object.fromEntries(NEW_ORDER.map((k) => [k, { type: 'string' }])) }, null, 2)}\n`,
    );
    for (const kind of ['json', 'csv', 'xml', 'yaml'] as const)
      await put(
        repository,
        `src/serializers/${kind}.js`,
        serializer(kind).replace(JSON.stringify(FIELDS), JSON.stringify(NEW_ORDER)),
      );
    await put(
      repository,
      'CHANGELOG.md',
      '# Changelog\n\n## Unreleased\n\n- Add discountPercent and taxId.\n',
    );
    await put(
      repository,
      'test/serialize.test.js',
      ['json', 'csv', 'xml', 'yaml'].map((k) => `import '../src/serializers/${k}.js';`).join('\n') +
        "\nimport test from 'node:test';\ntest('ok', () => {});\n",
    );
  },
  'C3-survey': async (repository) => {
    await put(
      repository,
      'docs/vendor-report.md',
      `| name | license | limit | exports |\n|---|---|---|---|\n${VENDORS.map((v) => `| ${v.name} | ${v.license} | ${String(v.limit)} | ${String(v.exports)} |`).join('\n')}\n`,
    );
  },
  'C4-features': async (repository) => {
    await put(
      repository,
      'src/config.js',
      'export const features = {\n  alpha: { enabled: true },\n  beta: { enabled: true },\n  gamma: { enabled: true },\n  delta: { enabled: true },\n};\n',
    );
    await put(repository, 'src/features/beta.js', 'export function run(n) {\n  return n * 2;\n}\n');
    await put(
      repository,
      'src/features/gamma.js',
      "export function run(t) {\n  return [...t].reverse().join('');\n}\n",
    );
    await put(
      repository,
      'src/features/delta.js',
      'export function run(l) {\n  return l.reduce((a, b) => a + b, 0);\n}\n',
    );
  },
  'C5-rename': async (repository) => {
    for (const area of AREAS) {
      for (const path of [`src/${area}/price.js`, `src/${area}/use.js`])
        await put(
          repository,
          path,
          ((await read(repository, path)) ?? '').replaceAll('formatPrice', 'formatCents'),
        );
    }
    await put(
      repository,
      'docs/USAGE.md',
      ((await read(repository, 'docs/USAGE.md')) ?? '').replaceAll('formatPrice', 'formatCents'),
    );
  },
  'K1-small-fix': async (repository) => {
    await put(
      repository,
      'src/range.js',
      ((await read(repository, 'src/range.js')) ?? '').replace('i < to', 'i <= to'),
    );
  },
};
