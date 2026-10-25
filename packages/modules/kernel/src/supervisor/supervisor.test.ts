import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createM1ProtocolRegistry,
  type BoundaryContext,
  type ExecutorRegistry,
} from '@multiagentos/contracts';
import { InProcessFabric, SCHEMA_IDS } from '@multiagentos/fabric';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_KERNEL_CONFIG } from '../interfaces/index.js';
import { createSupervisor, type ModuleHostControl } from './index.js';

const context: BoundaryContext = {
  tenantId: 'local',
  projectId: 'local',
  correlationId: 'cor_123456',
};
const shutdown = { requestId: 'req_123456' };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const kills: string[] = [];

async function fixture(hostFactory: (fabric: InProcessFabric) => ModuleHostControl) {
  const dataDir = await mkdtemp(join(tmpdir(), 'supervisor-'));
  roots.push(dataDir);
  const fabric = new InProcessFabric(createM1ProtocolRegistry());
  const host = hostFactory(fabric);
  const supervisor = createSupervisor({
    fabric: fabric.client('supervisor'),
    executors: {} as ExecutorRegistry,
    credentials: { apiKeyFor: () => undefined },
    moduleHost: host,
    config: DEFAULT_KERNEL_CONFIG,
    dataDir,
    subprocess: {
      run: () => Promise.resolve({ exitCode: null, signal: null, stdout: '', truncated: false }),
      killAll: () => void kills.push('killAll'),
    },
  });
  return { dataDir, fabric, supervisor };
}

describe('Supervisor bootstrap', () => {
  it('cleans only tmp, registers after Fabric, and stops after replying to shutdown', async () => {
    const log: string[] = [];
    const { dataDir, fabric, supervisor } = await fixture((instance) => ({
      start: async (afterStart) => {
        log.push('fabric start');
        await instance.start();
        await afterStart?.('fabric');
        log.push('core start');
      },
      stop: async () => {
        log.push('core stop');
        await instance.stop();
        log.push('fabric stop');
      },
    }));
    await writeFile(join(dataDir, 'keep'), 'retained');
    await rm(join(dataDir, 'tmp'), { recursive: true, force: true });
    await mkdir(join(dataDir, 'tmp'));
    await writeFile(join(dataDir, 'tmp', 'stale'), 'old');
    await supervisor.start();
    await expect(readFile(join(dataDir, 'keep'), 'utf8')).resolves.toBe('retained');
    await expect(readFile(join(dataDir, 'tmp', 'stale'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(log).toEqual(['fabric start', 'core start']);
    await expect(
      fabric.client('gateway').request(SCHEMA_IDS.supervisorShutdown, shutdown, context),
    ).rejects.toThrow('invalid producer');
    await fabric.client('kernel-core').request(SCHEMA_IDS.supervisorShutdown, shutdown, context);
    await supervisor.whenStopped();
    expect(log).toEqual(['fabric start', 'core start', 'core stop', 'fabric stop']);
    // Residual child processes are ended after the modules, through the injected runner.
    expect(kills).toEqual(['killAll']);
    await expect(access(join(dataDir, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await supervisor.health()).status).toBe('DOWN');
  });

  it('returns shutdown before module stop completes', async () => {
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
    const { fabric, supervisor } = await fixture((instance) => ({
      start: async (afterStart) => {
        await instance.start();
        await afterStart?.('fabric');
      },
      stop: async () => {
        await stopGate;
        await instance.stop();
      },
    }));
    await supervisor.start();

    const response = fabric
      .client('kernel-core')
      .request(SCHEMA_IDS.supervisorShutdown, shutdown, context);
    await expect(response).resolves.toBeUndefined();
    releaseStop?.();
    await supervisor.whenStopped();
  });

  it('does not accept requests during boot and reuses guarded registration after rollback', async () => {
    let attempts = 0;
    let release: (() => void) | undefined;
    let arrived: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fabric, supervisor } = await fixture((instance) => ({
      start: async (afterStart) => {
        attempts += 1;
        await instance.start();
        await afterStart?.('fabric');
        if (attempts === 1) {
          arrived?.();
          await gate;
          await instance.stop();
          throw new Error('core failed');
        }
      },
      stop: () => instance.stop(),
    }));
    const first = supervisor.start();
    await reached;
    await expect(
      fabric.client('kernel-core').request(
        SCHEMA_IDS.execute,
        {
          workflowRunId: 'wfr_123456',
          unitAttemptId: 'una_123456',
          executionId: 'exe_123456',
          runEpoch: 1,
          executionKind: 'REPOSITORY_ORIENT',
          input: { objective: 'analyze', tokenBudget: 4000 },
          scope: { kind: 'REPOSITORY', repositoryRoot: '/repo', exclusions: [] },
          limits: {
            deadline: '2026-10-19T01:00:00.000Z',
            maxOutputBytes: 1024,
            maxFiles: 10,
          },
        },
        context,
      ),
    ).rejects.toThrow('not ready');
    await expect(
      fabric.client('kernel-core').request(SCHEMA_IDS.supervisorShutdown, shutdown, context),
    ).rejects.toThrow('not ready');
    release?.();
    await expect(first).rejects.toThrow('core failed');
    await supervisor.start();
    await fabric.client('kernel-core').request(SCHEMA_IDS.supervisorShutdown, shutdown, context);
    await supervisor.whenStopped();
    expect(attempts).toBe(2);
  });
});
