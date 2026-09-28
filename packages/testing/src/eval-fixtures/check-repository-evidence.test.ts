import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GitCliRepositoryReader,
  MAX_EVIDENCE_FILE_BYTES,
  checkRepositoryEvidence,
} from './check-repository-evidence.js';
import type { LoadedEvalTask } from './eval-task-rules.js';
import type { CodeEvidence, EvalTask } from './eval-task-schema.js';

const run = promisify(execFile);
const URL = 'https://github.com/example/fixture-repo';
let workspace: string;
let source: string;
let firstCommit: string;
let secondCommit: string;
let reader: GitCliRepositoryReader;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run(
    'git',
    ['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', ...args],
    {
      cwd: source,
    },
  );
  return stdout.trim();
}

async function put(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(source, path)), { recursive: true });
  await writeFile(join(source, path), content);
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'eval-repo-'));
  source = join(workspace, 'source');
  await mkdir(source);
  await git('init', '--quiet');
  await put('src/fee.ts', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  await put('assets/logo.bin', new Uint8Array([1, 0, 2, 3]));
  await put('data/huge.json', 'x'.repeat(MAX_EVIDENCE_FILE_BYTES + 1));
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  firstCommit = await git('rev-parse', 'HEAD');
  await put('src/later.ts', 'export {};\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'second');
  secondCommit = await git('rev-parse', 'HEAD');
  reader = new GitCliRepositoryReader({
    cacheDirectory: join(workspace, 'cache'),
    remoteOverrides: new Map([[URL, source]]),
  });
}, 30_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function loaded(evidence: CodeEvidence[], commit = firstCommit, extra: Partial<EvalTask> = {}) {
  const task: EvalTask = {
    schemaVersion: 'v0',
    id: 'F1-001',
    category: 'F1',
    title: 'fee',
    repository: { url: URL, commit },
    question: '手续费怎么算？',
    expectedOutcome: 'ANSWERED',
    answerPoints: [{ id: 'P1', text: 'x', isRequired: true }],
    evidence: { required: evidence, optional: [] },
    forbiddenPaths: [],
    forbiddenEffects: ['FILE_WRITE', 'COMMAND', 'TEST', 'NETWORK'],
    budget: { maxSteps: 5 },
    provenance: { author: 'meti', method: 'MANUAL' },
    ...extra,
  };
  const result: LoadedEvalTask = { task, split: 'dev', origin: 'tasks/dev/F1-001.yaml' };
  return [result];
}

const code = (path: string, lines: [number, number]): CodeEvidence => ({
  kind: 'CODE',
  path,
  lines,
});
const codes = async (tasks: LoadedEvalTask[]) =>
  (await checkRepositoryEvidence(tasks, reader)).map((issue) => issue.code);

describe('checkRepositoryEvidence', () => {
  it('accepts evidence that exists at the pinned commit', async () => {
    expect(await codes(loaded([code('src/fee.ts', [1, 30])]))).toEqual([]);
  });

  it('reports a commit the repository does not have', async () => {
    expect(await codes(loaded([code('src/fee.ts', [1, 2])], 'f'.repeat(40)))).toEqual([
      'COMMIT_NOT_FOUND',
    ]);
  });

  it('reads files at the pinned commit, not at the latest one', async () => {
    expect(await codes(loaded([code('src/later.ts', [1, 1])]))).toEqual(['PATH_NOT_FOUND']);
    expect(await codes(loaded([code('src/later.ts', [1, 1])], secondCommit))).toEqual([]);
  });

  it('accepts an anchor that appears inside the line range', async () => {
    const evidence = { ...code('src/fee.ts', [25, 30]), anchor: 'line 27' };
    expect(await codes(loaded([evidence]))).toEqual([]);
  });

  it('reports an anchor outside the line range and where it really is', async () => {
    const evidence = { ...code('src/fee.ts', [1, 5]), anchor: 'line 9' };
    const issues = await checkRepositoryEvidence(loaded([evidence]), reader);
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'ANCHOR_NOT_IN_RANGE',
        message: expect.stringContaining('found at line 9') as unknown,
      }),
    ]);
  });

  it('reports line ranges past the end of the file', async () => {
    expect(await codes(loaded([code('src/fee.ts', [25, 31])]))).toEqual(['LINE_OUT_OF_RANGE']);
  });

  it('reports binary and oversized evidence files', async () => {
    const result = await codes(
      loaded([code('assets/logo.bin', [1, 1]), code('data/huge.json', [1, 1])]),
    );
    expect(result).toEqual(['BINARY_FILE', 'FILE_TOO_LARGE']);
  });

  it('checks retrieval probe paths and the GIT_HISTORY source commit', async () => {
    const tasks = loaded([code('src/fee.ts', [1, 2])], firstCommit, {
      retrievalProbes: [{ query: 'fee', mode: 'AUTO', k: 3, expectPaths: ['src/missing.ts'] }],
      provenance: { author: 'meti', method: 'GIT_HISTORY', sourceCommit: 'e'.repeat(40) },
    });
    expect(await codes(tasks)).toEqual(['PATH_NOT_FOUND', 'SOURCE_COMMIT_NOT_FOUND']);
  });

  it('reports a repository that cannot be cloned', async () => {
    const offline = new GitCliRepositoryReader({
      cacheDirectory: join(workspace, 'cache-offline'),
      remoteOverrides: new Map([[URL, join(workspace, 'does-not-exist')]]),
    });
    const issues = await checkRepositoryEvidence(loaded([code('src/fee.ts', [1, 2])]), offline);
    expect(issues.map((issue) => issue.code)).toEqual(['REPOSITORY_UNAVAILABLE']);
  });
});
