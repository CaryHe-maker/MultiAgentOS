// Static comparison of symbol lookup: the current regex against tree-sitter, on real code, with an
// independent ground truth (the TypeScript compiler and Python's ast module). Nothing in the corpus
// is executed: it is only read and parsed.
// Usage: node static-eval.mjs <experiment dir with node_modules> <out.json>
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';

const [dir, outPath] = process.argv.slice(2);
const require = createRequire(join(dir, 'x.js'));
const ts = require('typescript');
const { Parser, Language, Query } = require('web-tree-sitter');

const ROOT = '/mnt/e/OpenSourceStructure';
const CORPORA = [
  { name: 'OpenCode', lang: 'ts', dir: `${ROOT}/OpenCode/upstream/packages/core/src` },
  { name: 'DSH', lang: 'ts', dir: `${ROOT}/DeepseekHarness/upstream/packages/session` },
  { name: 'MultiAgentOS', lang: 'ts', dir: process.env.HOME + '/mao2-eval/packages/modules' },
  { name: 'LangGraph', lang: 'py', dir: `${ROOT}/LangGraph` },
  { name: 'DeerFlow', lang: 'py', dir: `${ROOT}/DeerFlow` },
  { name: 'MAF', lang: 'py', dir: `${ROOT}/Microsoft-Agent-Framework` },
];
const MAX_FILES = 700;
const MAX_BYTES = 400_000;

// The current pattern, exactly as packages/libraries/executor-set/src/repository-search/search-query.ts.
const KEYWORDS =
  'function|class|interface|type|const|let|var|def|fn|func|struct|enum|trait|namespace|module';
const MODIFIERS = 'public|private|protected|static|final|abstract|async|override|export';
const declarationPattern = (name) =>
  [
    `\\b(?:${KEYWORDS})[ \\t]+${name}\\b`,
    `\\bfunc[ \\t]*\\([^)]*\\)[ \\t]*${name}\\b`,
    `#[ \\t]*define[ \\t]+${name}\\b`,
    `^[A-Za-z_][A-Za-z0-9_ \\t*]*[ \\t*]${name}[ \\t]*\\(`,
    `^[ \\t]*(?:${MODIFIERS})\\b[A-Za-z0-9_ \\t<>,*\\[\\]]*[ \\t]${name}[ \\t]*\\(`,
  ].join('|');

// The current pattern, fixed only for what the data showed: a declaration keyword must start the
// statement (so `import { type X }` no longer matches), and a method is an indented name followed by
// a parameter list on a line that ends like a signature. Still no look-around, so rg can run it.
const STARTERS =
  'export|default|declare|abstract|async|public|private|protected|static|readonly|override|pub|pub\\([a-z]+\\)';
const betterPattern = (name) =>
  [
    `^[ \\t]*(?:(?:${STARTERS})[ \\t]+)*(?:${KEYWORDS})[ \\t]+${name}\\b`,
    `\\bfunc[ \\t]*\\([^)]*\\)[ \\t]*${name}\\b`,
    `#[ \\t]*define[ \\t]+${name}\\b`,
    `^[A-Za-z_][A-Za-z0-9_ \\t*]*[ \\t*]${name}[ \\t]*\\(`,
    `^[ \\t]*(?:${MODIFIERS})\\b[A-Za-z0-9_ \\t<>,*\\[\\]]*[ \\t]${name}[ \\t]*[<(]`,
    `^[ \\t]+(?:(?:get|set|async|\\*)[ \\t]+)?${name}[ \\t]*(?:<[^>]*>)?\\(.*(?:\\{|:[^;]*;?|,|\\()[ \\t]*$`,
  ].join('|');

function walk(directory, ext, found = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (found.length >= MAX_FILES) break;
    if (['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv'].includes(entry.name))
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, ext, found);
    else if (entry.isFile() && entry.name.endsWith(ext) && !entry.name.endsWith('.d.ts')) {
      if (statSync(path).size <= MAX_BYTES) found.push(path);
    }
  }
  return found;
}

