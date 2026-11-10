import { pathToolchainMounts } from '@multiagentos/contracts';
import {
  DEFAULT_REPOSITORY_EXCLUSIONS,
  MEDIA_TYPES,
  PROTECTED_WRITE_RULES,
  isProjectInstructionPath,
  type ShadowFiles,
  type SnapshotIndexLine,
  type SubprocessRunner,
  type WorkspaceFiles,
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
  type MemoryLevel,
  type MemorySource,
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
  createModelStreamSender,
  createSupervisorPort,
  serveModelProgress,
  createWorkflowEventSender,
} from '@multiagentos/fabric';
import {
  RunLedgers,
  createMemorySampler,
  type AgentBudget,
  type MemorySample,
} from './monitor/index.js';
import { InProcessProviderCapacity, Scheduler } from './scheduler/index.js';
import { AttemptRequestBuilder, type ExecutionConfig } from './session/attempt-request.js';
import { RunCompactor, type CompactionPrompt } from './session/run-compactor.js';
import { RunExecution, type RunExecutionDeps } from './session/run-execution.js';
import {
  RunWork,
  type CommandSupport,
  type PinResult,
  type RunHost,
  type RunWorkDeps,
} from './session/run-work.js';
import {
  protectedPathsOf,
  quarantineNewProtected,
  scanRepository,
  type ScanOptions,
} from './session/sandbox-scan.js';
import { changesBetween, fingerprintRoots, type ChangeScanOptions } from './session/change-scan.js';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SessionActor } from './session/session-actor.js';
import { SessionArtifacts } from './session/session-artifacts.js';
import { WorkspaceSnapshots } from './session/workspace-snapshots.js';
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
import { SessionRefs, TrustRecords, WebSearchTrust } from './session/session-refs.js';

/** What the user is told when memory runs short (Kernel/Monitor 4a). */
/** Released artifacts are swept when this many bytes of them are waiting (Kernel/Execution 6d). */
const RELEASED_SWEEP_BYTES = 20 * 1024 * 1024;

