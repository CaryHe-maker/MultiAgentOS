import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createM1ProtocolRegistry,
  sha256Hex,
  type AdmissionProjection,
  type ArtifactRef,
  type ArtifactStorePort,
  type BoundaryContext,
  type CatalogPort,
  type GatewayForward,
  type InteractionInboxEvent,
  type PersistencePort,
  type WorkflowInboxEvent,
} from '@multiagentos/contracts';
import { InProcessFabric, SCHEMA_IDS } from '@multiagentos/fabric';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KERNEL_CONFIG } from './interfaces/index.js';
import { createKernelCore, type KernelCoreModule } from './kernel-core.js';

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

class FakeArtifactStore implements ArtifactStorePort {
  readonly #objects = new Map<string, Uint8Array>();

  public put(workflowRunId: string, content: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    const digest = sha256Hex(content);
    this.#objects.set(`${workflowRunId}:${digest}`, content);
    return Promise.resolve({
      artifactId: `art_${digest}`,
      mediaType,
      sha256: digest,
      size: content.byteLength,
    });
  }

  public get(workflowRunId: string, ref: ArtifactRef): Promise<Uint8Array> {
    const content = this.#objects.get(`${workflowRunId}:${ref.sha256}`);
    if (content === undefined) return Promise.reject(new Error('artifact is missing'));
    return Promise.resolve(content);
  }

  public capabilities(): readonly [] {
    return [];
  }
}

const persistence: PersistencePort = {
  repository: <T extends { id: string }>() => ({
    get: () => Promise.resolve<T | undefined>(undefined),
    put: () => Promise.resolve(),
  }),
  auditLog: () => ({ append: () => Promise.resolve() }),
  capabilities: () => [],
};

interface Fixture {
  readonly core: KernelCoreModule;
  readonly fabric: InProcessFabric;
  readonly workflow: WorkflowInboxEvent[];
  readonly interaction: InteractionInboxEvent[];
  readonly admissions: AdmissionProjection[];
  readonly supervisor: string[];
  readonly createRun: (requestId: string) => Promise<unknown>;
}

async function fixture(runTimeoutMs = DEFAULT_KERNEL_CONFIG.runTimeoutMs): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), 'stage4-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'stage4-repo-'));
  roots.push(dataDir, repository);
  const registry = createM1ProtocolRegistry();
  const fabric = new InProcessFabric(registry);
  const workflow: WorkflowInboxEvent[] = [];
  const interaction: InteractionInboxEvent[] = [];
  const admissions: AdmissionProjection[] = [];
  const supervisor: string[] = [];
  const supervisorClient = fabric.client('supervisor');
  supervisorClient.register(SCHEMA_IDS.execute, () => Promise.resolve());
  supervisorClient.register(SCHEMA_IDS.cancelRunExecutions, () => Promise.resolve());
  supervisorClient.register(SCHEMA_IDS.supervisorShutdown, () => {
    supervisor.push('shutdown');
    return Promise.resolve();
  });
  fabric.client('workflow').subscribe('inbox.workflow', (envelope) => {
    workflow.push(envelope.payload as WorkflowInboxEvent);
    return Promise.resolve();
  });
  fabric.client('user-interaction').subscribe('inbox.user-interaction', (envelope) => {
    interaction.push(envelope.payload as InteractionInboxEvent);
    return Promise.resolve();
  });
  fabric.client('gateway').subscribe('gateway.admission', (envelope) => {
    admissions.push(envelope.payload as AdmissionProjection);
    return Promise.resolve();
  });
  const core = createKernelCore({
    fabric: fabric.client('kernel-core'),
    catalog,
    artifacts: new FakeArtifactStore(),
    persistence,
    registry,
    config: { ...DEFAULT_KERNEL_CONFIG, runTimeoutMs },
    dataDir,
    now: () => new Date(),
  });
  await fabric.start();
  await core.start();

  return {
    core,
    fabric,
    workflow,
    interaction,
    admissions,
    supervisor,
    createRun: (requestId) =>
      fabric.client('gateway').request(
        SCHEMA_IDS.gatewayForward,
        {
          caller: 'user-interaction',
          requestType: 'createRun',
          request: { requestId, goal: 'analyze', repositoryPath: repository },
          workflowRunId: 'wfr_123456',
        } satisfies GatewayForward,
        context,
      ),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Stage4 Kernel core integration', () => {
  it('closes a run on RUN_TIMEOUT through the real actor and egress', async () => {
    const test = await fixture(10);
    await test.createRun('req_timeout1');
    await vi.waitFor(
      () => expect(test.workflow.some((event) => event.event.type === 'RunClosed')).toBe(true),
      { timeout: 1000 },
    );
    expect(test.workflow.find((event) => event.event.type === 'RunClosed')?.event).toMatchObject({
      type: 'RunClosed',
      closeReason: 'RUN_TIMEOUT',
    });
    await test.core.stop();
    await test.fabric.stop();
  });

  it('closes a run on cancel through the GatewayForward entry', async () => {
    const test = await fixture();
    await test.createRun('req_cancel1');
    await vi.waitFor(() =>
      expect(test.workflow.some((event) => event.event.type === 'RunStart')).toBe(true),
    );
    const cancel: GatewayForward = {
      caller: 'user-interaction',
      requestType: 'cancelRun',
      request: { requestId: 'req_cancel2', workflowRunId: 'wfr_123456' },
    };
    await test.fabric.client('gateway').request(SCHEMA_IDS.gatewayForward, cancel, context);
    await vi.waitFor(() =>
      expect(test.workflow.find((event) => event.event.type === 'RunClosed')?.event).toMatchObject({
        type: 'RunClosed',
        closeReason: 'CANCELLED',
      }),
    );
    await test.core.stop();
    await test.fabric.stop();
  });

  it('drains the run and asks Supervisor to stop on shutdown', async () => {
    const test = await fixture();
    await test.createRun('req_shutdown1');
    await vi.waitFor(() =>
      expect(test.workflow.some((event) => event.event.type === 'RunStart')).toBe(true),
    );
    const shutdown: GatewayForward = {
      caller: 'user-interaction',
      requestType: 'shutdown',
      request: { requestId: 'req_shutdown2' },
    };
    await test.fabric.client('gateway').request(SCHEMA_IDS.gatewayForward, shutdown, context);
    await vi.waitFor(() => expect(test.supervisor).toEqual(['shutdown']));
    expect(test.workflow.find((event) => event.event.type === 'RunClosed')?.event).toMatchObject({
      type: 'RunClosed',
      closeReason: 'CANCELLED',
    });
    await test.core.stop();
    await test.fabric.stop();
  });

  it('aborts the run through abortAllRuns with KERNEL_INTERNAL', async () => {
    const test = await fixture();
    await test.createRun('req_abort1');
    await vi.waitFor(() =>
      expect(test.workflow.some((event) => event.event.type === 'RunStart')).toBe(true),
    );
    await test.core.abortAllRuns({ faultId: 'fault-001', deadlineMs: 1000 });
    const closed = test.workflow.find((event) => event.event.type === 'RunClosed')?.event;
    expect(closed).toMatchObject({
      type: 'RunClosed',
      closeReason: 'FAILED',
      failure: { code: 'KERNEL_INTERNAL', source: 'KERNEL' },
    });
    expect(test.workflow.at(-1)?.event.type).toBe('RunClosed');
    await test.core.stop();
    await test.fabric.stop();
  });
});
