import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoundaryContext, UnitIntent } from '@multiagentos/contracts';
import { createM1Runtime } from './index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('AC-002 AC-003 M1 composition root', () => {
  it('runs UserInteraction -> Kernel -> Workflow and pins catalog definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multiagentos-runtime-'));
    roots.push(root);
    const runtime = createM1Runtime(join(root, '.multiagent'));
    await runtime.host.start();
    const submission = await runtime.interaction.run(
      'inspect this repository without changing it',
      {
        workspaceId: 'wsp_123456',
        rootPath: root,
        repositoryRevision: 'fixture',
        isolation: 'FIXTURE',
      },
    );
    expect(submission.projection.ok).toBe(true);
    if (submission.projection.ok) {
      expect(submission.projection.value.status).toBe('CREATED');
      expect(submission.projection.value.definitionVersions).toHaveLength(5);
      expect(
        submission.projection.value.definitionVersions.every((definition) =>
          /^[a-f0-9]{64}$/u.test(definition.digest),
        ),
      ).toBe(true);
      await expect(
        runtime.interaction.inspect(submission.projection.value.workflowRunId),
      ).resolves.toEqual(submission.projection);
    }
    expect(runtime.protocols.list().length).toBeGreaterThanOrEqual(15);
    await runtime.host.stop();
  });
  it('wires the M1 executor as a read-only unit boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multiagentos-runtime-read-'));
    roots.push(root);
    const runtime = createM1Runtime(join(root, '.multiagent'));
    const workspace = {
      workspaceId: 'wsp_123456',
      rootPath: root,
      repositoryRevision: 'fixture',
      isolation: 'FIXTURE' as const,
    };
    const context: BoundaryContext = {
      correlationId: 'cor_123456',
      tenantId: 'local',
      projectId: 'fixture',
    };
    const base: UnitIntent = {
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
      executionKind: 'FILE_READ',
      input: { path: 'missing.txt' },
      outputContractRef: { kind: 'contract', id: 'file.ReadResult', version: 'v0' },
      workspace,
      timeoutMs: 1_000,
      idempotencyKey: 'read-123456',
      deadline: new Date(Date.now() + 5_000).toISOString(),
    };
    const read = await runtime.kernel.execute(base, context);
    expect(read.status).toBe('FAILED');
    expect(read.error?.code).toBe('FILE_READ_FAILED');
    const write = await runtime.kernel.execute(
      { ...base, unitIntentId: 'uni_654321', executionKind: 'FILE_WRITE' },
      context,
    );
    expect(write.error?.code).toBe('UNSUPPORTED_CAPABILITY');
  });
});
