/**
 * The same three tasks as C1, C3 and C5 at a size where doing them in one context is slow: many
 * more endpoints, libraries and files. Nothing else differs, so a change in how the model works
 * is the size, not the task.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testsPass, type CaseDef, type Files } from './fixtures.js';

const PACKAGE: Files = {
  'package.json': '{ "name": "fixture", "type": "module", "private": true }\n',
};
const read = (repository: string, path: string) =>
  readFile(join(repository, path), 'utf8').catch(() => undefined);
const put = async (repository: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(repository, path)), { recursive: true });
  await writeFile(join(repository, path), content);
};

// --- L1: endpoints --------------------------------------------------------------------------------
const GROUPS = 8;
const PER_GROUP = 5;
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'GET'] as const;
type Row = readonly [string, string, string];
const liveRows = (): Row[] =>
  Array.from({ length: GROUPS }, (_, g) =>
    Array.from({ length: PER_GROUP }, (_, i): Row => {
      const method = METHODS[i] ?? 'GET';
      const base = `/group${String(g)}`;
      const path =
        i === 1 || i === 2
          ? `${base}/items/:id`
          : i === 0
            ? `${base}/items`
            : `${base}/stats${String(i)}`;
      return [method, path, `handler${String(g)}x${String(i)}`];
    }),
  ).flat();
const slug = (method: string, path: string) =>
  `${method.toLowerCase()}-${path.replaceAll(':', '').split('/').filter(Boolean).join('-')}`;

const routeFile = (rows: readonly Row[]): string =>
  `import { route } from '../router.js';\n${rows.map(([m, p, h]) => `route('${m}', '${p}', '${h}');`).join('\n')}\n`;

export const bigEndpoints: CaseDef = {
  id: 'L1-endpoints',
  invites: 'spawn',
  prompt:
    'Migrate the legacy HTTP endpoints as described in the "Migration" section of README.md, then make sure `node --test` passes.',
  files: (() => {
    const rows = liveRows();
    const files: Record<string, string> = {
      ...PACKAGE,
      'legacy/router.js':
        'export const routes = [];\nexport function route(method, path, handler) {\n  routes.push({ method, path, handler });\n}\n',
      'legacy/routes/deprecated.js': routeFile([
        ['GET', '/v0/users', 'listUsersV0'],
        ['GET', '/v0/orders', 'listOrdersV0'],
      ]),
      'legacy/server.js': `${Array.from({ length: GROUPS }, (_, g) => `import './routes/group${String(g)}.js';`).join('\n')}\n// routes/deprecated.js is no longer loaded\n`,
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
    for (let g = 0; g < GROUPS; g += 1)
      files[`legacy/routes/group${String(g)}.js`] = routeFile(
        rows.slice(g * PER_GROUP, (g + 1) * PER_GROUP),
      );
    return files;
  })(),
  check: async (repository) => {
    const expected = liveRows()
      .map(([method, path, handler]) => ({
        method,
        path,
        handler,
        file: `${slug(method, path)}.js`,
      }))
      .sort((a, b) => a.file.localeCompare(b.file));
    const present = (await readdir(join(repository, 'src/adapters')).catch(() => [])).filter(
      (n) => n !== 'index.js',
    );
    const load = async (path: string): Promise<unknown> => {
      try {
        const url = `${pathToFileURL(join(repository, path)).href}?t=${String(Date.now())}`;
        return ((await import(url)) as { default?: unknown }).default;
      } catch {
        return undefined;
      }
    };
    const modules = await Promise.all(expected.map((e) => load(`src/adapters/${e.file}`)));
    const index = await load('src/adapters/index.js');
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
        rows.every(
          (row, i) =>
            row
              .split('|')
              .map((c) => c.trim())
              .filter(Boolean)
              .join(' ') === `${expected[i]?.method} ${expected[i]?.path} ${expected[i]?.handler}`,
        ),
      'the tests pass': await testsPass(repository),
    };
  },
};

// --- L3: a survey of many libraries ----------------------------------------------------------------
const VENDOR_COUNT = 24;
const VENDORS = Array.from({ length: VENDOR_COUNT }, (_, i) => ({
  name: `lib${String(i).padStart(2, '0')}`,
  license: ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause'][i % 4] ?? 'MIT',
  limit: 100 + ((i * 7919) % 9000),
  exports: 2 + (i % 5),
}));

export const bigSurvey: CaseDef = {
  id: 'L3-survey',
  invites: 'spawn',
  prompt:
    'Write docs/vendor-report.md: a markdown table with one row for each library in vendor/ and the columns name, license, limit and exports. `limit` is the value of the LIMIT constant of the library, `exports` the number of things its index.js exports in all (LIMIT included).',
  files: (() => {
    const files: Record<string, string> = { ...PACKAGE };
    for (const v of VENDORS) {
      files[`vendor/${v.name}/package.json`] =
        `${JSON.stringify({ name: v.name, license: v.license, version: '1.0.0' }, null, 2)}\n`;
      files[`vendor/${v.name}/index.js`] =
        `export const LIMIT = ${String(v.limit)};\n${Array.from({ length: v.exports - 1 }, (_, i) => `export function fn${String(i + 1)}() {\n  return ${String(i)};\n}\n`).join('\n')}`;
    }
    return files;
  })(),
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
    const checks: Record<string, boolean> = {};
    for (const v of VENDORS) {
      const row = rows.find((each) => each[0]?.toLowerCase() === v.name);
      checks[`${v.name} is right`] =
        row !== undefined &&
        row[1] === v.license &&
        row[2]?.replaceAll(',', '') === String(v.limit) &&
        row[3] === String(v.exports);
    }
    return checks;
  },
};

// --- L5: a rename across many areas ----------------------------------------------------------------
const AREAS = Array.from({ length: 30 }, (_, i) => `area${String(i).padStart(2, '0')}`);

export const bigRename: CaseDef = {
  id: 'L5-rename',
  invites: 'spawn',
  prompt:
    'Rename the function formatPrice to formatCents everywhere in this repository, in code, tests and docs, and keep `node --test` passing.',
  files: (() => {
    const files: Record<string, string> = { ...PACKAGE };
    for (const area of AREAS) {
      files[`src/${area}/price.js`] =
        `export function formatPrice(cents) {\n  return (cents / 100).toFixed(2);\n}\n`;
      files[`src/${area}/use.js`] =
        `import { formatPrice } from './price.js';\n\nexport function label(cents) {\n  return \`${area}: \${formatPrice(cents)}\`;\n}\n`;
      files[`test/${area}.test.js`] =
        `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/${area}/use.js';\n\ntest('${area}', () => {\n  assert.equal(label(1250), '${area}: 12.50');\n});\n`;
      files[`docs/${area}.md`] = `# ${area}\n\nUse \`formatPrice(cents)\` to show a price.\n`;
    }
    return files;
  })(),
  check: async (repository) => {
    const all: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const name of await readdir(join(repository, directory)).catch(() => [])) {
        const path = directory === '' ? name : `${directory}/${name}`;
        if (name === 'node_modules' || name === '.git') continue;
        const info = await stat(join(repository, path)).catch(() => undefined);
        if (info?.isDirectory() === true) await walk(path);
        else all.push(path);
      }
    };
    await walk('');
    const joined = (await Promise.all(all.map((p) => read(repository, p)))).join('\n');
    return {
      'no formatPrice is left': !joined.includes('formatPrice'),
      'formatCents is defined in every area': (
        await Promise.all(AREAS.map((a) => read(repository, `src/${a}/price.js`)))
      ).every((t) => t?.includes('export function formatCents') === true),
      'the tests pass': await testsPass(repository),
    };
  },
};

export const LARGE: readonly CaseDef[] = [bigEndpoints, bigSurvey, bigRename];

export const LARGE_REFERENCES: Readonly<Record<string, (repository: string) => Promise<void>>> = {
  'L1-endpoints': async (repository) => {
    const sorted = liveRows()
      .map(([method, path, handler]) => ({
        method,
        path,
        handler,
        file: `${slug(method, path)}.js`,
      }))
      .sort((a, b) => a.file.localeCompare(b.file));
    for (const each of sorted)
      await put(
        repository,
        `src/adapters/${each.file}`,
        `export default ${JSON.stringify({ method: each.method, path: each.path, handler: each.handler })};\n`,
      );
    await put(
      repository,
      'src/adapters/index.js',
      `${sorted.map((e, i) => `import a${String(i)} from './${e.file}';`).join('\n')}\nexport default [${sorted.map((_, i) => `a${String(i)}`).join(', ')}];\n`,
    );
    await put(
      repository,
      'docs/ENDPOINTS.md',
      `| METHOD | path | handler |\n|---|---|---|\n${sorted.map((e) => `| ${e.method} | ${e.path} | ${e.handler} |`).join('\n')}\n`,
    );
  },
  'L3-survey': async (repository) => {
    await put(
      repository,
      'docs/vendor-report.md',
      `| name | license | limit | exports |\n|---|---|---|---|\n${VENDORS.map((v) => `| ${v.name} | ${v.license} | ${String(v.limit)} | ${String(v.exports)} |`).join('\n')}\n`,
    );
  },
  'L5-rename': async (repository) => {
    for (const area of AREAS)
      for (const path of [`src/${area}/price.js`, `src/${area}/use.js`, `docs/${area}.md`])
        await put(
          repository,
          path,
          ((await read(repository, path)) ?? '').replaceAll('formatPrice', 'formatCents'),
        );
  },
};
