import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Document, parse, stringify, visit } from 'yaml';
import { buildCatalogIndexV1, planSealV1 } from '../../catalog-v1/catalog-v1.js';
import { DEFAULT_DEFINITIONS_DIRECTORY } from '../../definitions-directory.js';
import { FileDefinitionSource } from './file-definition-source.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The definition files shipped with the package, by origin; all of them are drafts. */
async function shippedFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(DEFAULT_DEFINITIONS_DIRECTORY, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml') || entry.name === 'status.yaml') continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(DEFAULT_DEFINITIONS_DIRECTORY, path).split(sep).join('/')] = await readFile(
      path,
      'utf8',
    );
  }
  return files;
}

const PUBLISHED = 'tools/reply/v1.0.0.yaml';

/** The draft `reply` tool as a published `v1.0.0` without a digest: what sealing finds. */
async function publishedTool(): Promise<Record<string, unknown>> {
  const draft = parse(
    await readFile(join(DEFAULT_DEFINITIONS_DIRECTORY, 'tools', 'reply', 'v0.1.0.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  return { ...draft, version: 'v1.0.0' };
}

async function writeCatalog(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-tool-pool-'));
  roots.push(root);
  for (const [origin, text] of Object.entries(files)) {
    const path = join(root, ...origin.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  }
  return root;
}

const codesOf = async (root: string) =>
  (await new FileDefinitionSource(root).load()).issues.map((issue) => issue.code);

describe('FileDefinitionSource', () => {
  it('loads YAML definitions in a stable order', async () => {
    const files = await shippedFiles();
    const snapshot = await new FileDefinitionSource(await writeCatalog(files)).load();
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.documents.map((document) => document.origin)).toEqual(
      Object.keys(files).sort(),
    );
  });

  it('seals a published version in place, keeps comments and formatting and then loads cleanly', async () => {
    const files = await shippedFiles();
    // Flow mappings without padding: re-serializing the document would rewrite them as `{ a: b }`.
    const tool = new Document(await publishedTool());
    visit(tool, {
      Map: (key, node) => {
        if (key !== null) node.flow = true;
      },
    });
    const written = `# ${PUBLISHED}\n${tool.toString({ flowCollectionPadding: false })}`;
    files[PUBLISHED] = written;
    const root = await writeCatalog(files);
    const source = new FileDefinitionSource(root);
    const plan = planSealV1(await source.load());
    expect(plan.issues).toEqual([]);
    expect(plan.patches.map((patch) => patch.origin)).toEqual([PUBLISHED]);
    await source.writeDigests(plan.patches);
    const toolText = await readFile(join(root, ...PUBLISHED.split('/')), 'utf8');
    const digest = plan.patches[0]?.digest ?? '';
    expect(written).toMatch(/: \{\w/u);
    // Exactly one line is added; everything the author wrote stays as it was.
    expect(toolText).toBe(
      written.replace(/^version: v1\.0\.0\n/mu, `version: v1.0.0\ndigest: ${digest}\n`),
    );
    expect(buildCatalogIndexV1(await new FileDefinitionSource(root).load()).ok).toBe(true);
    expect(planSealV1(await source.load()).patches).toEqual([]);
  });

  it('refuses to seal a file edited after it was loaded', async () => {
    const files = await shippedFiles();
    files[PUBLISHED] = stringify(await publishedTool());
    const root = await writeCatalog(files);
    const source = new FileDefinitionSource(root);
    const plan = planSealV1(await source.load());
    const toolPath = join(root, ...PUBLISHED.split('/'));
    await writeFile(toolPath, `${await readFile(toolPath, 'utf8')}# edited\n`, 'utf8');
    await expect(source.writeDigests(plan.patches)).rejects.toThrow(/changed since it was loaded/u);
  });

  it('supports JSON definitions', async () => {
    const files = await shippedFiles();
    files['tools/reply/v1.0.0.json'] = JSON.stringify(await publishedTool(), null, 2);
    const root = await writeCatalog(files);
    const source = new FileDefinitionSource(root);
    await source.writeDigests(planSealV1(await source.load()).patches);
    const json = JSON.parse(
      await readFile(join(root, 'tools', 'reply', 'v1.0.0.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(json)).toContain('digest');
    expect(Object.keys(json).indexOf('digest')).toBe(Object.keys(json).indexOf('version') + 1);
    expect(buildCatalogIndexV1(await source.load()).ok).toBe(true);
  });

  it('uses the YAML 1.2 core schema so words like `no` stay strings', async () => {
    const root = await writeCatalog({
      'status.yaml': 'schemaVersion: v0\nentries: []\nflag: no\n',
    });
    const snapshot = await new FileDefinitionSource(root).load();
    expect(snapshot.statusDocument?.content).toEqual({
      schemaVersion: 'v0',
      entries: [],
      flag: 'no',
    });
  });

  it.each([
    ['broken YAML', 'tools/read-file/v1.0.0.yaml', 'kind: [TOOL\n', 'SOURCE_UNREADABLE'],
    ['duplicate YAML keys', 'tools/read-file/v1.0.0.yaml', 'id: a\nid: b\n', 'SOURCE_UNREADABLE'],
    ['broken JSON', 'tools/read-file/v1.0.0.json', '{', 'SOURCE_UNREADABLE'],
    ['a byte order mark', 'tools/read-file/v1.0.0.yaml', '﻿kind: TOOL\n', 'SOURCE_UNREADABLE'],
    ['an unknown directory', 'executors/x/v1.0.0.yaml', 'kind: TOOL\n', 'SOURCE_LOCATION_INVALID'],
    ['an unsupported extension', 'tools/read-file/v1.0.0.txt', 'x', 'SOURCE_LOCATION_INVALID'],
  ])('reports %s', async (_label, origin, text, code) => {
    const root = await writeCatalog({ [origin]: text });
    expect(await codesOf(root)).toEqual([code]);
  });

  it('reports a path that disagrees with the content', async () => {
    const root = await writeCatalog({
      'tools/other-tool/v2.0.0.yaml': stringify(await publishedTool()),
    });
    expect(await codesOf(root)).toEqual(['SOURCE_LOCATION_INVALID']);
  });

  it('ignores a root README and rejects symbolic links', async () => {
    const root = await writeCatalog({ 'README.md': '# catalog\n' });
    expect(await codesOf(root)).toEqual([]);
    await mkdir(join(root, 'tools'));
    await symlink(join(root, 'README.md'), join(root, 'tools', 'link.yaml'));
    expect(await codesOf(root)).toEqual(['SOURCE_UNREADABLE']);
  });
});
