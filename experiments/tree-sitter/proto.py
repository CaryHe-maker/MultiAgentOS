#!/usr/bin/env python3
# Applies the tree-sitter prototype to a throw-away clone. Usage: proto.py <clone> <dir of this file>
import shutil, sys
clone, here = sys.argv[1], sys.argv[2]
def sub(p, a, b):
    p = f'{clone}/{p}'
    s = open(p, encoding='utf-8', newline='').read()
    assert a in s, (p, a)
    open(p, 'w', encoding='utf-8', newline='').write(s.replace(a, b, 1))

shutil.copy(f'{here}/ts-symbols.ts', f'{clone}/packages/libraries/executor-set/src/repository-search/ts-symbols.ts')
shutil.copy(f'{here}/run-nav-eval.ts', f'{clone}/apps/control-plane/test/acceptance/write-eval/run-nav-eval.ts')

X = 'packages/libraries/executor-set/src/repository-search/search-executor.ts'
sub(X, "import { previewLimitsOf, retainItems } from '../retention/retention.js';",
    "import { previewLimitsOf, retainItems } from '../retention/retention.js';\nimport { arm, symbolsOf } from './ts-symbols.js';\nimport { normalizeRequestPath } from '@multiagentos/contracts';")
sub(X, """  const query = prepareQuery(input.query, input.mode);
  if (query === undefined) return rejected('INVALID_QUERY');""",
"""  if ((input.mode as string) === 'OUTLINE') return outline(input.query, scope);
  const query = prepareQuery(input.query, input.mode);
  if (query === undefined) return rejected('INVALID_QUERY');""")
sub(X, """    const matches = await findLines(request, environment, options.backend);
    incomplete = matches.incomplete;""",
"""    const matches =
      query.line.kind === 'SYMBOL' && arm() !== 'regex'
        ? await treeSitterLines(query.query, request, environment, options.backend)
        : await findLines(request, environment, options.backend);
    incomplete = matches.incomplete;""")
sub(X, """async function findLines(
  request: SearchRequest,""",
"""/** Files that mention the name, then the syntax tree decides; other languages keep the regex. */
async function treeSitterLines(
  name: string,
  request: SearchRequest,
  environment: ExecutorEnvironment,
  backend: SearchBackend | undefined,
) {
  const text = await findLines(
    { ...request, line: { kind: 'TEXT', pattern: name, ignoreCase: false } },
    environment,
    backend,
  );
  const regex = await findLines(request, environment, backend);
  const files = new Map(request.set.files.map((file) => [file.path, file]));
  const lines = new Map<string, number[]>();
  for (const path of text.lines.keys()) {
    const file = files.get(path);
    const content = file === undefined ? undefined : await readSnapshotFile(request.scope, file);
    if (content === undefined) continue;
    const symbols = await symbolsOf(path, content.toString('utf8'));
    const found =
      symbols === undefined
        ? regex.lines.get(path)
        : symbols.filter((symbol) => symbol.name === name).map((symbol) => symbol.line);
    if (found !== undefined && found.length > 0) lines.set(path, [...found]);
  }
  return { lines, incomplete: text.incomplete };
}

/** One line per declaration of a file: the file's table of contents. */
async function outline(path: string, scope: RepositoryScope) {
  const mediaType = MEDIA_TYPES.fileText;
  const none = (text: string) =>
    completed({ output: { snapshotId: `snp_${'0'.repeat(64)}`, hits: [], truncated: false }, artifact: { mediaType, text } });
  const relative = normalizeRequestPath(path);
  if (relative === undefined) return rejected('OUT_OF_SCOPE');
  const read = await readGuardedFile(scope, relative);
  if (!read.ok) return read.outcome;
  const text = read.file.content.toString('utf8');
  const symbols = await symbolsOf(relative, text);
  if (symbols === undefined) return none(`No outline for ${relative}: read it instead.`);
  const source = text.split('\\n');
  const rows = [...symbols]
    .sort((a, b) => a.line - b.line)
    .map((s) => `${String(s.line)}-${String(s.end)} | ${(source[s.line - 1] ?? '').trim().slice(0, 160)}`);
  return none(`${relative}: ${String(source.length)} lines, ${String(rows.length)} declarations\\n${rows.join('\\n')}`);
}

async function findLines(
  request: SearchRequest,""")
sub(X, "import {\n  buildFileSet,", "import { readGuardedFile } from '../repository-access/guarded-file.js';\nimport {\n  buildFileSet,")
sub('packages/libraries/contracts/src/context/repository.ts',
    "export const SEARCH_MODES = ['AUTO', 'TEXT', 'PATH', 'SYMBOL'] as const;",
    "export const SEARCH_MODES = ['AUTO', 'TEXT', 'PATH', 'SYMBOL', 'OUTLINE'] as const;")
# Offered only to the arm that has it, by the tool description the model reads.
sub('packages/modules/kernel/src/session/pinned-agent.ts',
    "    description: tool.modelDescription,",
    "    description:\n      tool.modelName === 'search_repository' && process.env['MAO_TS_ARM'] === 'outline'\n        ? `${tool.modelDescription} mode OUTLINE takes a file path as query and lists that file's declarations with their line ranges, much cheaper than reading a long file.`\n        : tool.modelDescription,")
