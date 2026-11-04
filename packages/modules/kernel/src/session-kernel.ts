import {
  MEDIA_TYPES,
  RunSummarySchema,
  assertValid,
  canonicalJson,
  newId,
  validate,
  type AdmissionProjection,
  type AppendLogPort,
  type ArtifactOwnerLine,
  type ArtifactStorePort,
  type BoundaryContext,
  type CloseReason,
  type ExecutionFact,
  type FabricPort,
  type GatewayForward,
  type HealthStatus,
  type KernelConfig,
  type LifecyclePort,
  type ProtocolRegistry,
  type RegisterAgentRunRequest,
  type SessionPersistencePort,
  type SessionProjection,
  type SystemFaultReporter,
  type UnitDefinition,
} from '@multiagentos/contracts';
import {
  INTERACTION_SYSCALLS,
  SCHEMA_IDS,
  WORKFLOW_SYSCALLS,
  createInteractionEventSender,
  createSupervisorPort,
  createWorkflowEventSender,
} from '@multiagentos/fabric';
import { RunLedgers, type AgentBudget } from './monitor/index.js';
import { InProcessProviderCapacity, Scheduler } from './scheduler/index.js';
import type { ExecutionConfig } from './session/attempt-request.js';
import { RunExecution, type RunExecutionDeps } from './session/run-execution.js';
import { RunWork, type PinResult, type RunHost } from './session/run-work.js';
import { SessionActor } from './session/session-actor.js';
import { SessionArtifacts } from './session/session-artifacts.js';
import { SessionCore, type CoreResponse } from './session/session-core.js';
import {
  SessionGateway,
  type Caller,
  type RequestOrigin,
  type RequestType,
} from './session/session-gateway.js';
import { SessionManager } from './session/session-manager.js';
import { KernelOutbox } from './session/session-outbox.js';
import { ArtifactSweep } from './session/artifact-sweep.js';
import { SessionRefs, TrustRecords } from './session/session-refs.js';

export interface SessionKernelDeps {
  /** The Fabric client whose producer is `kernel-core`. */
  readonly fabric: FabricPort;
  readonly artifacts: ArtifactStorePort;
  /** Core and Execution take their own namespaces from it. */
  readonly persistence: SessionPersistencePort;
  /** Validates Unit inputs against their contracts. */
  readonly registry: ProtocolRegistry;
  /** The definitions one AgentRun runs with (Interface/Definitions 3). */
  readonly pinAgent: (request: RegisterAgentRunRequest) => Promise<PinResult>;
  /** The per-call budget the run and Turn limits are checked against (Kernel/Monitor 6). */
  readonly mainBudget: AgentBudget;
  readonly config: KernelConfig;
  /** This process's repository: a realpath. */
  readonly repositoryRoot: string;
  readonly preset: 'standard' | 'readonly';
  /** `readProjectFile` reads through the same guard as `file-read`. */
  readonly readRepositoryFile: RunExecutionDeps['readRepositoryFile'];
  readonly reportSystemFault?: SystemFaultReporter;
  /** Local diagnostics of what does not stop the system; the composition root gives stderr. */
  readonly diagnostic?: (line: string) => void;
  readonly now?: () => Date;
}

export interface SessionKernelCoreModule extends LifecyclePort {
  /**
   * The composition root's fault entry: refuses new Sessions and closes the open one, whose run
   * converges with SHUTDOWN. It resolves once the Session closed and the Outbox drained.
   */
  abortAllRuns(request: { readonly faultId: string; readonly deadlineMs: number }): Promise<void>;
}

const LOCAL = { tenantId: 'local', projectId: 'local' } as const;

