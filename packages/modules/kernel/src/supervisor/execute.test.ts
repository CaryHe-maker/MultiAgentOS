import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createM1ProtocolRegistry,
  MEDIA_TYPES,
  type BoundaryContext,
  type Envelope,
  type ExecutionFact,
  type ExecutionRequest,
  type Executor,
  type ExecutorKind,
  type ExecutorOutcome,
  type ExecutorRegistry,
} from '@multiagentos/contracts';
import { InProcessFabric, SCHEMA_IDS } from '@multiagentos/fabric';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KERNEL_CONFIG } from '../interfaces/index.js';
import { createSupervisor, type ModuleHostControl, type SupervisorModule } from './index.js';

type OrientRequest = Extract<ExecutionRequest, { executionKind: 'REPOSITORY_ORIENT' }>;

const SHA = 'a'.repeat(64);
const completed: ExecutorOutcome = {
  outcome: 'COMPLETED',
  result: {
    output: {
      snapshotId: `snp_${SHA}`,
      fileCount: 0,
      totalBytes: 0,
      summary: 'empty',
      tokenCount: 0,
      truncated: false,
    },
    artifact: { mediaType: MEDIA_TYPES.contextPack, text: '{}' },
  },
};

const roots: string[] = [];
const supervisors: SupervisorModule[] = [];
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.stop().catch(() => undefined);
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function request(executionId = 'exe_123456'): OrientRequest {
  return {
    workflowRunId: 'wfr_123456',
    unitAttemptId: 'una_123456',
    executionId,
    runEpoch: 1,
    executionKind: 'REPOSITORY_ORIENT',
    input: { objective: 'analyze', tokenBudget: 4000 },
    scope: { kind: 'REPOSITORY', repositoryRoot: '/repo', exclusions: [] },
    limits: {
      deadline: '2026-10-19T01:00:00.000Z',
      maxOutputBytes: 1024,
      maxFiles: 10,
    },
  };
}

function executor<K extends ExecutorKind>(kind: K, execute: Executor<K>['execute']): Executor<K> {
  return { executionKind: kind, execute };
}

function registry(): ExecutorRegistry {
  const unused = <K extends ExecutorKind>(kind: K): Executor<K> =>
    executor(kind, () => Promise.resolve({ outcome: 'REJECTED', reasonCode: 'OUT_OF_SCOPE' }));
  return {
    REPOSITORY_ORIENT: executor('REPOSITORY_ORIENT', () => Promise.resolve(completed)),
    REPOSITORY_SEARCH: unused('REPOSITORY_SEARCH'),
    FILE_READ: unused('FILE_READ'),
    CONTEXT_ASSEMBLE: unused('CONTEXT_ASSEMBLE'),
    MODEL: unused('MODEL'),
  };
}

function abortingRegistry(): ExecutorRegistry {
  const base = registry();
  return {
    ...base,
    REPOSITORY_ORIENT: executor('REPOSITORY_ORIENT', (_input, environment) => {
      if (environment.signal.aborted) return Promise.resolve(completed);
      return new Promise((resolve) => {
        environment.signal.addEventListener('abort', () => resolve(completed), { once: true });
      });
    }),
  };
}

const context: BoundaryContext = {
  correlationId: 'cor_123456',
  tenantId: 'local',
  projectId: 'local',
  workflowRunId: 'wfr_123456',
};

async function fixture(executors: ExecutorRegistry = registry()): Promise<{
  readonly fabric: InProcessFabric;
  readonly facts: Envelope<ExecutionFact>[];
  readonly supervisor: SupervisorModule;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'supervisor-execute-'));
  roots.push(dataDir);
  const fabric = new InProcessFabric(createM1ProtocolRegistry());
  const kernelCore = fabric.client('kernel-core');
  const facts: Envelope<ExecutionFact>[] = [];
  kernelCore.subscribe<ExecutionFact>('kernel-core.execution-facts', (envelope) => {
    facts.push(envelope);
    return Promise.resolve();
  });
  const moduleHost: ModuleHostControl = {
    start: async (afterStart) => {
      await fabric.start();
      await afterStart?.('fabric');
    },
    stop: () => fabric.stop(),
  };
  const supervisor = createSupervisor({
    fabric: fabric.client('supervisor'),
    executors,
    credentials: { apiKeyFor: () => undefined },
    moduleHost,
    config: DEFAULT_KERNEL_CONFIG,
    dataDir,
    subprocess: {
      run: () => Promise.resolve({ exitCode: null, signal: null, stdout: '', truncated: false }),
      killAll: () => undefined,
    },
    now: () => new Date('2026-10-19T00:00:00.000Z'),
  });
  supervisors.push(supervisor);
  await supervisor.start();
  return { fabric, facts, supervisor };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Supervisor execute over Fabric', () => {
  it('accepts execute and delivers one correlated fact', async () => {
    const { fabric, facts } = await fixture();
    const kernelCore = fabric.client('kernel-core');

    await kernelCore.request(SCHEMA_IDS.execute, request(), context);
    await vi.waitFor(() => expect(facts).toHaveLength(1));

    const envelope = facts[0] as Envelope<ExecutionFact>;
    expect(envelope.correlationId).toBe('cor_123456');
    expect(envelope.payload).toMatchObject({
      outcome: 'COMPLETED',
      executionKind: 'REPOSITORY_ORIENT',
      workflowRunId: 'wfr_123456',
      unitAttemptId: 'una_123456',
      executionId: 'exe_123456',
    });
  });

  it('rejects execute from a producer other than kernel-core', async () => {
    const { fabric } = await fixture();
    await expect(
      fabric.client('gateway').request(SCHEMA_IDS.execute, request(), context),
    ).rejects.toThrow('invalid producer');
  });

  it('cancels an execution over Fabric', async () => {
    const { fabric, facts } = await fixture(abortingRegistry());
    const kernelCore = fabric.client('kernel-core');

    await kernelCore.request(SCHEMA_IDS.execute, request(), context);
    await kernelCore.request(
      SCHEMA_IDS.cancelRunExecutions,
      { workflowRunId: 'wfr_123456', runEpoch: 2 },
      context,
    );
    await vi.waitFor(() => expect(facts).toHaveLength(1));

    const envelope = facts[0] as Envelope<ExecutionFact>;
    expect(envelope.payload).toMatchObject({
      outcome: 'TERMINATED',
      reasonCode: 'EXECUTION_CANCELLED',
      executionId: 'exe_123456',
    });
  });

  it('reports STOP_UNCONFIRMED during stop before Fabric closes', async () => {
    const { fabric, facts, supervisor } = await fixture(abortingRegistry());
    const kernelCore = fabric.client('kernel-core');

    await kernelCore.request(SCHEMA_IDS.execute, request(), context);
    await delay(10);
    await supervisor.stop();
    await vi.waitFor(() => expect(facts).toHaveLength(1));

    expect((facts[0] as Envelope<ExecutionFact>).payload).toMatchObject({
      outcome: 'STOP_UNCONFIRMED',
      reasonCode: 'EXECUTION_CANCELLED',
      executionId: 'exe_123456',
    });
  });
});
