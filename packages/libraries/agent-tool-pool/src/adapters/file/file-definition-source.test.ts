import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { buildCatalogIndex, planSeal } from '../../domain/catalog-index.js';
import { draftDocuments } from '../../test-support/definition-fixtures.js';
import { FileDefinitionSource } from './file-definition-source.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function writeCatalog(
  files: Readonly<Record<string, string>> = draftFiles(),
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-tool-pool-'));
  roots.push(root);
  for (const [origin, text] of Object.entries(files)) {
    const path = join(root, ...origin.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  }
  return root;
}

function draftFiles(): Record<string, string> {
  return Object.fromEntries(
    draftDocuments().map((document) => [
      document.origin,
      `# ${document.origin}\n${stringify(document.content)}`,
    ]),
  );
}

const codesOf = async (root: string) =>
  (await new FileDefinitionSource(root).load()).issues.map((issue) => issue.code);

describe('FileDefinitionSource', () => {
  it('loads YAML definitions in a stable order', async () => {
    const root = await writeCatalog();
    const snapshot = await new FileDefinitionSource(root).load();
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.documents.map((document) => document.origin)).toEqual([
      'agents/analysis-agent/v1.0.0.yaml',
      'models/test-model/v1.0.0.yaml',
      'prompts/analysis/v1.0.0.yaml',
      'tools/finish-analysis/v1.0.0.yaml',
      'tools/read-file/v1.0.0.yaml',
      'units/context-assemble/v1.0.0.yaml',
      'units/file-read/v1.0.0.yaml',
      'units/model-call/v1.0.0.yaml',
      'units/report-publish/v1.0.0.yaml',
    ]);
  });

  it('seals drafts in place, keeps comments and then loads cleanly', async () => {
    const root = await writeCatalog();
    const source = new FileDefinitionSource(root);
    const plan = planSeal(await source.load());
    expect(plan.issues).toEqual([]);
    await source.writeDigests(plan.patches);
    const toolText = await readFile(join(root, 'tools', 'read-file', 'v1.0.0.yaml'), 'utf8');
    expect(toolText).toMatch(/^# tools\/read-file\/v1\.0\.0\.yaml\n/u);
    expect(toolText).toMatch(/version: v1\.0\.0\ndigest: [a-f0-9]{64}\n/u);
    const result = buildCatalogIndex(await new FileDefinitionSource(root).load());
    expect(result.ok).toBe(true);
    expect(planSeal(await source.load()).patches).toEqual([]);
  });

  it('refuses to seal a file edited after it was loaded', async () => {
    const root = await writeCatalog();
    const source = new FileDefinitionSource(root);
    const plan = planSeal(await source.load());
    const toolPath = join(root, 'tools', 'read-file', 'v1.0.0.yaml');
    await writeFile(toolPath, `${await readFile(toolPath, 'utf8')}# edited\n`, 'utf8');
    await expect(source.writeDigests(plan.patches)).rejects.toThrow(/changed since it was loaded/u);
  });

  it('supports JSON definitions', async () => {
    const files = draftFiles();
    const [tool] = draftDocuments();
    delete files['tools/read-file/v1.0.0.yaml'];
    files['tools/read-file/v1.0.0.json'] = JSON.stringify(tool?.content, null, 2);
    const root = await writeCatalog(files);
    const source = new FileDefinitionSource(root);
    await source.writeDigests(planSeal(await source.load()).patches);
    const json = JSON.parse(
      await readFile(join(root, 'tools', 'read-file', 'v1.0.0.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(json).slice(0, 5)).toEqual([
      'schemaVersion',
      'version',
      'digest',
      'description',
      'kind',
    ]);
    expect(buildCatalogIndex(await source.load()).ok).toBe(true);
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
    [
      'a path that disagrees with the content',
      'tools/other-tool/v2.0.0.yaml',
      stringify(draftDocuments()[0]?.content),
      'SOURCE_LOCATION_INVALID',
    ],
  ])('reports %s', async (_label, origin, text, code) => {
    const root = await writeCatalog({ [origin]: text });
    expect(await codesOf(root)).toEqual([code]);
  });

  it('ignores a root README and rejects symbolic links', async () => {
    const root = await writeCatalog({ 'README.md': '# catalog\n' });
    expect(await codesOf(root)).toEqual([]);
    await mkdir(join(root, 'tools'));
    await symlink(join(root, 'README.md'), join(root, 'tools', 'link.yaml'));
    expect(await codesOf(root)).toEqual(['SOURCE_UNREADABLE']);
  });
});