const executionConfigOf = (config: KernelConfig): ExecutionConfig => ({
  executionLimits: config.executionLimits,
  retryBackoffBaseMs: config.retryBackoffBaseMs,
  retryAfterMaxMs: config.retryAfterMaxMs,
  maxReportBytes: config.maxReportBytes,
  maxSnapshotFiles: config.maxSnapshotFiles,
  orientBudget: config.budget.orientBudget,
  searchBudget: config.budget.searchBudget,
  cancelGraceMs: config.cancelGraceMs,
  convergenceMarginMs: config.convergenceMarginMs,
});

const schedule = (delayMs: number, due: () => void): (() => void) => {
  const timer = setTimeout(due, delayMs);
  return () => clearTimeout(timer);
};

/**
 * The Kernel core of M2 (Kernel/Interaction): Session management, one Session actor at a time,
 * and per run the Unit path (RunWork) with its Execution. Gateway reaches it with
 * `GatewayForward`, the Supervisor with execution facts; it pushes admission and Session state
 * to Gateway and sends events to Workflow and UserInteraction.
 */
export function createSessionKernelCore(deps: SessionKernelDeps): SessionKernelCoreModule {
  const now = deps.now ?? (() => new Date());
  const { fabric, persistence, config, repositoryRoot } = deps;
  const capacity = new InProcessProviderCapacity();
  const executionConfig = executionConfigOf(config);
  const correlations = new Map<string, string>();
  const correlationOf = (event: object): string =>
    ('sessionId' in event ? correlations.get(event.sessionId as string) : undefined) ??
    newId('cor');
  const contextOf = (ids: {
    readonly sessionId?: string;
    readonly workflowRunId?: string;
  }): BoundaryContext => ({
    ...LOCAL,
    correlationId: ids.sessionId === undefined ? newId('cor') : correlationOf(ids),
    ...(ids.sessionId === undefined ? {} : { sessionId: ids.sessionId }),
    ...(ids.workflowRunId === undefined ? {} : { workflowRunId: ids.workflowRunId }),
  });
  const fault = (error: unknown): void => {
    deps.reportSystemFault?.({ source: 'kernel-core', phase: 'RUN', error });
  };

  const supervisor = createSupervisorPort(fabric, contextOf);
  const toWorkflow = createWorkflowEventSender(fabric, correlationOf);
  const toInteraction = createInteractionEventSender(fabric, correlationOf);
  const outbox = new KernelOutbox({ toWorkflow, toInteraction }, fault, now);
  const refs = new SessionRefs(
    persistence.appendLog('kernel-core', { scope: 'SYSTEM', file: 'session-refs' }),
    repositoryRoot,
    now,
  );
  const trust = new TrustRecords(
    persistence.appendLog('kernel-core', { scope: 'SYSTEM', file: 'trusted-instructions' }),
    now,
  );
  const sessionArtifacts = new Map<string, SessionArtifacts>();
  const executions = new Map<string, RunExecution>();

  const sendSession = (sessionId: string, state: SessionProjection['state']) =>
    fabric
      .send<SessionProjection>(
        'gateway.session',
        SCHEMA_IDS.sessionProjection,
        { sessionId, state },
        contextOf({ sessionId }),
      )
      .catch(fault);
  const sendAdmission = (
    sessionId: string,
    workflowRunId: string,
    runState: 'RUNNING' | 'CONVERGING' | 'CLOSED',
    closeReason?: CloseReason,
  ): void => {
    const projection = (
      runState === 'RUNNING'
        ? { workflowRunId, sessionId, runState }
        : { workflowRunId, sessionId, runState, closeReason }
    ) as AdmissionProjection;
    void fabric
      .send('gateway.admission', SCHEMA_IDS.admissionProjection, projection, {
        ...contextOf({ sessionId, workflowRunId }),
      })
      .catch(fault);
  };

  const inputIsValid = (unit: UnitDefinition, input: unknown): boolean =>
    validate(deps.registry.resolveContract(unit.inputContract), input).ok;

  const openRunWork = (
    sessionId: string,
    host: RunHost,
    artifacts: SessionArtifacts,
    audit: (entry: object) => void,
  ): RunWork => {
    const holder: { work?: RunWork } = {};
    const execution = new RunExecution({
      sessionId,
      workflowRunId: host.workflowRunId,
      config: executionConfig,
      artifacts,
      dispatch: (request) => supervisor.execute(request),
      cancelRun: (request) => supervisor.cancelRun(request),
      retrying: (retry) => holder.work?.retrying(retry),
      readRepositoryFile: deps.readRepositoryFile,
      enqueue: (work) => {
        host.enqueue(work);
      },
      schedule,
      now,
    });
    executions.set(host.workflowRunId, execution);
    const work = new RunWork({
      host,
      ledgers: new RunLedgers(
        {
          runTokenLimit: config.budget.runTokenLimit,
          turnTokenLimit: config.budget.turnTokenLimit,
        },
        deps.mainBudget,
      ),
      scheduler: new Scheduler(capacity),
      provider: config.provider,
      technicalRetryLimit: config.technicalRetryLimit,
      repositoryRoot,
      repositoryExclusions: config.repositoryExclusions,
      pinAgent: deps.pinAgent,
      inputIsValid,
      preset: deps.preset,
      readProjectFile: (path, scope) => execution.readProjectFile(path, scope),
      isTrusted: (path, sha256) => trust.isTrusted(repositoryRoot, path, sha256),
      trust: (path, sha256) => trust.record(repositoryRoot, path, sha256, 'USER_CONFIRMED'),
      createAttempt: (spec, attempts) => execution.createAttempt(spec, attempts),
      cancelExecutions: (runEpoch) => {
        execution.cancel(runEpoch);
      },
      executionsClosed: () => {
        execution.closed();
      },
      unknownEffects: () => execution.unknownEffects(),
      audit,
      now,
      schedule,
    });
    holder.work = work;
    return work;
  };

  const ownersOf = (sessionId: string): AppendLogPort<ArtifactOwnerLine> =>
    persistence.appendLog('kernel-execution', {
      scope: 'SESSION',
      sessionId,
      file: 'artifact-owners',
    });
  const sweep = new ArtifactSweep({
    store: deps.artifacts,
    activeSessionIds: () => refs.activeSessionIds(),
    ownersOf,
    expiringRetentionDays: config.artifactRetention.expiringRetentionDays,
    now,
    report: (error) => {
      deps.diagnostic?.(`artifact sweep failed: ${String(error)}\n`);
    },
  });

  const removeSessionFiles = async (sessionId: string): Promise<void> => {
    await persistence.sessionDirectory('kernel-core', sessionId).remove();
    await persistence.sessionDirectory('kernel-execution', sessionId).remove();
  };

  const manager = new SessionManager({
    repositoryRoot,
    refs,
    outbox,
    removeSessionFiles,
    titleOf: async (entry) => {
      if (entry.titleRef === undefined) return undefined;
      try {
        const text = Buffer.from(await deps.artifacts.get(entry.titleRef)).toString('utf8');
        return text.slice(0, 80);
      } catch {
        return undefined;
      }
    },
    closeTimeoutMs: config.sessionCloseTimeoutMs,
    startArtifactSweep: () => void sweep.run(),
    sweepIntervalMs: config.artifactRetention.sweepIntervalMinutes * 60_000,
    schedule,
    openActor: async (sessionId, session) => {
      correlations.set(sessionId, newId('cor'));
      const artifacts = new SessionArtifacts({
        store: deps.artifacts,
        owners: ownersOf(sessionId),
        expiringRetentionDays: config.artifactRetention.expiringRetentionDays,
        now,
      });
      await artifacts.load();
      sessionArtifacts.set(sessionId, artifacts);
      const auditLog = persistence.appendLog<object>('kernel-core', {
        scope: 'SESSION',
        sessionId,
        file: 'audit',
      });
      const audit = (entry: object): void => {
        auditLog.append({ at: now().toISOString(), ...entry }).catch(fault);
      };
      // Gateway knows the Session before its first event can make anyone use it.
      await sendSession(sessionId, 'OPEN');
      return new SessionActor({
        sessionId,
        repositoryRoot,
        outbox,
        duties: {
          storeUserInput: (input) => artifacts.storeUserInput(input),
          openRunWork: (host) => openRunWork(sessionId, host, artifacts, audit),
          writeRunSummary: async (summary) => {
            try {
              const checked = assertValid(RunSummarySchema, summary);
              return await artifacts.put(canonicalJson(checked), MEDIA_TYPES.runSummary, 'SESSION');
            } catch {
              // RunClosed then says RUN_SUMMARY_WRITE_FAILED instead of naming a summary.
              return undefined;
            }
          },
          discardSession: session.discard,
        },
        onClosed: (id) => {
          sessionArtifacts.delete(id);
          void sendSession(id, 'CLOSED');
          session.onClosed();
        },
        onFatal: fault,
        admission: (workflowRunId, runState, closeReason) => {
          sendAdmission(sessionId, workflowRunId, runState, closeReason);
        },
      });
    },
  });

  const core = new SessionCore({
    manager,
    artifactsOf: (sessionId) => sessionArtifacts.get(sessionId),
  });

  let started = false;
  return {
    manifest: {
      moduleId: 'kernel-core',
      version: '0.2.0',
      dependencies: ['fabric', 'artifact-store', 'persistence'],
    },
    start: async () => {
      if (started) return;
      await refs.load();
      await trust.load();
      // Before any service opens (Infrastructure/ModuleHost 3); a failure does not block startup.
      await sweep.run();
      manager.startSweepTimer();
      fabric.register<GatewayForward, CoreResponse>(SCHEMA_IDS.gatewayForward, async (envelope) => {
        if (envelope.producer !== 'gateway')
          throw new Error('Kernel core request has an invalid producer');
        const forward = envelope.payload;
        const response = await core.handle(
          forward,
          'sessionId' in forward ? forward.sessionId : undefined,
        );
        if (forward.requestType === 'shutdown' && response.outcome === 'ACCEPTED') {
          await outbox.drained();
          await supervisor.shutdown({ requestId: forward.request.requestId });
        }
        return response;
      });
      fabric.subscribe<ExecutionFact>('kernel-core.execution-facts', async (envelope) => {
        if (envelope.producer !== 'supervisor')
          throw new Error('Kernel core execution fact has an invalid producer');
        const fact = envelope.payload;
        const actor = manager.actor(fact.sessionId);
        const execution = executions.get(fact.workflowRunId);
        // A fact of a Session that already closed has nothing left to settle.
        if (actor === undefined || execution === undefined) return;
        await actor.call(() => execution.handleFact(fact));
      });
      started = true;
    },
    stop: async () => {
      if (!started) return;
      started = false;
      await manager.shutdown();
      await outbox.drained();
      await sweep.finished();
    },
    health: (): Promise<HealthStatus> =>
      Promise.resolve({
        status: started ? 'UP' : 'DOWN',
        checkedAt: now().toISOString(),
        details: [],
      }),
    abortAllRuns: async () => {
      await manager.shutdown();
      await outbox.drained();
    },
  };
}

