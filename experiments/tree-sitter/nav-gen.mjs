// Draws the navigation tasks from the ASTs of two real code bases, with a fixed seed, so that no
// task is hand-picked to favour one arm. Usage: node nav-gen.mjs <experiment dir> <out.json>
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const [dir, outPath] = process.argv.slice(2);
const require = createRequire(join(dir, 'x.js'));
const ts = require('typescript');
const ROOTS = {
  ts: '/mnt/e/OpenSourceStructure/OpenCode/upstream/packages/core/src',
  py: '/mnt/e/OpenSourceStructure/LangGraph',
};

function walk(directory, ext, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, ext, found);
    else if (
      entry.isFile() &&
      entry.name.endsWith(ext) &&
      !entry.name.endsWith('.d.ts') &&
      statSync(path).size < 400_000
    )
      found.push(path);
  }
  return found;
}

let seed = 20261104;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = (list, count) => {
  const copy = [...list];
  const out = [];
  while (out.length < count && copy.length > 0)
    out.push(copy.splice(Math.floor(random() * copy.length), 1)[0]);
  return out;
};

// --- TypeScript -----------------------------------------------------------------------------
const tsFiles = walk(ROOTS.ts, '.ts');
const tsDecls = [];
const tsTexts = new Map();
const exported = new Map();
for (const path of tsFiles) {
  const text = readFileSync(path, 'utf8');
  const rel = relative(ROOTS.ts, path).split('\\').join('/');
  tsTexts.set(rel, text);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const names = [];
  const visit = (node) => {
    const add = (kind, name) => {
      if (name !== undefined && ts.isIdentifier(name))
        tsDecls.push({
          kind,
          name: name.text,
          path: rel,
          line: source.getLineAndCharacterOfPosition(name.getStart(source)).line + 1,
          modifiers: node.modifiers?.length ?? 0,
        });
    };
    if (ts.isMethodDeclaration(node)) add('method', node.name);
    else if (ts.isFunctionDeclaration(node)) add('function', node.name);
    else if (ts.isClassDeclaration(node)) add('class', node.name);
    else if (ts.isInterfaceDeclaration(node)) add('interface', node.name);
    else if (ts.isTypeAliasDeclaration(node)) add('type', node.name);
    if (
      node.parent !== undefined &&
      ts.isSourceFile(node.parent) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isFunctionDeclaration(node) && node.name) names.push(node.name.text);
      if (ts.isClassDeclaration(node) && node.name) names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  exported.set(rel, names);
}
const count = (list, name) => list.filter((d) => d.name === name).length;
const usesOf = (name) => {
  let uses = 0;
  for (const text of tsTexts.values()) if (text.includes(name)) uses += 1;
  return uses;
};
const interesting = (d) => d.name.length >= 5 && count(tsDecls, d.name) === 1;
const ask = (name) =>
  `Where is \`${name}\` declared in this codebase? Answer with the file path and the line number of its declaration. Do not change anything.`;
const whereTask = (d, group) => ({
  id: `${group}-${d.name}`,
  group,
  prompt: ask(d.name),
  repo: 'ts',
  answer: { path: d.path, line: d.line },
});
const methods = tsDecls.filter((d) => d.kind === 'method' && d.modifiers === 0 && interesting(d));
const others = tsDecls.filter((d) => d.kind !== 'method' && interesting(d) && usesOf(d.name) >= 2);
const tasks = [
  ...pick(methods, 10).map((d) => whereTask(d, 'ts-method')),
  ...pick(others, 6).map((d) => whereTask(d, 'ts-decl')),
];

// Names declared in several files: finding all of them is what a rename starts with.
const groups = new Map();
for (const d of tsDecls)
  if (d.kind === 'method' || d.kind === 'function')
    (groups.get(d.name) ?? groups.set(d.name, new Set()).get(d.name)).add(d.path);
const shared = [...groups].filter(
  ([name, paths]) => name.length >= 5 && paths.size >= 3 && paths.size <= 8,
);
for (const [name, paths] of pick(shared, 4))
  tasks.push({
    id: `ts-all-${name}`,
    group: 'ts-all-declarations',
    prompt: `List every file in this codebase that declares a function or method named \`${name}\` (declarations only, not calls). Do not change anything.`,
    repo: 'ts',
    answer: { paths: [...paths] },
  });

// A long file: what does it offer? An outline should shine here.
const big = [...exported].filter(
  ([path, names]) => names.length >= 4 && Buffer.byteLength(tsTexts.get(path)) > 16_384,
);
for (const [path, names] of pick(big, 4))
  tasks.push({
    id: `ts-api-${path.replaceAll('/', '_')}`,
    group: 'ts-big-file-api',
    prompt: `List the names of every function and class exported directly from ${path} (not re-exports). Do not change anything.`,
    repo: 'ts',
    answer: { names },
  });

// --- Python ---------------------------------------------------------------------------------
const pyFiles = walk(ROOTS.py, '.py');
const script = `
import ast, json, sys
out = []
for path in sys.stdin.read().split("\\0"):
    if not path: continue
    try: tree = ast.parse(open(path, encoding="utf-8").read())
    except Exception: continue
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.append({"name": node.name, "path": path, "line": node.lineno})
print(json.dumps(out))
`;
const pyDecls = JSON.parse(
  execFileSync('python3', ['-I', '-c', script], {
    input: pyFiles.join('\0'),
    maxBuffer: 1 << 30,
  }).toString(),
);
const pyGood = pyDecls.filter(
  (d) =>
    d.name.length >= 6 &&
    !d.name.startsWith('test') &&
    !d.name.startsWith('__') &&
    count(pyDecls, d.name) === 1,
);
for (const d of pick(pyGood, 6))
  tasks.push({
    id: `py-${d.name}`,
    group: 'py-decl',
    prompt: ask(d.name),
    repo: 'py',
    answer: { path: relative(ROOTS.py, d.path), line: d.line },
  });

writeFileSync(outPath, JSON.stringify({ roots: ROOTS, tasks }, null, 1));
const by = {};
for (const t of tasks) by[t.group] = (by[t.group] ?? 0) + 1;
process.stdout.write(`${tasks.length} tasks ${JSON.stringify(by)}\n`);
