import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createM1ProtocolRegistry,
  type ArtifactStorePort,
  type BoundaryContext,
  type CatalogPort,
  type GatewayForward,
  type PersistencePort,
} from '@multiagentos/contracts';
import { InProcessFabric, SCHEMA_IDS } from '@multiagentos/fabric';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_KERNEL_CONFIG } from './interfaces/index.js';
import { createKernelCore } from './kernel-core.js';

const roots: string[] = [];
const context: BoundaryContext = {
  tenantId: 'local',
  projectId: 'local',
  correlationId: 'cor_123456',
};

const catalog: CatalogPort = {
  getDefinition: () => Promise.reject(new Error('not used')),
  pinAgent: () => Promise.reject(new Error('not used')),
  capabilities: () => [],
};

const artifacts: ArtifactStorePort = {
  put: () => Promise.reject(new Error('not used')),
  get: () => Promise.reject(new Error('not used')),
  capabilities: () => [],
};

const persistence: PersistencePort = {
  repository: <T extends { id: string }>() => ({
    get: () => Promise.resolve<T | undefined>(undefined),
    put: () => Promise.resolve(),
  }),
  auditLog: () => ({ append: () => Promise.resolve() }),
  capabilities: () => [],
};

function createForward(repositoryPath: string): GatewayForward {
  return {
    caller: 'user-interaction',
    requestType: 'createRun',
    request: {
      requestId: 'req_create123',
      goal: 'analyze',
      repositoryPath,
    },
    workflowRunId: 'wfr_123456',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createKernelCore', () => {
  it('registers the Fabric entry, rejects invalid repositories and stops idempotently', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-core-'));
    roots.push(dataDir);
    const registry = createM1ProtocolRegistry();
    const fabric = new InProcessFabric(registry);
    const core = createKernelCore({
      fabric: fabric.client('kernel-core'),
      catalog,
      artifacts,
      persistence,
      registry,
      config: DEFAULT_KERNEL_CONFIG,
      dataDir,
      now: () => new Date('2026-10-21T00:00:00.000Z'),
    });
    await fabric.start();
    await core.start();

    expect((await core.health()).status).toBe('UP');
    await expect(
      fabric
        .client('gateway')
        .request(SCHEMA_IDS.gatewayForward, createForward(join(dataDir, 'missing')), context),
    ).resolves.toMatchObject({
      requestId: 'req_create123',
      outcome: 'REJECTED',
      reasonCode: 'REPOSITORY_INVALID',
    });
    await expect(
      fabric.client('workflow').request(SCHEMA_IDS.gatewayForward, createForward(dataDir), context),
    ).rejects.toThrow('invalid producer');

    await core.abortAllRuns({ faultId: 'fault-001', deadlineMs: 10 });
    await core.stop();
    await core.stop();
    expect((await core.health()).status).toBe('DOWN');
    await fabric.stop();
  });
});