const ROUTES: readonly { readonly name: RequestType; readonly caller: Caller }[] = [
  ...WORKFLOW_SYSCALLS.map((name) => ({ name, caller: 'workflow' as const })),
  ...INTERACTION_SYSCALLS.map((name) => ({ name, caller: 'user-interaction' as const })),
];

/** Requests that begin a new chain of work get a correlationId of their own (Kernel/Gateway 2). */
const STARTS_CORRELATION: ReadonlySet<RequestType> = new Set([
  'startSession',
  'startRun',
  'openSession',
]);

/**
 * Gateway as its own Fabric subject (Kernel/Gateway): serves every syscall route, checks it with
 * `SessionGateway`, and forwards it to the Kernel core. It reads the admission and Session
 * projections Core pushes and never writes them.
 */
export function createSessionGatewayModule({
  fabric,
  now = () => new Date(),
}: {
  readonly fabric: FabricPort;
  readonly now?: () => Date;
}): LifecyclePort {
  const openSessions = new Set<string>();
  const correlations = new Map<string, string>();
  let registered = false;
  let running = false;

  const contextOf = (
    forward: GatewayForward,
    generated: string | undefined,
    origin: RequestOrigin | undefined,
  ): BoundaryContext => {
    const body = forward.request as {
      readonly sessionId?: string;
      readonly workflowRunId?: string;
    };
    const sessionId = generated ?? body.sessionId;
    let correlationId = sessionId === undefined ? undefined : correlations.get(sessionId);
    if (sessionId !== undefined && STARTS_CORRELATION.has(forward.requestType)) {
      correlationId = newId('cor');
      correlations.set(sessionId, correlationId);
    }
    return {
      ...LOCAL,
      correlationId: correlationId ?? origin?.correlationId ?? newId('cor'),
      ...(origin === undefined ? {} : { causationId: origin.messageId }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(body.workflowRunId === undefined ? {} : { workflowRunId: body.workflowRunId }),
    };
  };

  const gateway = new SessionGateway({
    isOpenSession: (sessionId) => openSessions.has(sessionId),
    handle: (forward, generated, origin) =>
      fabric.request<GatewayForward, CoreResponse>(
        SCHEMA_IDS.gatewayForward,
        forward,
        contextOf(forward, generated, origin),
      ),
  });

  const register = (): void => {
    for (const route of ROUTES)
      fabric.register<unknown, CoreResponse>(
        SCHEMA_IDS[route.name],
        (envelope) => {
          if (!running) throw new Error('Gateway is stopped');
          // The producer is the caller; a subject that may not call this is refused there.
          return gateway.serve(envelope.producer as Caller, route.name, envelope.payload, {
            correlationId: envelope.correlationId,
            messageId: envelope.messageId,
          });
        },
        (envelope) => {
          if (!running) return Promise.reject(new Error('Gateway is stopped'));
          const { requestId } = envelope.payload as { readonly requestId: string };
          const reasonCode =
            envelope.producer === route.caller ? 'INVALID_REQUEST' : 'CALLER_FORBIDDEN';
          return Promise.resolve(gateway.rejected(requestId, reasonCode));
        },
      );
    fabric.subscribe<AdmissionProjection>('gateway.admission', (envelope) => {
      if (envelope.producer !== 'kernel-core')
        throw new Error('Admission projection has an invalid producer');
      const projection = envelope.payload;
      gateway.admission(
        projection.workflowRunId,
        projection.sessionId,
        projection.runState,
        'closeReason' in projection ? projection.closeReason : undefined,
      );
      return Promise.resolve();
    });
    fabric.subscribe<SessionProjection>('gateway.session', (envelope) => {
      if (envelope.producer !== 'kernel-core')
        throw new Error('Session projection has an invalid producer');
      const { sessionId, state } = envelope.payload;
      if (state === 'OPEN') openSessions.add(sessionId);
      else {
        openSessions.delete(sessionId);
        correlations.delete(sessionId);
      }
      return Promise.resolve();
    });
  };

  return {
    manifest: { moduleId: 'gateway', version: '0.2.0', dependencies: ['kernel-core'] },
    start: () => {
      if (!registered) {
        register();
        registered = true;
      }
      running = true;
      return Promise.resolve();
    },
    stop: () => {
      running = false;
      return Promise.resolve();
    },
    health: (): Promise<HealthStatus> =>
      Promise.resolve({
        status: running ? 'UP' : 'DOWN',
        checkedAt: now().toISOString(),
        details: [],
      }),
  };
}