export interface MemoryNotice {
  readonly source: MemorySource;
  readonly level: MemoryLevel;
  readonly ratio: number;
}

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
  /** The Agent a compaction is made as, by reference; none means main (`compactionAgentFrom`). */
  readonly compactionAgent: RunWorkDeps['compactionAgent'];
  /**
   * The instruction of the summary request of a compaction (Prompt `compaction-system`). Without
   * it nothing is compacted, and a context that outgrows its window ends as it does without compaction.
   */
  readonly compactionPrompt?: CompactionPrompt;
  /** The share and budget of an Agent a `run_subagents` task names (M2Design 7.3). */
  readonly agentShare?: RunWorkDeps['agentShare'];
  /** The per-call budget the run and Turn limits are checked against (Kernel/Monitor 6). */
  readonly mainBudget: AgentBudget;
  readonly config: KernelConfig;
  /** This process's repository: a realpath. */
  readonly repositoryRoot: string;
  readonly preset: 'standard' | 'readonly';
  /** What snapshots need; without it (`readonly`, or no git) nothing is captured or undone. */
  readonly workspace?: {
    readonly files: WorkspaceFiles;
    readonly git: SubprocessRunner;
    readonly directoryOf: (sessionId: string) => string;
    readonly shadowOf: (sessionId: string) => ShadowFiles;
  };
  /** `readProjectFile` reads through the same guard as `file-read`. */
  readonly readRepositoryFile: RunExecutionDeps['readRepositoryFile'];
  readonly reportSystemFault?: SystemFaultReporter;
  /**
   * Memory is short: the interface tells the user. It is told whether or not a run is open, and
   * the same notice is on record (`memory-events`). A run, if there is one, is handled by Core.
   */
  readonly onMemoryNotice?: (notice: MemoryNotice) => void;
  /** Where the sampler reads memory; a test gives a controllable one. */
  readonly memorySample?: () => MemorySample;
  /** The system data directory, which no command may see. */
  readonly dataDir?: string;
  /** The PATH to mount toolchains from; defaults to this process's. */
  readonly hostPath?: string;
  /** Commands (Kernel/Core 5b): the analysis of a line, and what the probe found. */
  readonly commands?: {
    readonly analyze: CommandSupport['analyze'];
    readonly sandbox: () => 'AVAILABLE' | 'UNAVAILABLE';
    /** What the probe found, for the audit of every Session. */
    readonly probe?: { readonly available: boolean; readonly reason?: string };
  };
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
  pauseDrainMs: config.pauseDrainMs,
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
  const capacity = new InProcessProviderCapacity(config.providerCapacity);
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
  // The thinking of model calls on its way to the console (docs/M2/Phase1Console.md 4): beside the
  // ordered events, never logged, and only for calls this Kernel started.
  const streamToInteraction = createModelStreamSender(fabric, correlationOf);
  const watchedCalls = new Map<
    string,
    { readonly sessionId: string; readonly agentRunId: string }
  >();
  const refs = new SessionRefs(
    persistence.appendLog('kernel-core', { scope: 'SYSTEM', file: 'session-refs' }),
    repositoryRoot,
    now,
  );
  const trust = new TrustRecords(
    persistence.appendLog('kernel-core', { scope: 'SYSTEM', file: 'trusted-instructions' }),
    now,
  );
  const webTrust = new WebSearchTrust(
    persistence.appendLog('kernel-core', { scope: 'SYSTEM', file: 'trusted-web-search' }),
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

  /**
   * What comes back into the sandbox from $HOME: the configured toolchains, and the directories
   * the user's PATH names, so that a command finds the tools the user's shell finds.
   */
  const toolchains = (): string[] => [
    ...new Set([
      ...config.sandbox.homeReadOnly.map(expandHome),
      ...(config.sandbox.mountPath
        ? pathToolchainMounts(deps.hostPath ?? process.env['PATH'], homedir(), [
            repositoryRoot,
            ...(deps.dataDir === undefined ? [] : [deps.dataDir]),
          ])
        : []),
    ]),
  ];
  const expandHome = (path: string): string =>
    path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
  /** What looking at the repository for a command uses: the same rules as the file tools. */
  const scanOptions: ScanOptions = {
    repositoryRoot,
    extraSecretRules: [...config.repositoryExclusions, ...config.sandboxMaskedPatterns],
    exclusions: [...DEFAULT_REPOSITORY_EXCLUSIONS, ...config.repositoryExclusions],
    maxEntries: config.maxSnapshotFiles * 10,
  };
  /** What a command changed: the write roots of its AgentRun, before and after (M2Design 7.1). */
  const changeOptions: ChangeScanOptions = {
    repositoryRoot,
    exclusions: config.repositoryExclusions,
    maxEntries: config.maxSnapshotFiles * 10,
  };
  /** Where a protected path a command made is moved (M2Design 6.1). */
  const quarantineOf = (sessionId: string): string =>
    deps.workspace === undefined
      ? join(tmpdir(), 'mas-quarantine', sessionId)
      : join(dirname(deps.workspace.directoryOf(sessionId)), 'quarantine');

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
      modelStarted: (call) =>
        void watchedCalls.set(call.executionId, { sessionId, agentRunId: call.agentRunId }),
      cancelRun: (request) => supervisor.cancelRun(request),
      cancelExecution: (request) => supervisor.cancelExecution(request),
      retrying: (retry) => holder.work?.retrying(retry),
      released: (bytes) => {
        // Released bodies are reclaimed by the sweep: it runs when enough of them are waiting.
        releasedBytes += bytes;
        if (releasedBytes < RELEASED_SWEEP_BYTES) return;
        releasedBytes = 0;
        void sweep.run();
      },
      afterAssemble: (info) => holder.work?.afterAssemble(info) ?? Promise.resolve('PROCEED'),
      compactionDue: (info) => holder.work?.compactionDue(info) ?? false,
      // How full the conversation's context is, told to the console beside the ordered events.
      contextLevel: (level) => {
        if (holder.work?.isMain(level.agentRunId) !== true) return;
        streamToInteraction({
          sessionId,
          workflowRunId: host.workflowRunId,
          agentRunId: level.agentRunId,
          callId: level.executionId,
          at: now().toISOString(),
          kind: 'CONTEXT',
          used: level.used,
          limit: level.limit,
        });
      },
      modelAnswered: (info) => {
        holder.work?.modelAnswered(info);
      },
      // A write the user approved gives the content they saw standing (Kernel/Core 5a.4).
      written: (path, sha256) =>
        isProjectInstructionPath(path)
          ? trust.record(repositoryRoot, path, sha256, 'APPROVED_WRITE')
          : Promise.resolve(),
      readRepositoryFile: deps.readRepositoryFile,
      ...(deps.commands === undefined
        ? {}
        : {
            protectedPaths: {
              snapshot: () => protectedPathsOf(scanOptions),
              quarantine: (before) =>
                quarantineNewProtected(scanOptions, before, quarantineOf(sessionId)),
            },
          }),
      changes: {
        snapshot: (roots) => fingerprintRoots(changeOptions, roots),
        since: async (before, roots) => {
          const after = await fingerprintRoots(changeOptions, roots);
          return after === undefined ? undefined : changesBetween(before, after);
        },
      },
      audit,
      enqueue: (work) => {
        host.enqueue(work);
      },
      schedule,
      now,
      limits: {
        maxAttempts: config.maxConcurrentAttempts,
        maxExec: config.maxConcurrentExec,
        maxWeb: config.maxConcurrentWeb,
        serial: config.serialExecution,
      },
    });
    executions.set(host.workflowRunId, execution);
    const ledgers = new RunLedgers(
      {
        runTokenLimit: config.budget.runTokenLimit,
        turnTokenLimit: config.budget.turnTokenLimit,
      },
      deps.mainBudget,
    );
    const scheduler = new Scheduler(capacity);
    const compactor =
      deps.compactionPrompt === undefined
        ? undefined
        : new RunCompactor({
            sessionId,
            workflowRunId: host.workflowRunId,
            compaction: config.compaction,
            limits: executionConfig.executionLimits,
            artifacts,
            builder: new AttemptRequestBuilder({ config: executionConfig, artifacts, now }),
            prompt: deps.compactionPrompt,
            provider: config.provider,
            ledgers,
            scheduler,
            dispatch: (request) => supervisor.execute(request),
            cancelExecution: (request) => supervisor.cancelExecution(request),
            expectInternal: (unitAttemptId, handler) => {
              execution.expectInternal(unitAttemptId, handler);
            },
            runEpoch: () => host.runEpoch(),
            enqueue: (work) => {
              host.enqueue(work);
            },
            toWorkflow: (event) => {
              host.toWorkflowEvent(event);
            },
            toInteraction: (event) => {
              host.toInteraction(event);
            },
            audit,
            now,
            schedule,
            agentOf: (target) => holder.work?.compactionAgent(target),
          });
    const work = new RunWork({
      host,
      ledgers,
      scheduler,
      ...(compactor === undefined ? {} : { compactor, compaction: config.compaction }),
      memoryLevel: () => sampler.level(),
      provider: config.provider,
      technicalRetryLimit: config.technicalRetryLimit,
      repositoryRoot,
      repositoryExclusions: config.repositoryExclusions,
      pinAgent: deps.pinAgent,
      compactionAgent: deps.compactionAgent,
      ...(deps.agentShare === undefined ? {} : { agentShare: deps.agentShare }),
      inputIsValid,
      preset: deps.preset,
      web: { deniedDomains: config.web.deniedDomains, searchProvider: config.web.search.provider },
      external: {
        homeDir: homedir(),
        ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
      },
      ...(deps.commands === undefined
        ? {}
        : {
            command: {
              analyze: deps.commands.analyze,
              sandbox: deps.commands.sandbox,
              unavailablePolicy: config.sandbox.unavailable,
              ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
              homeReadOnly: toolchains(),
              homeMaskedFiles: config.sandbox.homeMaskedFiles.map(expandHome),
              scan: () => scanRepository(scanOptions),
            },
          }),
      readProjectFile: (path, scope) => execution.readProjectFile(path, scope),
      isTrusted: (path, sha256) => trust.isTrusted(repositoryRoot, path, sha256),
      trust: (path, sha256) => trust.record(repositoryRoot, path, sha256, 'USER_CONFIRMED'),
      webSearchTrusted: () => webTrust.isTrusted(repositoryRoot),
      trustWebSearch: () => webTrust.record(repositoryRoot),
      retainArtifacts: (refs) => artifacts.retain(refs),
      storeQuestionContent: (text) => artifacts.put(text, MEDIA_TYPES.fileText, 'SESSION'),
      createAttempt: (spec, attempts) => execution.createAttempt(spec, attempts),
      cancelExecutions: (runEpoch) => {
        execution.cancel(runEpoch);
      },
      pauseExecutions: (drained) => {
        execution.pause(drained);
      },
      resumeExecutions: () => execution.resume(),
      abortExecutions: () => {
        execution.abort();
      },
      executionsClosed: () => {
        execution.closed();
      },
      drainCapacityWaiters: () => execution.drainCapacityWaiters(),
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

  let releasedBytes = 0;

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
      const snapshots =
        deps.workspace === undefined
          ? undefined
          : new WorkspaceSnapshots({
              repositoryRoot,
              directory: deps.workspace.directoryOf(sessionId),
              index: persistence.appendLog<SnapshotIndexLine>('kernel-execution', {
                scope: 'SESSION',
                sessionId,
                file: 'snapshot-index',
              }),
              git: deps.workspace.git,
              files: deps.workspace.files,
              shadow: deps.workspace.shadowOf(sessionId),
              ...(deps.diagnostic === undefined ? {} : { diagnostic: deps.diagnostic }),
              rules: [
                ...PROTECTED_WRITE_RULES,
                ...DEFAULT_REPOSITORY_EXCLUSIONS,
                ...config.repositoryExclusions,
              ],
              now,
            });
      await snapshots?.load();
      // Another folder's Session: its snapshots begin again before the folder is made its own, so a
      // crash in between is repeated on the next open and never leaves old snapshots under it.
      if (session.workspaceChanged) {
        await snapshots?.startEpoch();
        await session.rebind();
      }
      const auditLog = persistence.appendLog<object>('kernel-core', {
        scope: 'SESSION',
        sessionId,
        file: 'audit',
      });
      const audit = (entry: object): void => {
        auditLog.append({ at: now().toISOString(), ...entry }).catch(fault);
      };
      // What the probe found is on the audit of every Session (M2Design 6.2).
      if (deps.commands?.probe !== undefined)
        audit({ type: 'SANDBOX_PROBED', sessionId, ...deps.commands.probe });
      // Gateway knows the Session before its first event can make anyone use it.
      await sendSession(sessionId, 'OPEN');
      return new SessionActor({
        sessionId,
        repositoryRoot,
        outbox,
        preset: deps.preset,
        duties: {
          ...(snapshots === undefined ? {} : { snapshots }),
          storeDiff: (text) => artifacts.put(text, MEDIA_TYPES.fileText, 'SESSION'),
          inheritArtifacts: async (fromSessionId, refs) => {
            const unknown = await artifacts.inherit(refs, ownersOf(fromSessionId));
            for (const ref of unknown)
              audit({ type: 'ARTIFACT_NOT_INHERITED', artifactId: ref.artifactId });
          },
          storeUserInput: (input) => artifacts.storeUserInput(input),
          titleOf: async (ref) => {
            try {
              return Buffer.from(await deps.artifacts.get(ref))
                .toString('utf8')
                .slice(0, 80);
            } catch {
              return undefined;
            }
          },
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
        interruptBackstopMs: config.cancelGraceMs + config.convergenceMarginMs + 10_000,
        timeouts: {
          turnMs: config.turnTimeoutSeconds * 1000,
          orchestrationMs: config.orchestrationTimeoutSeconds * 1000,
          pauseMs: config.maxPauseSeconds * 1000,
        },
        schedule,
        onInterrupted: () => {
          deps.diagnostic?.('memory pressure: the run was interrupted\n');
        },
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

  const memoryEvents = persistence.appendLog<object>('kernel-core', {
    scope: 'SYSTEM',
    file: 'memory-events',
  });
  // Who asked the system to stop, for whoever looks into why a conversation ended: the Session
  // log and Workflow know only that the run closed with SHUTDOWN, as before.
  const shutdownRequests = persistence.appendLog<object>('kernel-core', {
    scope: 'SYSTEM',
    file: 'shutdown-requests',
  });
  let started = false;
  // The sampler's only way out is this one message to Core (Kernel/Monitor 4a).
  const sampler = createMemorySampler({
    intervalMs: config.memory.sampleIntervalMs,
    thresholds: {
      warningRatio: config.memory.warningRatio,
      dangerRatio: config.memory.dangerRatio,
    },
    ...(deps.memorySample === undefined ? {} : { read: deps.memorySample }),
    send: (message) => {
      // Recorded first, so that a notice the user saw can always be found afterwards.
      memoryEvents
        .append({
          at: now().toISOString(),
          source: message.source,
          level: message.level,
          ratio: message.ratio,
          rssBytes: message.rssBytes,
          heapRatio: message.heapRatio,
          ...(message.availableBytes === undefined
            ? {}
            : { availableBytes: message.availableBytes }),
        })
        .catch(fault);
      deps.diagnostic?.(
        `memory ${message.source} ${message.level}: ${(message.ratio * 100).toFixed(0)}%\n`,
      );
      deps.onMemoryNotice?.({
        source: message.source,
        level: message.level,
        ratio: message.ratio,
      });
      // Only this process's own pressure touches a run (M2Design 7.7).
      if (message.source === 'PROCESS') void manager.memoryPressure(message.level).catch(fault);
    },
    ...(deps.diagnostic === undefined ? {} : { diagnostic: deps.diagnostic }),
  });

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
      await webTrust.load();
      // Before any service opens (Infrastructure/ModuleHost 3); a failure does not block startup.
      await sweep.run();
      manager.startSweepTimer();
      sampler.start();
      fabric.register<GatewayForward, CoreResponse>(SCHEMA_IDS.gatewayForward, async (envelope) => {
        if (envelope.producer !== 'gateway')
          throw new Error('Kernel core request has an invalid producer');
        const forward = envelope.payload;
        if (forward.requestType === 'shutdown')
          await shutdownRequests
            .append({
              at: now().toISOString(),
              type: 'SHUTDOWN_REQUESTED',
              source: forward.request.source,
              requestId: forward.request.requestId,
            })
            .catch(fault);
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
      serveModelProgress(fabric, (progress) => {
        const call = watchedCalls.get(progress.executionId);
        if (call === undefined || call.sessionId !== progress.sessionId) return;
        const stream = {
          sessionId: progress.sessionId,
          workflowRunId: progress.workflowRunId,
          agentRunId: call.agentRunId,
          callId: progress.executionId,
          at: progress.at,
        };
        if (progress.kind === 'END') {
          watchedCalls.delete(progress.executionId);
          streamToInteraction({ ...stream, kind: 'END' });
        } else if (progress.kind === 'ANSWER') streamToInteraction({ ...stream, kind: 'ANSWER' });
        else if (progress.kind === 'TOOL')
          streamToInteraction({
            ...stream,
            kind: 'TOOL',
            name: progress.name,
            ...(progress.target === undefined ? {} : { target: progress.target }),
          });
        else streamToInteraction({ ...stream, kind: 'REASONING', delta: progress.delta });
      });
      fabric.subscribe<ExecutionFact>('kernel-core.execution-facts', async (envelope) => {
        if (envelope.producer !== 'supervisor')
          throw new Error('Kernel core execution fact has an invalid producer');
        const fact = envelope.payload;
        // The side channel is lossy: its END may never come, but the call's fact always does.
        watchedCalls.delete(fact.executionId);
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
      sampler.stop();
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
