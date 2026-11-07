/**
 * The cases of the SubAgent suite. A task that comes in two sizes (C1 and L1, C3 and L3, C5 and
 * L5) is one builder called twice, so the only difference between them is the size. Every check
 * runs outside the model, on the files it left, against answers fixed here.
 */
import {
  PACKAGE,
  allFiles,
  importDefault,
  importNamed,
  listFiles,
  put,
  read,
  rowsOf,
  testsPass,
  type CaseDef,
  type Files,
} from './harness.js';

// --- discover, then build: migrate the endpoints a legacy server really registers -----------------
// Which routes are live is only known from server.js: `deprecated.js` is not imported, and one
// route is commented out. The number of adapters to write is not known before reading.
type Row = readonly [method: string, path: string, handler: string];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'GET'] as const;

const slugOf = (method: string, path: string): string =>
  `${method.toLowerCase()}-${path.replaceAll(':', '').split('/').filter(Boolean).join('-')}`;

const routeFile = (rows: readonly Row[], extra = ''): string =>
  `import { route } from '../router.js';\n${rows.map(([m, p, h]) => `route('${m}', '${p}', '${h}');`).join('\n')}\n${extra}`;

function endpointsCase(id: string, groups: number, perGroup: number): CaseDef {
  const rows = Array.from({ length: groups }, (_, g) =>
    Array.from({ length: perGroup }, (_, i): Row => {
      const base = `/group${String(g)}`;
      const path =
        i === 0 ? `${base}/items` : i <= 2 ? `${base}/items/:id` : `${base}/stats${String(i)}`;
      return [METHODS[i % METHODS.length] ?? 'GET', path, `handler${String(g)}x${String(i)}`];
    }),
  ).flat();
  const expected = rows
    .map(([method, path, handler]) => ({
      method,
      path,
      handler,
      file: `${slugOf(method, path)}.js`,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const files: Record<string, string> = {
    ...PACKAGE,
    'legacy/router.js':
      'export const routes = [];\nexport function route(method, path, handler) {\n  routes.push({ method, path, handler });\n}\n',
    'legacy/routes/deprecated.js': routeFile([
      ['GET', '/v0/users', 'listUsersV0'],
      ['GET', '/v0/orders', 'listOrdersV0'],
    ]),
    'legacy/server.js': `${Array.from({ length: groups }, (_, g) => `import './routes/group${String(g)}.js';`).join('\n')}\n// routes/deprecated.js is no longer loaded\n`,
    'README.md': [
      '# gateway',
      '',
      '## Migration',
      '',
      'Move every endpoint that the legacy server actually registers (see legacy/server.js for what it loads) into an adapter.',
      '',
      '- One file per endpoint in `src/adapters/`, named `<method>-<path>.js` in lower case: the path without `:` and with `/` turned into `-`, so `GET /group0/items/:id` is `get-group0-items-id.js`.',
      '- Each file has a default export `{ method, path, handler }` with the values of the route as registered.',
      '- `src/adapters/index.js` has a default export: the array of all the adapters, in the alphabetical order of their file names.',
      '- `docs/ENDPOINTS.md` has one table row `| METHOD | path | handler |` per endpoint, in the same order.',
      '',
    ].join('\n'),
    'test/adapters.test.js':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport adapters from '../src/adapters/index.js';\n\ntest('the adapters are listed', () => {\n  assert.ok(Array.isArray(adapters) && adapters.length > 0);\n});\n",
  };
  for (let g = 0; g < groups; g += 1)
    files[`legacy/routes/group${String(g)}.js`] = routeFile(
      rows.slice(g * perGroup, (g + 1) * perGroup),
      g === 0 ? "// route('GET', '/old-stats', 'oldStats');\n" : '',
    );
  return {
    id,
    invites: 'spawn',
    prompt:
      'Migrate the legacy HTTP endpoints as described in the "Migration" section of README.md, then make sure `node --test` passes.',
    files,
    check: async (repository) => {
      const present = (await listFiles(repository, 'src/adapters')).filter((n) => n !== 'index.js');
      const modules = await Promise.all(
        expected.map((each) => importDefault(repository, `src/adapters/${each.file}`)),
      );
      const index = await importDefault(repository, 'src/adapters/index.js');
      const table = rowsOf((await read(repository, 'docs/ENDPOINTS.md')) ?? '').filter((row) =>
        /^(GET|POST|PUT|DELETE)$/u.test(row[0] ?? ''),
      );
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
          table.length === expected.length &&
          table.every(
            (row, i) =>
              row.join(' ') ===
              `${expected[i]?.method} ${expected[i]?.path} ${expected[i]?.handler}`,
          ),
        'the tests pass': await testsPass(repository),
      };
    },
    reference: async (repository) => {
      for (const each of expected)
        await put(
          repository,
          `src/adapters/${each.file}`,
          `export default ${JSON.stringify({ method: each.method, path: each.path, handler: each.handler })};\n`,
        );
      await put(
        repository,
        'src/adapters/index.js',
        `${expected.map((e, i) => `import a${String(i)} from './${e.file}';`).join('\n')}\nexport default [${expected.map((_, i) => `a${String(i)}`).join(', ')}];\n`,
      );
      await put(
        repository,
        'docs/ENDPOINTS.md',
        `| METHOD | path | handler |\n|---|---|---|\n${expected.map((e) => `| ${e.method} | ${e.path} | ${e.handler} |`).join('\n')}\n`,
      );
    },
  };
}

// --- a wide survey: facts only the files hold ---------------------------------------------------
function surveyCase(id: string, count: number): CaseDef {
  const vendors = Array.from({ length: count }, (_, i) => ({
    name: `lib${String(i).padStart(2, '0')}`,
    license: ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause'][i % 4] ?? 'MIT',
    limit: 100 + ((i * 7919) % 9000),
    exports: 2 + (i % 5),
  }));
  const files: Record<string, string> = { ...PACKAGE };
  for (const v of vendors) {
    files[`vendor/${v.name}/package.json`] =
      `${JSON.stringify({ name: v.name, license: v.license, version: '1.0.0' }, null, 2)}\n`;
    files[`vendor/${v.name}/index.js`] =
      `export const LIMIT = ${String(v.limit)};\n${Array.from({ length: v.exports - 1 }, (_, i) => `export function fn${String(i + 1)}() {\n  return ${String(i)};\n}\n`).join('\n')}`;
  }
  return {
    id,
    invites: 'spawn',
    prompt:
      'Write docs/vendor-report.md: a markdown table with one row for each library in vendor/ and the columns name, license, limit and exports. `limit` is the value of the LIMIT constant of the library, `exports` the number of things its index.js exports in all (LIMIT included).',
    files,
    check: async (repository) => {
      const rows = rowsOf((await read(repository, 'docs/vendor-report.md')) ?? '');
      return Object.fromEntries(
        vendors.map((v) => {
          const row = rows.find((each) => each[0]?.toLowerCase() === v.name);
          return [
            `${v.name} is right`,
            row !== undefined &&
              row[1] === v.license &&
              row[2]?.replaceAll(',', '') === String(v.limit) &&
              row[3] === String(v.exports),
          ];
        }),
      );
    },
    reference: (repository) =>
      put(
        repository,
        'docs/vendor-report.md',
        `| name | license | limit | exports |\n|---|---|---|---|\n${vendors.map((v) => `| ${v.name} | ${v.license} | ${String(v.limit)} | ${String(v.exports)} |`).join('\n')}\n`,
      ),
  };
}

// --- a rename across the whole repository -------------------------------------------------------
function renameCase(id: string, count: number): CaseDef {
  const areas = Array.from({ length: count }, (_, i) => `area${String(i).padStart(2, '0')}`);
  const files: Record<string, string> = { ...PACKAGE };
  for (const area of areas) {
    files[`src/${area}/price.js`] =
      `export function formatPrice(cents) {\n  return (cents / 100).toFixed(2);\n}\n`;
    files[`src/${area}/use.js`] =
      `import { formatPrice } from './price.js';\n\nexport function label(cents) {\n  return \`${area}: \${formatPrice(cents)}\`;\n}\n`;
    files[`test/${area}.test.js`] =
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/${area}/use.js';\n\ntest('${area}', () => {\n  assert.equal(label(1250), '${area}: 12.50');\n});\n`;
    files[`docs/${area}.md`] = `# ${area}\n\nUse \`formatPrice(cents)\` to show a price.\n`;
  }
  return {
    id,
    invites: 'spawn',
    prompt:
      'Rename the function formatPrice to formatCents everywhere in this repository, in code, tests and docs, and keep `node --test` passing.',
    files,
    check: async (repository) => {
      const texts = await Promise.all((await allFiles(repository)).map((p) => read(repository, p)));
      const defined = await Promise.all(areas.map((a) => read(repository, `src/${a}/price.js`)));
      return {
        'no formatPrice is left': !texts.join('\n').includes('formatPrice'),
        'formatCents is defined in every area': defined.every(
          (t) => t?.includes('export function formatCents') === true,
        ),
        'the tests pass': await testsPass(repository),
      };
    },
    reference: async (repository) => {
      for (const area of areas)
        for (const path of [`src/${area}/price.js`, `src/${area}/use.js`, `docs/${area}.md`])
          await put(
            repository,
            path,
            ((await read(repository, path)) ?? '').replaceAll('formatPrice', 'formatCents'),
          );
    },
  };
}

// --- a schema, four serializers that follow it, then an integration -----------------------------
const FIELDS = ['id', 'customer', 'amountCents', 'currency'];
const NEW_ORDER = [...FIELDS, 'discountPercent', 'taxId'];
const SAMPLE: Record<string, unknown> = {
  id: 'inv-1',
  customer: 'Ann',
  amountCents: 1250,
  currency: 'EUR',
  discountPercent: 10,
  taxId: 'DE123',
};
const FORMATS = ['json', 'csv', 'xml', 'yaml'] as const;

const serializer = (kind: (typeof FORMATS)[number], fields: readonly string[]): string => {
  const body = {
    json: 'return JSON.stringify(Object.fromEntries(FIELDS.filter((f) => f in invoice).map((f) => [f, invoice[f]])));',
    csv: "return `${FIELDS.join(',')}\\n${FIELDS.map((f) => String(invoice[f] ?? '')).join(',')}`;",
    xml: "return `<invoice>${FIELDS.filter((f) => f in invoice).map((f) => `<${f}>${invoice[f]}</${f}>`).join('')}</invoice>`;",
    yaml: "return FIELDS.filter((f) => f in invoice).map((f) => `${f}: ${invoice[f]}`).join('\\n');",
  }[kind];
  return `// Fields in the order of schema/invoice.schema.json.\nconst FIELDS = ${JSON.stringify(fields)};\n\nexport function serialize(invoice) {\n  ${body}\n}\n`;
};

const serialized = (kind: (typeof FORMATS)[number]): string => {
  const value = (k: string) => String(SAMPLE[k]);
  switch (kind) {
    case 'json':
      return JSON.stringify(Object.fromEntries(NEW_ORDER.map((k) => [k, SAMPLE[k]])));
    case 'csv':
      return `${NEW_ORDER.join(',')}\n${NEW_ORDER.map(value).join(',')}`;
    case 'xml':
      return `<invoice>${NEW_ORDER.map((k) => `<${k}>${value(k)}</${k}>`).join('')}</invoice>`;
    default:
      return NEW_ORDER.map((k) => `${k}: ${value(k)}`).join('\n');
  }
};

const invoiceCase: CaseDef = {
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
        properties: Object.fromEntries(
          FIELDS.map((f) => [f, { type: f === 'amountCents' ? 'integer' : 'string' }]),
        ),
      },
      null,
      2,
    )}\n`,
    ...Object.fromEntries(FORMATS.map((k) => [`src/serializers/${k}.js`, serializer(k, FIELDS)])),
    'test/serialize.test.js':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { serialize } from '../src/serializers/json.js';\n\ntest('json keeps the fields', () => {\n  assert.equal(serialize({ id: 'a' }), '{\"id\":\"a\"}');\n});\n",
  },
  check: async (repository) => {
    const schema = JSON.parse((await read(repository, 'schema/invoice.schema.json')) ?? '{}') as {
      order?: string[];
      properties?: Record<string, unknown>;
    };
    const written = await Promise.all(
      FORMATS.map(async (kind) => {
        const serialize = (await importNamed(
          repository,
          `src/serializers/${kind}.js`,
          'serialize',
        )) as ((value: unknown) => string) | undefined;
        return [`${kind} writes the new fields`, serialize?.(SAMPLE) === serialized(kind)] as const;
      }),
    );
    const changelog = (await read(repository, 'CHANGELOG.md')) ?? '';
    const test = (await read(repository, 'test/serialize.test.js')) ?? '';
    return {
      'the schema has the fields in order':
        JSON.stringify(schema.order) === JSON.stringify(NEW_ORDER) &&
        'discountPercent' in (schema.properties ?? {}) &&
        'taxId' in (schema.properties ?? {}),
      ...Object.fromEntries(written),
      'the changelog names both fields':
        changelog.includes('discountPercent') && changelog.includes('taxId'),
      'the tests cover all four serializers': FORMATS.every((k) =>
        test.includes(`serializers/${k}.js`),
      ),
      'the tests pass': await testsPass(repository),
    };
  },
  reference: async (repository) => {
    await put(
      repository,
      'schema/invoice.schema.json',
      `${JSON.stringify({ type: 'object', order: NEW_ORDER, properties: Object.fromEntries(NEW_ORDER.map((k) => [k, { type: 'string' }])) }, null, 2)}\n`,
    );
    for (const kind of FORMATS)
      await put(repository, `src/serializers/${kind}.js`, serializer(kind, NEW_ORDER));
    await put(
      repository,
      'CHANGELOG.md',
      '# Changelog\n\n## Unreleased\n\n- Add discountPercent and taxId.\n',
    );
    await put(
      repository,
      'test/serialize.test.js',
      `${FORMATS.map((k) => `import '../src/serializers/${k}.js';`).join('\n')}\nimport test from 'node:test';\ntest('ok', () => {});\n`,
    );
  },
};

// --- several features that share one file ------------------------------------------------------
const featuresCase: CaseDef = {
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
    const config = (await importNamed(repository, 'src/config.js', 'features')) as
      Record<string, { enabled?: boolean }> | undefined;
    const run = async (name: string, input: unknown): Promise<unknown> => {
      const feature = (await importNamed(repository, `src/features/${name}.js`, 'run')) as
        ((value: unknown) => unknown) | undefined;
      return feature?.(input);
    };
    return {
      'alpha is kept': config?.['alpha']?.enabled === true,
      'beta is registered': config?.['beta']?.enabled === true,
      'gamma is registered': config?.['gamma']?.enabled === true,
      'delta is registered': config?.['delta']?.enabled === true,
      'beta works': (await run('beta', 21)) === 42,
      'gamma works': (await run('gamma', 'abc')) === 'cba',
      'delta works': (await run('delta', [1, 2, 3, 4])) === 10,
      'the tests pass': await testsPass(repository),
    };
  },
  reference: async (repository) => {
    await put(
      repository,
      'src/config.js',
      `export const features = {\n${['alpha', 'beta', 'gamma', 'delta'].map((n) => `  ${n}: { enabled: true },`).join('\n')}\n};\n`,
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
};

// --- controls: work that does not need SubAgents -----------------------------------------------
const smallFix: CaseDef = {
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
  reference: async (repository) => {
    await put(
      repository,
      'src/range.js',
      ((await read(repository, 'src/range.js')) ?? '').replace('i < to', 'i <= to'),
    );
  },
};

const question: CaseDef = {
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

const greeting: CaseDef = {
  id: 'K3-greeting',
  invites: 'no-spawn',
  prompt: 'Hello!',
  files: PACKAGE,
  check: (_repository, replies) => Promise.resolve({ 'it answered': replies.length > 0 }),
};

export const CASES: readonly CaseDef[] = [
  endpointsCase('C1-endpoints', 2, 5),
  invoiceCase,
  surveyCase('C3-survey', 5),
  featuresCase,
  renameCase('C5-rename', 6),
  endpointsCase('L1-endpoints', 8, 5),
  surveyCase('L3-survey', 24),
  renameCase('L5-rename', 30),
  smallFix,
  question,
  greeting,
];

export type { Files };
