import {
  MEDIA_TYPES,
  REASON_CODE_CATEGORY,
  canonicalJson,
  newId,
  type AdmissionProjection,
  type ArtifactContent,
  type ArtifactRef,
  type BoundaryContext,
  type BudgetState,
  type CloseReason,
  type AssembleContextPack,
  type CoreRejectedCode,
  type OrientContextPack,
  type UnitOutput,
  type Envelope,
  type ExecutionFact,
  type ExecutionRequest,
  type ExecutionScope,
  type Executor,
  type ExecutorEnvironment,
  type ExecutorKind,
  type ExecutorOutcome,
  type GatewayForward,
  type InteractionInboxEvent,
  type KernelToInteractionEvent,
  type KernelToWorkflowEvent,
  type LifecyclePort,
  type ModelToolSpec,
  type PinnedDefinitionRef,
  type PinnedDefinitionSet,
  type Producer,
  type ReasonCode,
  type RunClosed,
  type RunCreated,
  type RunFailure,
  type RunFinished,
  type RunSummary,
  type SubmitUnitRequest,
  type SyscallAck,
  type SyscallRejected,
  type UnitDefinition,
  type WorkflowInboxEvent,
} from '@multiagentos/contracts';
import {
  OrderedSender,
  SCHEMA_IDS,
  createExecutionFactSink,
  createInteractionInboxSender,
  createSupervisorPort,
  createWorkflowInboxSender,
  serveExecutionFacts,
  serveSupervisor,
} from '@multiagentos/fabric';
import type {
  GatewayDeps,
  KernelCoreDeps,
  SupervisorDeps,
  SupervisorModule,
} from '@multiagentos/kernel';

/**
 * Kernel stand-in for Workflow, UserInteraction and ExecutorSet work. It follows the external
 * behaviour of docs/M1/Module/Kernel.md (one RunStart, one UnitReport per accepted submitUnit,
 * one RunClosed and RunFinished) and sends every Unit except report-publish through
 * SupervisorPort to the injected Executors, one at a time. It has no Lease, budget ledger,
 * timeout, retry or run actor, and it does not validate a Unit input against its contract:
 * never use it to judge Kernel behaviour.
 */
export interface FakeKernelOptions {
  /** ASK sends one AuthorizationRequest before the first protected Unit; default GRANTED. */
  readonly authorization?: 'GRANTED' | 'ASK';
  /**
   * Scripts the fate of a Unit before it is dispatched: `reject` or `fail` deliver that
   * UnitReport without running an Executor, and `budgetState` is attached to the report.
   */
  readonly unitScript?: (unit: {
    readonly executionKind: UnitDefinition['executionKind'];
    /** 0 for the first accepted submitUnit of the run. */
    readonly index: number;
  }) => { reject?: ReasonCode; fail?: ReasonCode; budgetState?: BudgetState } | undefined;
}

type GatewayResponse = SyscallAck | SyscallRejected | RunCreated | ArtifactContent;
const CALLERS: { readonly [T in GatewayForward['requestType']]: Producer } = {
  registerAgentRun: 'workflow',
  submitUnit: 'workflow',
  endAgentRun: 'workflow',
  closeRun: 'workflow',
  createRun: 'user-interaction',
  answerAuthorization: 'user-interaction',
  cancelRun: 'user-interaction',
  readArtifact: 'user-interaction',
  shutdown: 'user-interaction',
};

