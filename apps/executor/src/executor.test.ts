import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactRef, BoundaryContext, UnitIntent } from '@multiagentos/contracts';
import { LocalReadExecutor } from './index.js';

const roots: string[] = [];
const context: BoundaryContext = {
  correlationId: 'cor_123456',
  tenantId: 'local',
  projectId: 'fixture',
};
const base = (root: string, kind: UnitIntent['executionKind'], input: unknown): UnitIntent => ({
  schemaVersion: 'v0',
  unitIntentId: 'uni_123456',
  owner: {
    workflowRunId: 'wfr_123456',
    taskRunId: 'tsk_123456',
    taskAttemptId: 'tat_123456',
    agentRunId: 'agr_123456',
    agentStepId: 'ags_123456',
  },
  missionScopeId: 'msc_123456',
  graphRevision: 0,
  executionKind: kind,
  input,
  outputContractRef: { kind: 'contract', id: 'kernel.unit.UnitResult', version: 'v0' },
  workspace: {
    workspaceId: 'wsp_123456',
    rootPath: root,
    repositoryRevision: 'fixture',
    isolation: 'FIXTURE',
  },
  timeoutMs: 1000,
  idempotencyKey: 'idem_123456',
  deadline: new Date(Date.now() + 60_000).toISOString(),
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('FR-EXE-003 M1 read-only executor', () => {
  it('reads a bounded workspace file and returns an evidence artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multiagentos-executor-'));
    roots.push(root);
    await writeFile(join(root, 'target.txt'), 'unchanged');
    let saved = '';
    const executor = new LocalReadExecutor({
      put(content): Promise<ArtifactRef> {
        saved = Buffer.from(content).toString();
        return Promise.resolve({
          artifactId: 'art_123456',
          mediaType: 'application/json',
          sha256: 'a'.repeat(64),
          size: content.byteLength,
        });
      },
    });
    const result = await executor.execute(base(root, 'FILE_READ', { path: 'target.txt' }), context);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.evidenceRefs).toHaveLength(1);
    expect(saved).toContain('unchanged');
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('unchanged');
  });

  it('rejects traversal, symlink escape and every M2 side-effect kind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multiagentos-executor-'));
    const outside = await mkdtemp(join(tmpdir(), 'multiagentos-outside-'));
    roots.push(root, outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'outside-link'), 'junction');
    const executor = new LocalReadExecutor({
      put(): Promise<ArtifactRef> {
        throw new Error('must not write artifact');
      },
    });
    await expect(
      executor.execute(base(root, 'FILE_READ', { path: '../secret' }), context),
    ).resolves.toMatchObject({ status: 'FAILED', error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    await expect(
      executor.execute(base(root, 'FILE_READ', { path: 'outside-link/secret.txt' }), context),
    ).resolves.toMatchObject({ status: 'FAILED', error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    for (const executionKind of ['FILE_WRITE', 'COMMAND', 'TEST'] as const) {
      await expect(executor.execute(base(root, executionKind, {}), context)).resolves.toMatchObject(
        {
          status: 'FAILED',
          error: { code: 'UNSUPPORTED_CAPABILITY', correlationId: context.correlationId },
        },
      );
    }
  });

  it('enforces output and deadline limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multiagentos-executor-'));
    roots.push(root);
    await writeFile(join(root, 'large.txt'), '0123456789');
    const executor = new LocalReadExecutor(
      {
        put(): Promise<ArtifactRef> {
          throw new Error('must not write artifact');
        },
      },
      { maxOutputBytes: 5 },
    );
    await expect(
      executor.execute(base(root, 'FILE_READ', { path: 'large.txt' }), context),
    ).resolves.toMatchObject({ error: { code: 'FILE_READ_OUTPUT_LIMIT' } });
    const expired = {
      ...base(root, 'FILE_READ', { path: 'large.txt' }),
      deadline: new Date(0).toISOString(),
    };
    await expect(executor.execute(expired, context)).resolves.toMatchObject({
      status: 'TIMED_OUT',
    });
  });
});
