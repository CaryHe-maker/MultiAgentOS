import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type {
  BoundaryContext,
  ContextPack,
  ContextPort,
  ContextRequest,
} from '@multiagentos/contracts';
import { assertValid, ContextPackSchema, ContextRequestSchema } from '@multiagentos/contracts';

export interface ContextEngineOptions {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly ignoreNames: readonly string[];
}
const defaults: ContextEngineOptions = {
  maxFileBytes: 256_000,
  maxFiles: 10_000,
  ignoreNames: ['.git', 'node_modules', 'dist', 'build', 'coverage', '.multiagent'],
};

const queryTerms = (value: string): string[] => {
  const terms = value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.$-]+/u)
    .filter((term) => term.length >= 2);
  const expanded = terms.flatMap((term) => {
    if (!/\p{Script=Han}/u.test(term)) return [term];
    const characters = [...term];
    return [
      term,
      ...characters.slice(0, -1).map((character, index) => character + characters[index + 1]),
    ];
  });
  return [...new Set(expanded)].slice(0, 64);
};

export class LocalContextEngine implements ContextPort {
  public constructor(private readonly options: ContextEngineOptions = defaults) {}
  async buildContext(rawRequest: ContextRequest, context?: BoundaryContext): Promise<ContextPack> {
    void context;
    const request = assertValid<ContextRequest>(ContextRequestSchema, rawRequest);
    const root = await realpath(request.workspace.rootPath);
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
      throw new Error('Workspace root must be a real directory');
    const paths = await this.#walk(root, root);
    const terms = queryTerms(`${request.objective} ${request.query ?? ''}`);
    const candidates: { path: string; content: string; score: number }[] = [];
    for (const path of paths) {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.size > this.options.maxFileBytes) continue;
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\0')) continue;
      const relativePath = relative(root, path).replaceAll(sep, '/');
      const haystack = `${relativePath}\n${content}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      candidates.push({ path: relativePath, content, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const items: ContextPack['items'][number][] = [];
    let tokenCount = 0;
    for (const candidate of candidates) {
      const remaining = request.tokenBudget - tokenCount;
      if (remaining <= 0) break;
      const lines = candidate.content.split(/\r?\n/u);
      const maxChars = remaining * 4;
      const content = candidate.content.slice(0, maxChars);
      const estimated = Math.ceil(content.length / 4);
      if (estimated === 0) continue;
      items.push(
        Object.freeze({
          path: candidate.path,
          startLine: 1,
          endLine: Math.min(lines.length, content.split(/\r?\n/u).length),
          content,
          reason:
            candidate.score > 0
              ? `matched ${candidate.score} objective/query terms`
              : 'repository structure fallback',
        }),
      );
      tokenCount += estimated;
    }
    const pack = {
      contextPackId: `ctx_${randomUUID().replaceAll('-', '')}`,
      workspace: request.workspace,
      repositoryRevision: request.workspace.repositoryRevision,
      items: Object.freeze(items),
      tokenCount,
      provenance: Object.freeze(
        items.map((item) =>
          Object.freeze({
            source: item.path,
            revision: request.workspace.repositoryRevision,
            retrieval: terms.length > 0 ? ('TEXT' as const) : ('TREE' as const),
          }),
        ),
      ),
      createdAt: new Date().toISOString(),
    };
    return Object.freeze(assertValid<ContextPack>(ContextPackSchema, pack));
  }
  async #walk(root: string, directory: string, output: string[] = []): Promise<string[]> {
    if (output.length >= this.options.maxFiles) return output;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (output.length >= this.options.maxFiles) break;
      if (this.options.ignoreNames.includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      const canonical = await realpath(path);
      if (canonical !== root && !canonical.startsWith(`${root}${sep}`))
        throw new Error(`Workspace escape rejected: ${path}`);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) continue;
      if (entry.isDirectory()) await this.#walk(root, path, output);
      else if (entry.isFile()) output.push(path);
    }
    return output;
  }
}