/** Checks the caller, generates the run identifiers and forwards to the Kernel core. */
export function createFakeGateway(): (deps: GatewayDeps) => LifecyclePort {
  return ({ fabric }) => {
    const correlationIds = new Map<string, string>();
    const serve = (requestType: GatewayForward['requestType']) => {
      fabric.register(
        SCHEMA_IDS[requestType],
        async (envelope: Envelope<{ requestId: string; workflowRunId?: string }>) => {
          const request = envelope.payload;
          if (envelope.producer !== CALLERS[requestType]) {
            const rejected: SyscallRejected = {
              requestId: request.requestId,
              outcome: 'REJECTED',
              reasonCode: 'CALLER_FORBIDDEN',
              issuer: 'GATEWAY',
            };
            return rejected;
          }
          const workflowRunId = requestType === 'createRun' ? newId('wfr') : request.workflowRunId;
          if (requestType === 'createRun' && workflowRunId !== undefined)
            correlationIds.set(workflowRunId, newId('cor'));
          const context: BoundaryContext = {
            // Callers cannot know the run's correlationId, so Gateway stamps it (M1Interface 2.4).
            correlationId:
              (workflowRunId === undefined ? undefined : correlationIds.get(workflowRunId)) ??
              envelope.correlationId,
            causationId: envelope.messageId,
            tenantId: envelope.tenantId,
            projectId: envelope.projectId,
            ...(workflowRunId === undefined ? {} : { workflowRunId }),
          };
          const forward = {
            caller: CALLERS[requestType],
            requestType,
            request,
            ...(requestType === 'createRun' ? { workflowRunId } : {}),
          };
          return await fabric.request<unknown, GatewayResponse>(
            SCHEMA_IDS.gatewayForward,
            forward,
            context,
          );
        },
      );
    };
    return lifecycle('gateway', ['kernel-core'], {
      start: () => {
        for (const requestType of Object.keys(CALLERS) as GatewayForward['requestType'][])
          serve(requestType);
        fabric.subscribe<AdmissionProjection>('gateway.admission', () => Promise.resolve());
        return Promise.resolve();
      },
    });
  };
}

/**
 * Boots and stops the other modules through ModuleHost and runs each execution with the
 * injected Executor, reporting exactly one fact for it. It enforces no deadline and has no grace
 * period: `cancelRun` only fires the abort signal, and the subprocess runner never starts
 * anything.
 */
export function createFakeSupervisor(): (deps: SupervisorDeps) => SupervisorModule {
  return ({ fabric, moduleHost, executors, credentials, now = () => new Date() }) => {
    let resolveStopped: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= moduleHost.stop().finally(resolveStopped);
      return stopping;
    };
    const aborts = new Map<string, AbortController>();
    const facts = createExecutionFactSink(fabric, (workflowRunId) => ({
      correlationId: newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      ...(workflowRunId === undefined ? {} : { workflowRunId }),
    }));

    const run = async (request: ExecutionRequest) => {
      const abort = new AbortController();
      aborts.set(request.executionId, abort);
      const startedAt = now().toISOString();
      const environment: ExecutorEnvironment = {
        scope: request.scope,
        limits: request.limits,
        signal: abort.signal,
        subprocess: {
          run: () =>
            Promise.resolve({ exitCode: null, signal: null, stdout: '', truncated: false }),
        },
        credentials,
        now,
      };
      let outcome: ExecutorOutcome;
      try {
        const executor = executors[request.executionKind] as Executor<ExecutorKind>;
        outcome = await executor.execute(request.input, environment);
      } catch {
        // An Executor must not throw; the fake reports it instead of hiding it.
        outcome = { outcome: 'FAILED', reasonCode: 'INTERNAL', retryable: false };
      }
      aborts.delete(request.executionId);
      const { workflowRunId, unitAttemptId, executionId, runEpoch, executionKind } = request;
      const { usage, requestState, ...verdict } = {
        usage: undefined,
        requestState: undefined,
        ...outcome,
      };
      const fact = {
        workflowRunId,
        unitAttemptId,
        executionId,
        runEpoch,
        executionKind,
        startedAt,
        endedAt: now().toISOString(),
        ...verdict,
        // Only a MODEL execution has a request state; UNKNOWN when the Executor gave none.
        ...(executionKind === 'MODEL'
          ? { requestState: requestState ?? 'UNKNOWN', ...(usage === undefined ? {} : { usage }) }
          : {}),
      };
      // The shape depends on the Executor's verdict; Fabric validates it against the Schema.
      await facts.report(fact as unknown as ExecutionFact);
    };

    return {
      ...lifecycle('supervisor', [], {
        start: async () => {
          await moduleHost.start();
          serveSupervisor(fabric, {
            // Accepting returns at once; the execution itself runs afterwards.
            execute: (request) => {
              setImmediate(() => void run(request));
              return Promise.resolve();
            },
            cancelRun: () => {
              for (const abort of aborts.values()) abort.abort();
              return Promise.resolve();
            },
            // Stopping includes Fabric, so it must start after this request has returned.
            shutdown: () => {
              setImmediate(() => void stop());
              return Promise.resolve();
            },
          });
        },
        stop,
      }),
      whenStopped: () => stopped,
    };
  };
}

