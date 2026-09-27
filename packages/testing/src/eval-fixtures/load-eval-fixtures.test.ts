import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { EvalTask, WebSnapshotManifest } from './eval-task-schema.js';
import { loadEvalFixtures } from './load-eval-fixtures.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eval-fixtures-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(relativePath: string, content: string | Uint8Array): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function repositoryTask(id = 'F1-001'): EvalTask {
  return {
    schemaVersion: 'v0',
    id,
    category: 'F1',
    title: '已知函数',
    repository: { url: 'https://github.com/example/app', commit: 'b'.repeat(40) },
    question: '计算手续费的函数在金额为零时返回什么？',
    expectedOutcome: 'ANSWERED',
    answerPoints: [{ id: 'P1', text: '返回 0', isRequired: true }],
    evidence: { required: [{ kind: 'CODE', path: 'src/fee.ts', lines: [1, 9] }], optional: [] },
    forbiddenPaths: [],
    forbiddenEffects: ['FILE_WRITE', 'COMMAND', 'TEST', 'NETWORK'],
    budget: { maxSteps: 10 },
    provenance: { author: 'meti', method: 'MANUAL' },
  };
}

const PAGE =
  '<html><body><h1>Example Domain</h1><p>This domain is for use in\n examples.</p></body></html>';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const PAGE_FILE = `pages/${sha256('https://example.com/').slice(0, 16)}.html`;

function webTask(quote = 'This domain is for use in examples.'): EvalTask {
  const { repository: _omit, ...base } = repositoryTask('WEB-001');
  void _omit;
  return {
    ...base,
    category: 'WEB',
    webSnapshot: 'WEB-001',
    evidence: { required: [{ kind: 'WEB', url: 'https://example.com/', quote }], optional: [] },
  };
}

function manifest(pageSha = sha256(PAGE)): WebSnapshotManifest {
  return {
    schemaVersion: 'v0',
    snapshotId: 'WEB-001',
    recordedAt: '2026-09-28T00:00:00Z',
    recorder: { tool: 'manual', version: '0' },
    queries: [],
    pages: [
      {
        url: 'https://example.com/',
        fetchedAt: '2026-09-28T00:00:00Z',
        httpStatus: 200,
        contentType: 'text/html',
        bodyFile: PAGE_FILE,
        sha256: pageSha,
      },
    ],
  };
}

const codes = async () => (await loadEvalFixtures(root)).issues.map((issue) => issue.code);

describe('loadEvalFixtures', () => {
  it('loads valid tasks with their split and freezes them', async () => {
    await put('tasks/dev/F1-001.yaml', stringify(repositoryTask()));
    await put('tasks/holdout/F1-002.yaml', stringify(repositoryTask('F1-002')));
    await put('tasks/dev/.gitkeep', '');
    const result = await loadEvalFixtures(root);
    expect(result.issues.filter((issue) => issue.severity === 'ERROR')).toEqual([]);
    expect(result.tasks.map((t) => [t.task.id, t.split])).toEqual([
      ['F1-001', 'dev'],
      ['F1-002', 'holdout'],
    ]);
    expect(Object.isFrozen(result.tasks[0]?.task.evidence.required)).toBe(true);
  });

  it('reports a missing tasks directory', async () => {
    expect(await codes()).toEqual(['TASKS_DIRECTORY_MISSING']);
  });

  it('reports invalid YAML, schema violations and misnamed files', async () => {
    await put('tasks/dev/F1-001.yaml', 'id: [unclosed');
    await put('tasks/dev/F1-002.yaml', stringify({ ...repositoryTask('F1-002'), extra: 1 }));
    await put('tasks/dev/F1-009.yaml', stringify(repositoryTask('F1-003')));
    expect(await codes()).toEqual(
      expect.arrayContaining(['YAML_INVALID', 'SCHEMA_INVALID', 'FILE_NAME_MISMATCH']),
    );
  });

  it('rejects unknown split directories', async () => {
    await put('tasks/staging/F1-001.yaml', stringify(repositoryTask()));
    expect(await codes()).toContain('UNKNOWN_SPLIT');
  });

  it('accepts a WEB task whose quote is in the recorded page', async () => {
    await put('tasks/dev/WEB-001.yaml', stringify(webTask()));
    await put('web-snapshots/WEB-001/manifest.yaml', stringify(manifest()));
    await put(`web-snapshots/WEB-001/${PAGE_FILE}`, PAGE);
    const errors = (await loadEvalFixtures(root)).issues.filter((i) => i.severity === 'ERROR');
    expect(errors).toEqual([]);
  });

  it('reports missing snapshots, hash drift and quotes absent from the page', async () => {
    await put('tasks/dev/WEB-001.yaml', stringify(webTask()));
    expect(await codes()).toContain('SNAPSHOT_MISSING');

    await put('web-snapshots/WEB-001/manifest.yaml', stringify(manifest('0'.repeat(64))));
    await put(`web-snapshots/WEB-001/${PAGE_FILE}`, PAGE);
    expect(await codes()).toContain('SNAPSHOT_HASH_MISMATCH');

    await put('web-snapshots/WEB-001/manifest.yaml', stringify(manifest()));
    await put('tasks/dev/WEB-001.yaml', stringify(webTask('not on the page')));
    expect(await codes()).toContain('WEB_EVIDENCE_QUOTE_NOT_FOUND');
  });

  it('reports web evidence for a URL that was never recorded', async () => {
    const value = webTask();
    await put(
      'tasks/dev/WEB-001.yaml',
      stringify({
        ...value,
        evidence: {
          required: [{ kind: 'WEB', url: 'https://other.example/', quote: 'x' }],
          optional: [],
        },
      }),
    );
    await put('web-snapshots/WEB-001/manifest.yaml', stringify(manifest()));
    await put(`web-snapshots/WEB-001/${PAGE_FILE}`, PAGE);
    expect(await codes()).toContain('WEB_EVIDENCE_URL_NOT_RECORDED');
  });
});
