import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { isMap, isScalar, parseDocument } from 'yaml';
import type { DefinitionKind } from '@multiagentos/contracts';
import type { CatalogIssue } from '../../domain/catalog-issue.js';
import type {
  SealPatch,
  SealableDefinitionSource,
  SourceDocument,
  SourceSnapshot,
} from '../../ports/definition-source.js';

/**
 * Directory layout (all paths relative to the root):
 *
 *   agents/<id>/<version>.yaml     units/<id>/<version>.yaml     tools/<id>/<version>.yaml
 *   models/<id>/<version>.yaml     prompts/<id>/<version>.yaml   status.yaml (optional)
 *
 * `.yml` and `.json` are accepted too. The path must agree with the document's kind, id and
 * version, so a copied file cannot silently shadow another definition.
 */
const KIND_DIRECTORIES: Readonly<Record<string, DefinitionKind>> = {
  agents: 'AGENT',
  units: 'UNIT',
  tools: 'TOOL',
  models: 'MODEL',
  prompts: 'PROMPT',
};
const STATUS_FILE = 'status.yaml';
const IGNORED_ROOT_FILES = new Set(['README.md']);
const EXTENSIONS = new Set(['.yaml', '.yml', '.json']);
/** Definitions are small; anything larger is a mistake, not a definition. */
const MAX_FILE_BYTES = 1024 * 1024;

export class FileDefinitionSource implements SealableDefinitionSource {
  /** Text hash of every file read by the last `load`, so sealing never overwrites newer edits. */
  readonly #loadedHashes = new Map<string, string>();

  public constructor(private readonly rootDirectory: string) {}

  async load(): Promise<SourceSnapshot> {
    this.#loadedHashes.clear();
    const documents: SourceDocument[] = [];
    const issues: CatalogIssue[] = [];
    let statusDocument: SourceDocument | undefined;
    const files = await this.#listFiles(this.rootDirectory, issues);
    for (const file of files) {
      const origin = toOrigin(this.rootDirectory, file);
      const document = await this.#readDocument(file, origin, issues);
      if (document === undefined) continue;
      if (origin === STATUS_FILE) statusDocument = document;
      else if (checkLocation(document, issues)) documents.push(document);
    }
    return statusDocument === undefined
      ? { documents, issues }
      : { documents, statusDocument, issues };
  }

  async writeDigests(patches: readonly SealPatch[]): Promise<void> {
    for (const patch of patches) {
      const path = join(this.rootDirectory, ...patch.origin.split('/'));
      const text = await readFile(path, 'utf8');
      if (hashText(text) !== this.#loadedHashes.get(patch.origin))
        throw new Error(`${patch.origin} changed since it was loaded; run the seal again`);
      await writeFile(path, insertDigest(text, extname(path), patch.digest), 'utf8');
    }
  }

  async #listFiles(directory: string, issues: CatalogIssue[]): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const origin = toOrigin(this.rootDirectory, path);
      if (entry.isSymbolicLink()) {
        issues.push(unreadable(origin, 'symbolic links are not allowed in the catalog'));
      } else if (entry.isDirectory()) {
        files.push(...(await this.#listFiles(path, issues)));
      } else if (
        entry.isFile() &&
        !(directory === this.rootDirectory && IGNORED_ROOT_FILES.has(entry.name))
      ) {
        files.push(path);
      }
    }
    return files;
  }

  async #readDocument(
    path: string,
    origin: string,
    issues: CatalogIssue[],
  ): Promise<SourceDocument | undefined> {
    const extension = extname(path);
    if (!EXTENSIONS.has(extension)) {
      issues.push(location(origin, `unsupported file type ${extension || '(none)'}`));
      return undefined;
    }
    const { size } = await lstat(path);
    if (size > MAX_FILE_BYTES) {
      issues.push(unreadable(origin, `file is larger than ${MAX_FILE_BYTES} bytes`));
      return undefined;
    }
    const text = await readFile(path, 'utf8');
    this.#loadedHashes.set(origin, hashText(text));
    const decoded = decode(text, extension);
    if (!decoded.ok) {
      issues.push(unreadable(origin, decoded.message));
      return undefined;
    }
    return { origin, content: decoded.content };
  }
}

type Decoded =
  | { readonly ok: true; readonly content: unknown }
  | { readonly ok: false; readonly message: string };

function decode(text: string, extension: string): Decoded {
  if (text.startsWith('﻿')) return { ok: false, message: 'file must be UTF-8 without BOM' };
  if (extension === '.json') {
    try {
      return { ok: true, content: JSON.parse(text) as unknown };
    } catch (error: unknown) {
      return { ok: false, message: `invalid JSON: ${errorMessage(error)}` };
    }
  }
  // YAML 1.2 core schema: `no`, `on` and dates stay strings, so a value never changes type
  // (and digest) depending on how it happens to be spelled.
  const document = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0)
    return { ok: false, message: problems.map((problem) => problem.message).join('; ') };
  return { ok: true, content: document.toJS() as unknown };
}

/** Writes `digest` right after `version`, keeping comments and layout of YAML files. */
function insertDigest(text: string, extension: string, digest: string): string {
  if (extension === '.json') {
    const entries = Object.entries(JSON.parse(text) as Record<string, unknown>);
    const index = entries.findIndex(([key]) => key === 'version');
    entries.splice(index + 1, 0, ['digest', digest]);
    return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
  }
  const document = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true });
  const root = document.contents;
  if (!isMap(root)) throw new Error('definition YAML must be a mapping');
  const index = root.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === 'version');
  root.items.splice(index + 1, 0, document.createPair('digest', digest));
  return document.toString({ lineWidth: 0 });
}

function checkLocation(document: SourceDocument, issues: CatalogIssue[]): boolean {
  const segments = document.origin.split('/');
  const [directory = '', id = '', file = ''] = segments;
  const expectedKind = KIND_DIRECTORIES[directory];
  if (segments.length !== 3 || expectedKind === undefined) {
    issues.push(
      location(
        document.origin,
        `expected <${Object.keys(KIND_DIRECTORIES).join('|')}>/<id>/<version>.yaml`,
      ),
    );
    return false;
  }
  const version = file.slice(0, file.length - extname(file).length);
  const content = document.content;
  const actual =
    typeof content === 'object' && content !== null
      ? (content as Readonly<Record<string, unknown>>)
      : {};
  const mismatches = [
    ['kind', expectedKind],
    ['id', id],
    ['version', version],
  ].filter(([field = '', expected]) => actual[field] !== expected);
  if (mismatches.length === 0) return true;
  issues.push(
    location(
      document.origin,
      mismatches
        .map(([field = '', expected]) => `${field} must be ${expected} to match the path`)
        .join('; '),
    ),
  );
  return false;
}

function toOrigin(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreadable(origin: string, message: string): CatalogIssue {
  return { origin, code: 'SOURCE_UNREADABLE', message };
}

function location(origin: string, message: string): CatalogIssue {
  return { origin, code: 'SOURCE_LOCATION_INVALID', message };
}
