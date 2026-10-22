import type {
  ArtifactStorePort,
  BoundaryContext,
  CatalogPort,
  ExecutionFact,
  FabricPort,
  GatewayForward,
  HealthStatus,
  LifecyclePort,
  PersistencePort,
  ProtocolRegistry,
  SystemFaultReporter,
} from '@multiagentos/contracts';
import { newId } from '@multiagentos/contracts';
import {
  createInteractionInboxSender,
  createSupervisorPort,
  createWorkflowInboxSender,
  SCHEMA_IDS,
} from '@multiagentos/fabric';
import type { KernelConfig } from './interfaces/index.js';
import { InProcessProviderCapacity } from './scheduler/index.js';
import { createKernelRun, RunActor, RunEgress, runTimerConfig } from './run-actor/index.js';
import {
  RunRegistry,
  type CoreAuditEntry,
  type RunActorPort,
  type RunResponse,
  type RunState,
} from './core/index.js';

export interface KernelCoreDeps {
  /** The Fabric client whose producer is `kernel-core`. */
  readonly fabric: FabricPort;
  readonly catalog: CatalogPort;
  /** Used by Execution only. */
  readonly artifacts: ArtifactStorePort;
  /** Core takes the `kernel-core` namespace from it. */
  readonly persistence: PersistencePort;
  readonly registry: ProtocolRegistry;
  readonly config: KernelConfig;
  /** System data directory; `createRun` rejects a repository that contains or is inside it. */
  readonly dataDir: string;
  /**
   * Where the Kernel core escalates a fault it can no longer handle as a run fault, such as an
   * error thrown while a run is already converging. A plain function, not a Fabric message.
   */
  readonly reportSystemFault?: SystemFaultReporter;
  readonly now?: () => Date;
}

export interface AbortAllRunsRequest {
  /** Correlates the audit entries and the `failure.detail` of the runs with the fault. */
  readonly faultId: string;
  /** How long the caller waits; the Kernel core must not rely on being awaited longer. */
  readonly deadlineMs: number;
}

/**
 * `abortAllRuns` is the controlled maintenance entry of the composition root (Interaction 8):
 * it blocks new runs and puts `KERNEL_FAULT` on the control channel of every run that is not
 * CLOSED, so a RUNNING run converges as `FAILED(KERNEL_INTERNAL)`. It resolves once every run
 * is CLOSED and its Outbox is drained. It does not stop any module.
 */
export interface KernelCoreModule extends LifecyclePort {
  abortAllRuns(request: AbortAllRunsRequest): Promise<void>;
}

/**
 * Builds the Kernel core: Core, Execution, Monitor and Scheduler wired through the run actor.
 * Each component receives only the interfaces of `interfaces/` (Interaction 3.2).
 */
export function createKernelCore(deps: KernelCoreDeps): KernelCoreModule {
  const now = deps.now ?? (() => new Date());
  const capacity = new InProcessProviderCapacity();
  const holder: { registry?: RunRegistry } = {};

  // The Supervisor port used only for the final system stop after a normal shutdown drain.
  const systemContext = (workflowRunId?: string): BoundaryContext => ({
    tenantId: 'local',
    projectId: 'local',
    correlationId: newId('cor'),
    ...(workflowRunId === undefined ? {} : { workflowRunId }),
  });
  const supervisor = createSupervisorPort(deps.fabric, systemContext);

  const createActor = (run: RunState): RunActorPort => {
    const contextFor = (workflowRunId?: string): BoundaryContext => ({
      tenantId: 'local',
      projectId: 'local',
      correlationId: run.correlationId,
      ...(workflowRunId === undefined ? {} : { workflowRunId }),
    });
    const egress = new RunEgress({
      workflowRunId: run.workflowRunId,
      supervisor: createSupervisorPort(deps.fabric, contextFor),
      gatewayAdmission: (projection) =>
        deps.fabric.send(
          'gateway.admission',
          SCHEMA_IDS.admissionProjection,
          projection,
          contextFor(run.workflowRunId),
        ),
      workflowInbox: createWorkflowInboxSender(deps.fabric, contextFor),
      interactionInbox: createInteractionInboxSender(deps.fabric, contextFor),
      now,
    });
    const actorHolder: { actor?: RunActor } = {};
    const kernelRun = createKernelRun({
      run,
      catalog: deps.catalog,
      registry: deps.registry,
      artifacts: deps.artifacts,
      config: deps.config,
      audit: deps.persistence.auditLog<CoreAuditEntry>('kernel-core', run.workflowRunId),
      capacity,
      egress,
      onRunClosed: () => {
        actorHolder.actor?.markClosed();
        holder.registry?.markClosed(run.workflowRunId, run.closeReason ?? 'FAILED');
      },
      ...(deps.reportSystemFault === undefined
        ? {}
        : { reportSystemFault: deps.reportSystemFault }),
      now,
      onSettled: () => actorHolder.actor?.flushPending(),
    });
    const actor = new RunActor({
      processor: kernelRun.processor,
      egress,
      timers: runTimerConfig(deps.config),
      onFatal: (error) => {
        deps.reportSystemFault?.({
          source: 'kernel-core',
          phase: 'RUN',
          error,
          workflowRunId: run.workflowRunId,
        });
      },
    });
    actorHolder.actor = actor;
    return actor;
  };

  const registry = new RunRegistry({
    dataDir: deps.dataDir,
    createActor,
    auditFactory: (workflowRunId) =>
      deps.persistence.auditLog<CoreAuditEntry>('kernel-core', workflowRunId),
    onDrained: (requestId) => supervisor.shutdown({ requestId }),
    now,
  });
  holder.registry = registry;

  let started = false;

  return {
    manifest: {
      moduleId: 'kernel-core',
      version: '0.1.0',
      dependencies: ['fabric', 'artifact-store', 'persistence'],
    },
    start: () => {
      if (started) return Promise.resolve();
      deps.fabric.register<GatewayForward, RunResponse>(
        SCHEMA_IDS.gatewayForward,
        async (envelope) => {
          if (envelope.producer !== 'gateway')
            throw new Error('Kernel core request has an invalid producer');
          const context: BoundaryContext = {
            tenantId: envelope.tenantId,
            projectId: envelope.projectId,
            correlationId: envelope.correlationId,
            ...(envelope.causationId === undefined ? {} : { causationId: envelope.causationId }),
            ...(envelope.workflowRunId === undefined
              ? {}
              : { workflowRunId: envelope.workflowRunId }),
          };
          return registry.handleForward(envelope.payload, context);
        },
      );
      deps.fabric.subscribe<ExecutionFact>('kernel-core.execution-facts', async (envelope) => {
        if (envelope.producer !== 'supervisor')
          throw new Error('Kernel core execution fact has an invalid producer');
        await registry.report(envelope.payload);
      });
      started = true;
      return Promise.resolve();
    },
    stop: async () => {
      if (!started) return;
      started = false;
      await registry.stop();
    },
    health: (): Promise<HealthStatus> =>
      Promise.resolve({
        status: started ? 'UP' : 'DOWN',
        checkedAt: now().toISOString(),
        details: [
          registry.hasCreatedRun ? 'run created' : 'no run',
          registry.isClosing ? 'closing' : 'open',
        ],
      }),
    abortAllRuns: (request) => registry.abortAllRuns(request),
  };
}