// --- ground truth --------------------------------------------------------------------------
function tsLocals(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out = new Set();
  const add = (node) => {
    if (ts.isIdentifier(node))
      out.add(
        `${node.text}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
      );
    else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node))
      for (const element of node.elements) if (ts.isBindingElement(element)) add(element.name);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) add(node.name);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function tsTruth(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const add = (nameNode, kind, node) => {
    if (nameNode === undefined || !ts.isIdentifier(nameNode)) return;
    const line = source.getLineAndCharacterOfPosition(nameNode.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    out.push({ name: nameNode.text, kind, line, end });
  };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node)) add(node.name, 'function', node);
    else if (ts.isClassDeclaration(node)) add(node.name, 'class', node);
    else if (ts.isInterfaceDeclaration(node)) add(node.name, 'interface', node);
    else if (ts.isTypeAliasDeclaration(node)) add(node.name, 'type', node);
    else if (ts.isEnumDeclaration(node)) add(node.name, 'enum', node);
    else if (ts.isModuleDeclaration(node)) add(node.name, 'namespace', node);
    else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
      add(node.name, 'method', node);
    else if (
      ts.isPropertyDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      add(node.name, 'method', node);
    else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.parent?.parent &&
      ts.isVariableStatement(node.parent.parent) &&
      (ts.isSourceFile(node.parent.parent.parent) || ts.isModuleBlock(node.parent.parent.parent))
    )
      add(node.name, 'variable', node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const PY_TRUTH = `
import ast, json, sys
out = {}
for path in sys.stdin.read().split("\\0"):
    if not path: continue
    try:
        tree = ast.parse(open(path, encoding="utf-8", errors="strict").read())
    except Exception:
        continue
    found = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            kind = "function"
        elif isinstance(node, ast.ClassDef):
            kind = "class"
        else:
            continue
        # The line of the name, not of a decorator.
        found.append({"name": node.name, "kind": kind, "line": node.lineno, "end": node.end_lineno})
    out[path] = found
print(json.dumps(out))
`;

// --- tree-sitter ---------------------------------------------------------------------------
const TS_QUERY = `
(function_declaration name: (identifier) @name) @def
(generator_function_declaration name: (identifier) @name) @def
(class_declaration name: (type_identifier) @name) @def
(abstract_class_declaration name: (type_identifier) @name) @def
(interface_declaration name: (type_identifier) @name) @def
(type_alias_declaration name: (type_identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(module name: (identifier) @name) @def
(internal_module name: (identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(abstract_method_signature name: (property_identifier) @name) @def
(method_signature name: (property_identifier) @name) @def
(public_field_definition name: (property_identifier) @name value: [(arrow_function) (function_expression)]) @def
(program (lexical_declaration (variable_declarator name: (identifier) @name) @def))
(program (variable_declaration (variable_declarator name: (identifier) @name) @def))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @def)))
(program (export_statement (variable_declaration (variable_declarator name: (identifier) @name) @def)))
(program (ambient_declaration (lexical_declaration (variable_declarator name: (identifier) @name) @def)))
(internal_module (statement_block (lexical_declaration (variable_declarator name: (identifier) @name) @def)))
(internal_module (statement_block (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @def))))
(function_signature name: (identifier) @name) @def
`;
const PY_QUERY = `
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @def
`;

await Parser.init();
const wasm = (name) => {
  const candidates = [join(dir, 'node_modules/tree-sitter-wasms/out', `tree-sitter-${name}.wasm`)];
  return candidates[0];
};
const languages = {
  ts: await Language.load(wasm('typescript')),
  py: await Language.load(wasm('python')),
};
const queries = { ts: new Query(languages.ts, TS_QUERY), py: new Query(languages.py, PY_QUERY) };
const parsers = {};
for (const key of Object.keys(languages)) {
  parsers[key] = new Parser();
  parsers[key].setLanguage(languages[key]);
}

function tsitter(lang, text) {
  const tree = parsers[lang].parse(text);
  const out = [];
  let errors = tree.rootNode.hasError ? 1 : 0;
  for (const match of queries[lang].matches(tree.rootNode)) {
    const name = match.captures.find((c) => c.name === 'name')?.node;
    const def = match.captures.find((c) => c.name === 'def')?.node;
    if (name === undefined || def === undefined) continue;
    out.push({ name: name.text, line: name.startPosition.row + 1, end: def.endPosition.row + 1 });
  }
  tree.delete();
  return { symbols: out, errors };
}

// --- outline size ---------------------------------------------------------------------------
function outlineBytes(lines, symbols) {
  const seen = new Set();
  let bytes = 0;
  for (const symbol of symbols) {
    if (seen.has(symbol.line)) continue;
    seen.add(symbol.line);
    bytes += Buffer.byteLength(lines[symbol.line - 1] ?? '', 'utf8') + 8;
  }
  return bytes;
}

const key = (path, line) => `${path}:${line}`;
const results = [];
for (const corpus of CORPORA) {
  const ext = corpus.lang === 'ts' ? '.ts' : '.py';
  const files = walk(corpus.dir, ext);
  const texts = new Map();
  for (const path of files) {
    try {
      texts.set(path, readFileSync(path, 'utf8'));
    } catch {}
  }
  let pyTruth = {};
  if (corpus.lang === 'py')
    pyTruth = JSON.parse(
      execFileSync('python3', ['-I', '-c', PY_TRUTH], {
        input: [...texts.keys()].join('\0'),
        maxBuffer: 1 << 30,
      }).toString(),
    );
  const locals = new Map();
  if (corpus.lang === 'ts')
    for (const [path, text] of texts) locals.set(path, tsLocals(path, text));
  const truth = new Map();
  for (const [path, text] of texts) {
    const found = corpus.lang === 'ts' ? tsTruth(path, text) : pyTruth[path];
    if (found !== undefined) truth.set(path, found);
  }

  // Symbol names to look up: every distinct declared name, sampled evenly so runs repeat.
  const byName = new Map();
  for (const [path, symbols] of truth)
    for (const symbol of symbols) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol.name)) continue;
      if (!byName.has(symbol.name)) byName.set(symbol.name, []);
      byName.get(symbol.name).push({ ...symbol, path });
    }
  const names = [...byName.keys()].sort();
  const step = Math.max(1, Math.floor(names.length / 400));
  const sample = names.filter((_, i) => i % step === 0);

  // tree-sitter over all files, timed apart from everything else.
  const t0 = performance.now();
  const tsSymbols = new Map();
  let parseErrors = 0;
  for (const [path, text] of texts) {
    if (!truth.has(path)) continue;
    const found = tsitter(corpus.lang, text);
    parseErrors += found.errors;
    tsSymbols.set(path, found.symbols);
  }
  const parseMs = performance.now() - t0;

  const linesOf = new Map([...texts].map(([path, text]) => [path, text.split('\n')]));
  const t1 = performance.now();
  // The scan the regex does: one pass over all lines per name, as the scan backend would.
  const regexHits = new Map();
  for (const name of sample) {
    const expression = new RegExp(declarationPattern(name.replace(/[.$]/g, '\\$&')));
    const hits = new Set();
    for (const path of truth.keys()) {
      const lines = linesOf.get(path);
      for (let i = 0; i < lines.length; i += 1)
        if (lines[i].includes(name) && expression.test(lines[i])) hits.add(key(path, i + 1));
    }
    regexHits.set(name, hits);
  }
  const regexMs = performance.now() - t1;

  const t2 = performance.now();
  const betterHits = new Map();
  for (const name of sample) {
    const expression = new RegExp(betterPattern(name.replace(/[.$]/g, '\\$&')));
    const hits = new Set();
    for (const path of truth.keys()) {
      const lines = linesOf.get(path);
      for (let i = 0; i < lines.length; i += 1)
        if (lines[i].includes(name) && expression.test(lines[i])) hits.add(key(path, i + 1));
    }
    betterHits.set(name, hits);
  }
  const betterMs = performance.now() - t2;

  const tsByName = new Map();
  for (const [path, symbols] of tsSymbols)
    for (const symbol of symbols) {
      if (!tsByName.has(symbol.name)) tsByName.set(symbol.name, new Set());
      tsByName.get(symbol.name).add(key(path, symbol.line));
    }

  const score = () => ({ tp: 0, fp: 0, local: 0, fn: 0, namesFound: 0, namesAllFound: 0 });
  const totals = { regex: score(), better: score(), treeSitter: score() };
  const missByKind = { regex: {}, better: {}, treeSitter: {} };
  const declByKind = {};
  const falseByKind = {};
  const betterFalseByKind = {};
  const falseExamples = {};
  const examples = {
    regexMiss: [],
    regexFalse: [],
    tsMiss: [],
    tsFalse: [],
    betterMiss: [],
    betterFalse: [],
  };
  let regexOutputLines = 0;
  let tsOutputLines = 0;
  for (const name of sample) {
    const wanted = new Map(byName.get(name).map((s) => [key(s.path, s.line), s]));
    for (const s of wanted.values()) declByKind[s.kind] = (declByKind[s.kind] ?? 0) + 1;
    for (const [tool, got] of [
      ['regex', regexHits.get(name)],
      ['better', betterHits.get(name)],
      ['treeSitter', tsByName.get(name) ?? new Set()],
    ]) {
      const t = totals[tool];
      let found = 0;
      for (const hit of got)
        if (wanted.has(hit)) {
          t.tp += 1;
          found += 1;
        } else {
          const at = hit.lastIndexOf(':');
          if (locals.get(hit.slice(0, at))?.has(`${name}:${hit.slice(at + 1)}`)) {
            t.local += 1;
            continue;
          }
          t.fp += 1;
          if (tool !== 'treeSitter') {
            const text = (
              linesOf.get(hit.slice(0, at))?.[Number(hit.slice(at + 1)) - 1] ?? ''
            ).trim();
            const kind = /^(\/\/|\*|\/\*|#)/.test(text)
              ? 'comment'
              : /^(import|export)\b.*\bfrom\b|^type [A-Za-z_$][\w$]*,?$/.test(text)
                ? 'import/export list'
                : /\b(if|for|while|return|switch|catch|await)\b/.test(text) || /[;)]$/.test(text)
                  ? 'code'
                  : 'other';
            const where = tool === 'regex' ? falseByKind : betterFalseByKind;
            where[kind] = (where[kind] ?? 0) + 1;
            if (tool === 'better' && (falseExamples[kind] ??= []).length < 5)
              falseExamples[kind].push(text.slice(0, 100));
          }
          const list =
            tool === 'regex'
              ? examples.regexFalse
              : tool === 'better'
                ? examples.betterFalse
                : examples.tsFalse;
          if (list.length < 6) {
            const [path, line] = [
              hit.slice(0, hit.lastIndexOf(':')),
              Number(hit.slice(hit.lastIndexOf(':') + 1)),
            ];
            list.push(
              `${relative(corpus.dir, path)}:${line}: ${(linesOf.get(path)?.[line - 1] ?? '').trim().slice(0, 90)}`,
            );
          }
        }
      for (const [hit, symbol] of wanted)
        if (!got.has(hit)) {
          t.fn += 1;
          missByKind[tool][symbol.kind] = (missByKind[tool][symbol.kind] ?? 0) + 1;
          const list =
            tool === 'regex'
              ? examples.regexMiss
              : tool === 'better'
                ? examples.betterMiss
                : examples.tsMiss;
          if (list.length < 6)
            list.push(
              `${symbol.kind} ${relative(corpus.dir, symbol.path)}:${symbol.line}: ${(linesOf.get(symbol.path)?.[symbol.line - 1] ?? '').trim().slice(0, 90)}`,
            );
        }
      if (found > 0) t.namesFound += 1;
      if (found === wanted.size) t.namesAllFound += 1;
    }
    regexOutputLines += regexHits.get(name).size;
    tsOutputLines += (tsByName.get(name) ?? new Set()).size;
  }

  // What an outline would save, against reading the whole file.
  let fileBytes = 0;
  let outline = 0;
  const big = { files: 0, fileBytes: 0, outline: 0 };
  for (const [path, symbols] of tsSymbols) {
    const size = Buffer.byteLength(texts.get(path), 'utf8');
    const out = outlineBytes(linesOf.get(path), symbols);
    fileBytes += size;
    outline += out;
    if (size > 16_384) {
      big.files += 1;
      big.fileBytes += size;
      big.outline += out;
    }
  }

  const metric = (t) => ({
    ...t,
    precision: t.tp / Math.max(1, t.tp + t.fp),
    recall: t.tp / Math.max(1, t.tp + t.fn),
  });
  results.push({
    corpus: corpus.name,
    lang: corpus.lang,
    files: truth.size,
    declarations: [...truth.values()].reduce((n, s) => n + s.length, 0),
    distinctNames: names.length,
    sampledNames: sample.length,
    declByKind,
    regex: metric(totals.regex),
    better: metric(totals.better),
    treeSitter: metric(totals.treeSitter),
    missByKind,
    falseByKind,
    betterFalseByKind,
    falseExamples,
    examples,
    speed: {
      parseAllFilesMs: Math.round(parseMs),
      parseMsPerFile: parseMs / Math.max(1, truth.size),
      regexScanMsPerName: regexMs / Math.max(1, sample.length),
      betterScanMsPerName: betterMs / Math.max(1, sample.length),
      parseErrorFiles: parseErrors,
    },
    outline: {
      fileBytes,
      outlineBytes: outline,
      ratio: outline / Math.max(1, fileBytes),
      bigFiles: big.files,
      bigRatio: big.outline / Math.max(1, big.fileBytes),
    },
  });
  process.stdout.write(`${corpus.name}: ${truth.size} files, ${sample.length} names\n`);
}
const sizes = {};
for (const name of [
  'typescript',
  'python',
  'tsx',
  'javascript',
  'go',
  'rust',
  'java',
  'cpp',
  'c_sharp',
]) {
  try {
    sizes[name] = statSync(wasm(name)).size;
  } catch {}
}
try {
  sizes.runtime = statSync(join(dir, 'node_modules/web-tree-sitter/tree-sitter.wasm')).size;
} catch {}
writeFileSync(outPath, JSON.stringify({ results, sizes }, null, 1));
for (const r of results) {
  const f = (m) =>
    `P=${(m.precision * 100).toFixed(1)} R=${(m.recall * 100).toFixed(1)} tp=${m.tp} fp=${m.fp} local=${m.local} fn=${m.fn}`;
  process.stdout.write(
    `${r.corpus}\n  regex  ${f(r.regex)} ${JSON.stringify(r.falseByKind)}\n  better ${f(r.better)} ${JSON.stringify(r.betterFalseByKind)} miss ${JSON.stringify(r.missByKind.better)}\n  tsit   ${f(r.treeSitter)} miss ${JSON.stringify(r.missByKind.treeSitter)}\n  speed parse ${r.speed.parseMsPerFile.toFixed(1)}ms/file (${r.speed.parseAllFilesMs}ms all) scan ${r.speed.regexScanMsPerName.toFixed(1)}ms/name errors ${r.speed.parseErrorFiles}/${r.files} outline ${(r.outline.ratio * 100).toFixed(1)}% big ${(r.outline.bigRatio * 100).toFixed(1)}% (${r.outline.bigFiles} files)\n`,
  );
}
process.stdout.write(
  `BETTER FALSE ${JSON.stringify(results.slice(0, 3).map((r) => r.falseExamples))}\nBETTER MISS ${JSON.stringify(results.flatMap((r) => r.examples.betterMiss).slice(0, 8))}\n`,
);
process.stdout.write(`wasm sizes ${JSON.stringify(sizes)}\n`);