/** The output and artifact of a finished Unit, whether an Executor or the Kernel produced it. */
interface UnitResult {
  readonly output: UnitOutput;
  readonly artifact: { readonly mediaType: string; readonly text: string };
}

interface FakeAgentRun {
  readonly agentRef: PinnedDefinitionRef;
  readonly pinned: PinnedDefinitionSet;
  modelCalls: number;
}

interface FakeRun {
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly repositoryPath: string;
  readonly startedAt: Date;
  closeReason: CloseReason | undefined;
  readonly agentRuns: Map<string, FakeAgentRun>;
  readonly artifacts: Map<string, ArtifactRef>;
  readonly seq: { workflow: number; interaction: number };
  authorization: 'NOT_ASKED' | 'PENDING' | 'GRANTED' | 'DECLINED';
  questionId: string | undefined;
  readonly waiting: { request: SubmitUnitRequest; unit: UnitDefinition; index: number }[];
  readonly units: { submitted: number; ok: number; rejected: number; failed: number };
}

export function createFakeKernelCore(
  options: FakeKernelOptions = {},
): (deps: KernelCoreDeps) => LifecyclePort {
  return (deps) => {
    const now = deps.now ?? (() => new Date());
    let run: FakeRun | undefined;
    let shuttingDown = false;
    const faults: unknown[] = [];
    /** Work that needs I/O runs here one after another, so reports keep the submit order. */
    let work: Promise<void> = Promise.resolve();
    const later = (task: () => Promise<void>) => {
      work = work.then(task).catch((error: unknown) => {
        faults.push(error);
      });
    };
    const awaitedFacts = new Map<string, (fact: ExecutionFact) => void>();

    const contextOf = (workflowRunId: string | undefined): BoundaryContext => ({
      correlationId: run?.correlationId ?? newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      ...(workflowRunId === undefined ? {} : { workflowRunId }),
    });
    const workflowInbox = createWorkflowInboxSender(deps.fabric, contextOf);
    const interactionInbox = createInteractionInboxSender(deps.fabric, contextOf);
    const supervisor = createSupervisorPort(deps.fabric, contextOf);
    const toWorkflow = new OrderedSender<WorkflowInboxEvent>(
      (event) => workflowInbox.deliver(event),
      (error) => faults.push(error),
    );
    const toInteraction = new OrderedSender<InteractionInboxEvent>(
      (event) => interactionInbox.deliver(event),
      (error) => faults.push(error),
    );
    const header = (target: FakeRun, receiver: 'workflow' | 'interaction') => ({
      eventId: newId('evt'),
      workflowRunId: target.workflowRunId,
      seq: (target.seq[receiver] += 1),
      occurredAt: now().toISOString(),
    });
    const emitWorkflow = (target: FakeRun, event: KernelToWorkflowEvent) =>
      toWorkflow.enqueue({ ...header(target, 'workflow'), event });
    const emitInteraction = (target: FakeRun, event: KernelToInteractionEvent) =>
      toInteraction.enqueue({ ...header(target, 'interaction'), event });

    const ack = (requestId: string): SyscallAck => ({ requestId, outcome: 'ACCEPTED' });
    const reject = (requestId: string, reasonCode: CoreRejectedCode): SyscallRejected => ({
      requestId,
      outcome: 'REJECTED',
      reasonCode,
      issuer: 'CORE',
    });
    const blocked = (requestId: string, closeReason: CloseReason): SyscallRejected => ({
      requestId,
      outcome: 'REJECTED',
      reasonCode: 'RUN_BLOCKED',
      issuer: 'CORE',
      closeReason,
    });

    const store = async (target: FakeRun, mediaType: string, text: string) => {
      const ref = await deps.artifacts.put(target.workflowRunId, Buffer.from(text), mediaType);
      target.artifacts.set(ref.artifactId, ref);
      return ref;
    };
    /** Undefined when the reference is unknown to this run. */
    const readText = async (target: FakeRun, ref: ArtifactRef): Promise<string | undefined> => {
      const owned = target.artifacts.get(ref.artifactId);
      if (owned === undefined || owned.sha256 !== ref.sha256) return undefined;
      return Buffer.from(await deps.artifacts.get(target.workflowRunId, owned)).toString('utf8');
    };

    const toolSpecsOf = (pinned: PinnedDefinitionSet, final: boolean): ModelToolSpec[] =>
      pinned.tools
        .filter((tool) => !final || tool.id === pinned.agent.actions.finish.toolRef.id)
        .map((tool) => ({
          name: tool.modelName,
          description: tool.modelDescription,
          parameters: deps.registry.jsonSchemaOf(tool.parametersContract),
          purpose: tool.purpose,
        }));

    /** The executor input and scope of a Unit, or the reason it cannot be dispatched. */
    const prepare = async (
      target: FakeRun,
      agentRun: FakeAgentRun,
      request: SubmitUnitRequest,
      kind: ExecutorKind,
    ): Promise<{ input: unknown; scope: ExecutionScope } | ReasonCode> => {
      const input = request.input as Record<string, unknown>;
      const { budget } = deps.config;
      const repository: ExecutionScope = {
        kind: 'REPOSITORY',
        repositoryRoot: target.repositoryPath,
        exclusions: [...deps.config.repositoryExclusions],
      };
      switch (kind) {
        case 'REPOSITORY_ORIENT':
          return {
            input: { objective: input['objective'], tokenBudget: budget.orientBudget },
            scope: repository,
          };
        case 'REPOSITORY_SEARCH':
          return {
            input: {
              query: input['query'],
              mode: input['mode'] ?? 'AUTO',
              maxItems: input['maxItems'] ?? 20,
              tokenBudget: budget.searchBudget,
            },
            scope: repository,
          };
        case 'FILE_READ':
          return { input, scope: repository };
        case 'CONTEXT_ASSEMBLE': {
          const final = input['final'] === true;
          const orientRef = input['orientPackRef'] as ArtifactRef | undefined;
          const orientText =
            orientRef === undefined ? undefined : await readText(target, orientRef);
          if (orientRef !== undefined && orientText === undefined) return 'INVALID_ARTIFACT_REF';
          const history = [];
          for (const step of input['steps'] as {
            kind: string;
            status?: string;
            outputRef?: ArtifactRef;
          }[]) {
            if (
              step.kind !== 'TOOL_RESULT' ||
              step.status !== 'OK' ||
              step.outputRef === undefined
            ) {
              history.push({ step });
              continue;
            }
            const outputText = await readText(target, step.outputRef);
            if (outputText === undefined) return 'INVALID_ARTIFACT_REF';
            history.push({ step, outputText });
          }
          return {
            input: {
              objective: input['objective'],
              final,
              tokenBudget: final ? budget.finalInputBudget : budget.perCallInputLimit,
              instructions: agentRun.pinned.prompt.template,
              toolSpecs: toolSpecsOf(agentRun.pinned, final),
              ...(input['handoff'] === undefined ? {} : { handoff: input['handoff'] }),
              ...(orientText === undefined
                ? {}
                : { orientPack: JSON.parse(orientText) as OrientContextPack }),
              history,
              status: input['status'],
            },
            scope: { kind: 'NONE' },
          };
        }
        case 'MODEL': {
          const packText = await readText(target, input['contextPackRef'] as ArtifactRef);
          if (packText === undefined) return 'INVALID_ARTIFACT_REF';
          const { model, agent } = agentRun.pinned;
          agentRun.modelCalls += 1;
          return {
            input: {
              contextPack: JSON.parse(packText) as AssembleContextPack,
              final: input['final'] === true,
            },
            scope: {
              kind: 'MODEL',
              provider: model.provider,
              apiModelId: model.apiModelId,
              apiProtocol: model.apiProtocol,
              baseUrl: model.baseUrl,
              ...(agent.modelSettings.thinking === 'ENABLED'
                ? { thinking: 'ENABLED', thinkingEffort: agent.modelSettings.thinkingEffort ?? '' }
                : { thinking: 'DISABLED' }),
            },
          };
        }
      }
    };

    /** Runs one Unit to its result: built in for report-publish, through the Supervisor otherwise. */
    const execute = async (
      target: FakeRun,
      agentRun: FakeAgentRun,
      request: SubmitUnitRequest,
      unit: UnitDefinition,
    ): Promise<UnitResult | { status: 'REJECTED' | 'FAILED'; reasonCode: ReasonCode }> => {
      if (unit.executionKind === 'REPORT_PUBLISH') {
        const { report } = request.input as {
          report: { conclusions: unknown[]; unconfirmed: unknown[]; degraded: boolean };
        };
        return {
          output: {
            conclusionCount: report.conclusions.length,
            unconfirmedCount: report.unconfirmed.length,
            degraded: report.degraded,
          },
          artifact: { mediaType: MEDIA_TYPES.analysisReport, text: canonicalJson(report) },
        };
      }
      const kind = unit.executionKind as ExecutorKind;
      const prepared = await prepare(target, agentRun, request, kind);
      if (typeof prepared === 'string') return { status: 'REJECTED', reasonCode: prepared };
      const executionId = newId('exe');
      const limit = deps.config.executionLimits[kind];
      const final = (request.input as { final?: boolean }).final === true;
      const fact = new Promise<ExecutionFact>((resolve) => awaitedFacts.set(executionId, resolve));
      await supervisor.execute({
        workflowRunId: target.workflowRunId,
        unitAttemptId: newId('una'),
        executionId,
        runEpoch: 1,
        executionKind: kind,
        ...prepared,
        limits: {
          deadline: new Date(now().getTime() + limit.timeoutMs).toISOString(),
          maxOutputBytes: limit.maxOutputBytes,
          ...(kind === 'MODEL'
            ? {
                maxOutputTokens: final
                  ? deps.config.budget.finalMaxOutputTokens
                  : deps.config.budget.maxOutputTokens,
              }
            : {}),
          ...(kind === 'REPOSITORY_ORIENT' ? { maxFiles: deps.config.maxSnapshotFiles } : {}),
        },
      } as ExecutionRequest);
      const result = await fact;
      if (result.outcome === 'COMPLETED') return result.result;
      if (result.outcome === 'VIOLATION') {
        finish(target, 'VIOLATION', {
          failure: {
            code: result.reasonCode,
            category: REASON_CODE_CATEGORY[result.reasonCode],
            source: 'KERNEL',
            unitRequestId: request.requestId,
          },
        });
        return { status: 'FAILED', reasonCode: result.reasonCode };
      }
      return {
        status: result.outcome === 'REJECTED' ? 'REJECTED' : 'FAILED',
        reasonCode: result.reasonCode,
      };
    };

    const report = (
      target: FakeRun,
      request: SubmitUnitRequest,
      unit: UnitDefinition,
      index: number,
    ) => {
      const scripted = options.unitScript?.({ executionKind: unit.executionKind, index });
      const common = {
        type: 'UnitReport' as const,
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        unitRef: request.unitRef,
        executionKind: unit.executionKind,
        budgetState: scripted?.budgetState ?? ('NORMAL' as const),
      };
      // The report shapes depend on run-time values; Fabric validates each against the Schema.
      const failed = (status: 'REJECTED' | 'FAILED', reasonCode: ReasonCode) => {
        target.units[status === 'REJECTED' ? 'rejected' : 'failed'] += 1;
        emitWorkflow(target, {
          ...common,
          // A declined Unit never became an attempt, so it has no unitAttemptId.
          ...(reasonCode === 'USER_DECLINED' ? {} : { unitAttemptId: newId('una') }),
          status,
          reasonCode,
        } as KernelToWorkflowEvent);
      };
      if (unit.protectedCapabilities.length > 0 && target.authorization === 'DECLINED')
        return failed('REJECTED', 'USER_DECLINED');
      if (scripted?.reject !== undefined) return failed('REJECTED', scripted.reject);
      if (scripted?.fail !== undefined) return failed('FAILED', scripted.fail);
      const agentRun = target.agentRuns.get(request.agentRunId);
      if (agentRun === undefined) return failed('FAILED', 'INTERNAL');
      later(async () => {
        if (target.closeReason !== undefined) return;
        const result = await execute(target, agentRun, request, unit);
        if (target.closeReason !== undefined) return;
        if ('status' in result) return failed(result.status, result.reasonCode);
        const outputRef = await store(target, result.artifact.mediaType, result.artifact.text);
        target.units.ok += 1;
        emitWorkflow(target, {
          ...common,
          unitAttemptId: newId('una'),
          status: 'OK',
          output: result.output,
          outputRef,
        } as KernelToWorkflowEvent);
      });
    };

    function finish(
      target: FakeRun,
      closeReason: CloseReason,
      outcome: { reportRef?: ArtifactRef; failure?: RunFailure } = {},
    ): void {
      if (target.closeReason !== undefined) return;
      target.closeReason = closeReason;
      if (target.authorization === 'PENDING' && target.questionId !== undefined)
        emitInteraction(target, {
          type: 'AuthorizationResolved',
          questionId: target.questionId,
          resolution: 'CANCELLED',
        });
      void supervisor
        .cancelRun({ workflowRunId: target.workflowRunId, runEpoch: 2 })
        .catch((error: unknown) => faults.push(error));
      later(async () => {
        const closedAt = now();
        const { submitted, ok, rejected, failed } = target.units;
        // Which of failure and reportRef exists follows closeReason; the Schema checks it.
        const summary = {
          workflowRunId: target.workflowRunId,
          closeReason,
          ...outcome,
          startedAt: target.startedAt.toISOString(),
          closedAt: closedAt.toISOString(),
          durationMs: Math.max(0, closedAt.getTime() - target.startedAt.getTime()),
          agentRuns: [...target.agentRuns].map(([agentRunId, agentRun]) => ({
            agentRunId,
            agentRef: agentRun.agentRef,
            registeredAt: target.startedAt.toISOString(),
            endedAt: closedAt.toISOString(),
            rounds: agentRun.modelCalls,
          })),
          units: {
            submitted,
            ok,
            rejected,
            failed,
            notDelivered: submitted - ok - rejected - failed,
          },
          model: {
            requests: [...target.agentRuns.values()].reduce(
              (sum, item) => sum + item.modelCalls,
              0,
            ),
            finalCallUsed: false,
          },
          tokens: {
            limit: deps.config.budget.tokenLimit,
            used: 0,
            unknown: 0,
            inputTokens: 0,
            outputTokens: 0,
            finalBudgetState: 'NORMAL',
          },
          unknownEffects: [],
        } as RunSummary;
        const runSummaryRef = await store(target, MEDIA_TYPES.runSummary, canonicalJson(summary));
        const end = { closeReason, ...outcome, unknownEffects: [], runSummaryRef };
        emitWorkflow(target, { type: 'RunClosed', ...end } as RunClosed);
        emitInteraction(target, { type: 'RunFinished', ...end } as RunFinished);
      });
    }

    const submit = (target: FakeRun, request: SubmitUnitRequest): GatewayResponse => {
      const agentRun = target.agentRuns.get(request.agentRunId);
      if (agentRun === undefined) return reject(request.requestId, 'AGENT_RUN_NOT_FOUND');
      const unit = agentRun.pinned.units.find(
        (candidate) =>
          candidate.id === request.unitRef.id &&
          candidate.version === request.unitRef.version &&
          candidate.digest === request.unitRef.digest,
      );
      if (unit === undefined) return reject(request.requestId, 'FORBIDDEN');
      if (['FILE_WRITE', 'COMMAND', 'TEST'].includes(unit.executionKind))
        return reject(request.requestId, 'UNSUPPORTED_CAPABILITY');
      const index = target.units.submitted;
      target.units.submitted += 1;
      const mustAsk = unit.protectedCapabilities.length > 0 && options.authorization === 'ASK';
      if (mustAsk && target.authorization === 'NOT_ASKED') {
        target.authorization = 'PENDING';
        target.questionId = newId('qst');
        emitInteraction(target, {
          type: 'AuthorizationRequest',
          questionId: target.questionId,
          capability: 'repo.read',
          repositoryPath: target.repositoryPath,
          exclusions: [...deps.config.repositoryExclusions],
          provider: deps.config.provider,
          expiresAt: new Date(now().getTime() + deps.config.authorizationTimeoutMs).toISOString(),
        });
      }
      if (mustAsk && target.authorization === 'PENDING')
        target.waiting.push({ request, unit, index });
      else report(target, request, unit, index);
      return ack(request.requestId);
    };

    const handle = async (
      forward: GatewayForward,
      correlationId: string,
    ): Promise<GatewayResponse> => {
      const { request } = forward;
      if (forward.requestType === 'createRun') {
        if (run !== undefined || shuttingDown) return reject(request.requestId, 'RUN_LIMIT');
        run = {
          workflowRunId: forward.workflowRunId,
          correlationId,
          repositoryPath: forward.request.repositoryPath,
          startedAt: now(),
          closeReason: undefined,
          agentRuns: new Map(),
          artifacts: new Map(),
          seq: { workflow: 0, interaction: 0 },
          authorization: 'NOT_ASKED',
          questionId: undefined,
          waiting: [],
          units: { submitted: 0, ok: 0, rejected: 0, failed: 0 },
        };
        emitWorkflow(run, { type: 'RunStart', goal: forward.request.goal });
        return {
          requestId: request.requestId,
          outcome: 'ACCEPTED',
          workflowRunId: run.workflowRunId,
        };
      }
      if (forward.requestType === 'shutdown') {
        shuttingDown = true;
        if (run !== undefined) finish(run, 'CANCELLED');
        later(async () => {
          await Promise.all([toWorkflow.flushed(), toInteraction.flushed()]);
          await supervisor.shutdown({ requestId: request.requestId });
        });
        return ack(request.requestId);
      }
      const target = run;
      if (target === undefined || target.workflowRunId !== forward.request.workflowRunId)
        return reject(request.requestId, 'RUN_NOT_FOUND');
      switch (forward.requestType) {
        case 'registerAgentRun': {
          if (target.closeReason !== undefined)
            return blocked(request.requestId, target.closeReason);
          if (target.agentRuns.has(forward.request.agentRunId))
            return reject(request.requestId, 'AGENT_RUN_EXISTS');
          const { agentRef } = forward.request;
          const pinned = await deps.catalog.pinAgent(
            { id: agentRef.id, version: agentRef.version },
            contextOf(target.workflowRunId),
          );
          if (!pinned.ok) return reject(request.requestId, 'DEFINITION_UNAVAILABLE');
          if (pinned.value.agent.digest !== agentRef.digest)
            return reject(request.requestId, 'DEFINITION_MISMATCH');
          target.agentRuns.set(forward.request.agentRunId, {
            agentRef,
            pinned: pinned.value,
            modelCalls: 0,
          });
          return ack(request.requestId);
        }
        case 'submitUnit':
          if (target.closeReason !== undefined)
            return blocked(request.requestId, target.closeReason);
          return submit(target, forward.request);
        case 'endAgentRun':
          return target.agentRuns.has(forward.request.agentRunId)
            ? ack(request.requestId)
            : reject(request.requestId, 'AGENT_RUN_NOT_FOUND');
        case 'closeRun':
          if (target.closeReason !== undefined) return ack(request.requestId);
          if (forward.request.outcome === 'FAILED')
            finish(target, 'FAILED', { failure: forward.request.failure });
          else if (!target.artifacts.has(forward.request.reportRef.artifactId))
            return reject(request.requestId, 'INVALID_ARTIFACT_REF');
          else finish(target, 'COMPLETED', { reportRef: forward.request.reportRef });
          return ack(request.requestId);
        case 'cancelRun':
          finish(target, 'CANCELLED');
          return ack(request.requestId);
        case 'answerAuthorization': {
          if (
            target.authorization !== 'PENDING' ||
            target.questionId !== forward.request.questionId
          )
            return reject(request.requestId, 'QUESTION_NOT_PENDING');
          const granted = forward.request.answer === 'YES';
          target.authorization = granted ? 'GRANTED' : 'DECLINED';
          emitInteraction(target, {
            type: 'AuthorizationResolved',
            questionId: forward.request.questionId,
            resolution: granted ? 'GRANTED' : 'DECLINED',
          });
          for (const waiting of target.waiting.splice(0))
            report(target, waiting.request, waiting.unit, waiting.index);
          return ack(request.requestId);
        }
        case 'readArtifact': {
          const text = await readText(target, forward.request.ref);
          const ref = target.artifacts.get(forward.request.ref.artifactId);
          if (text === undefined || ref === undefined)
            return reject(request.requestId, 'INVALID_ARTIFACT_REF');
          return { requestId: request.requestId, outcome: 'ACCEPTED', ref, text };
        }
      }
    };

    return lifecycle('kernel-core', ['fabric', 'artifact-store', 'persistence'], {
      start: () => {
        deps.fabric.register<GatewayForward, GatewayResponse>(
          SCHEMA_IDS.gatewayForward,
          (envelope) => handle(envelope.payload, envelope.correlationId),
        );
        serveExecutionFacts(deps.fabric, {
          report: (fact) => {
            awaitedFacts.get(fact.executionId)?.(fact);
            awaitedFacts.delete(fact.executionId);
            return Promise.resolve();
          },
        });
        return Promise.resolve();
      },
      stop: async () => {
        await work;
        await Promise.all([toWorkflow.flushed(), toInteraction.flushed()]);
        if (faults.length > 0) throw new AggregateError(faults, 'The fake Kernel core hit errors');
      },
    });
  };
}

function lifecycle(
  moduleId: LifecyclePort['manifest']['moduleId'],
  dependencies: LifecyclePort['manifest']['dependencies'],
  hooks: { start?: () => Promise<void>; stop?: () => Promise<void> },
): LifecyclePort {
  return {
    manifest: { moduleId, version: '0.0.0-fake', dependencies },
    start: hooks.start ?? (() => Promise.resolve()),
    stop: hooks.stop ?? (() => Promise.resolve()),
    health: () =>
      Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: ['fake'] }),
  };
}
