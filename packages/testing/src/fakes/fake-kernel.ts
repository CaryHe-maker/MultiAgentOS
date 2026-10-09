import {
  MEDIA_TYPES,
  canonicalJson,
  newId,
  type AdmissionProjection,
  type ArtifactContent,
  type ArtifactRef,
  type BoundaryContext,
  type CloseReason,
  type Envelope,
  type GatewayForward,
  type InteractionInboxEvent,
  type KernelToInteractionEvent,
  type KernelToWorkflowEvent,
  type LifecyclePort,
  type PinnedDefinitionRef,
  type Producer,
  type RunClosed,
  type RunCreated,
  type RunFailure,
  type RunFinished,
  type RunSummary,
  type SubmitUnitRequest,
  type SyscallAck,
  type SyscallRejected,
  type UnitDefinition,
  type ExecutionResult,
  type WorkflowInboxEvent,
} from '@multiagentos/contracts';
import {
  OrderedSender,
  SCHEMA_IDS,
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
import {
  cannedAssemble,
  cannedFileRead,
  cannedModelCall,
  cannedOrient,
  cannedSearch,
  defaultModelScript,
  type ModelScript,
} from '../fixtures/canned.js';

/**
 * Kernel stand-in for Workflow and UserInteraction work. It follows the external behaviour of
 * docs/M1/Module/Kernel.md (one RunStart, one UnitReport per accepted submitUnit, one
 * RunClosed and RunFinished) but answers every Unit with a canned result at once. It has no
 * Lease, budget, timeout, retry, run actor or Executor, and it accepts whatever a Unit input
 * says: never use it to judge Kernel behaviour.
 */
export interface FakeKernelOptions {
  /** ASK sends one AuthorizationRequest before the first protected Unit; default GRANTED. */
  readonly authorization?: 'GRANTED' | 'ASK';
  readonly modelScript?: ModelScript;
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
            // Callers cannot know the run's correlationId, so Gateway stamps it.
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

/** Boots and stops the other modules through ModuleHost; it runs no Executor. */
export function createFakeSupervisor(): (deps: SupervisorDeps) => SupervisorModule {
  return ({ fabric, moduleHost }) => {
    let resolveStopped: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= moduleHost.stop().finally(resolveStopped);
      return stopping;
    };
    return {
      ...lifecycle('supervisor', [], {
        start: async () => {
          await moduleHost.start();
          serveSupervisor(fabric, {
            execute: () => Promise.resolve(),
            cancelRun: () => Promise.resolve(),
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

interface FakeRun {
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly repositoryPath: string;
  readonly startedAt: Date;
  closeReason: CloseReason | undefined;
  readonly agentRuns: Map<string, { agentRef: PinnedDefinitionRef; modelCalls: number }>;
  readonly artifacts: Map<string, ArtifactRef>;
  readonly seq: { workflow: number; interaction: number };
  authorization: 'NOT_ASKED' | 'PENDING' | 'GRANTED' | 'DECLINED';
  questionId: string | undefined;
  readonly waiting: { request: SubmitUnitRequest; unit: UnitDefinition }[];
  readonly units: { submitted: number; ok: number; rejected: number };
}

export function createFakeKernelCore(
  options: FakeKernelOptions = {},
): (deps: KernelCoreDeps) => LifecyclePort {
  return (deps) => {
    const now = deps.now ?? (() => new Date());
    const script = options.modelScript ?? defaultModelScript;
    let run: FakeRun | undefined;
    let shuttingDown = false;
    /** Work that needs I/O runs here one after another, so reports keep the submit order. */
    let work: Promise<void> = Promise.resolve();
    const later = (task: () => Promise<void>) => {
      work = work.then(task).catch((error: unknown) => {
        faults.push(error);
      });
    };
    const faults: unknown[] = [];
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
    const reject = (
      requestId: string,
      reasonCode: Exclude<SyscallRejected['reasonCode'], 'RUN_BLOCKED'>,
    ): SyscallRejected => ({ requestId, outcome: 'REJECTED', reasonCode, issuer: 'CORE' });
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

    const resultOf = (target: FakeRun, request: SubmitUnitRequest, unit: UnitDefinition) => {
      const input = request.input as Record<string, unknown>;
      switch (unit.executionKind) {
        case 'REPOSITORY_ORIENT':
          return cannedOrient(deps.config.budget.orientBudget);
        case 'REPOSITORY_SEARCH':
          return cannedSearch(deps.config.budget.searchBudget);
        case 'FILE_READ':
          return cannedFileRead({ path: String(input['path']) });
        case 'CONTEXT_ASSEMBLE':
          return cannedAssemble(String(input['objective']), deps.config.budget.perCallInputLimit);
        case 'MODEL': {
          const agentRun = target.agentRuns.get(request.agentRunId);
          const callIndex = agentRun?.modelCalls ?? 0;
          if (agentRun !== undefined) agentRun.modelCalls += 1;
          return cannedModelCall(
            script({ agentId: agentRun?.agentRef.id, callIndex, final: input['final'] === true }),
          );
        }
        default: {
          const report = input['report'] as {
            conclusions: unknown[];
            unconfirmed: unknown[];
            degraded: boolean;
          };
          const published: ExecutionResult = {
            output: {
              conclusionCount: report.conclusions.length,
              unconfirmedCount: report.unconfirmed.length,
              degraded: report.degraded,
            },
            artifact: { mediaType: MEDIA_TYPES.analysisReport, text: canonicalJson(report) },
          };
          return published;
        }
      }
    };

    const report = (target: FakeRun, request: SubmitUnitRequest, unit: UnitDefinition) => {
      const common = {
        type: 'UnitReport' as const,
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        unitRef: request.unitRef,
        executionKind: unit.executionKind,
        budgetState: 'NORMAL' as const,
      };
      if (unit.protectedCapabilities.length > 0 && target.authorization === 'DECLINED') {
        target.units.rejected += 1;
        emitWorkflow(target, { ...common, status: 'REJECTED', reasonCode: 'USER_DECLINED' });
        return;
      }
      later(async () => {
        const result = resultOf(target, request, unit);
        const artifact = result.artifact ?? { mediaType: MEDIA_TYPES.fileText, text: '' };
        const outputRef = await store(target, artifact.mediaType, artifact.text);
        if (target.closeReason !== undefined) return;
        target.units.ok += 1;
        emitWorkflow(target, {
          ...common,
          unitAttemptId: newId('una'),
          status: 'OK',
          output: result.output,
          outputRef,
        });
      });
    };

    const finish = (
      target: FakeRun,
      closeReason: CloseReason,
      outcome: { reportRef?: ArtifactRef; failure?: RunFailure } = {},
    ) => {
      if (target.closeReason !== undefined) return;
      target.closeReason = closeReason;
      if (target.authorization === 'PENDING' && target.questionId !== undefined)
        emitInteraction(target, {
          type: 'AuthorizationResolved',
          questionId: target.questionId,
          resolution: 'CANCELLED',
        });
      later(async () => {
        const closedAt = now();
        const summary: RunSummary = {
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
            submitted: target.units.submitted,
            ok: target.units.ok,
            rejected: target.units.rejected,
            failed: 0,
            notDelivered: target.units.submitted - target.units.ok - target.units.rejected,
          },
          model: { requests: 0, finalCallUsed: false },
          tokens: {
            limit: deps.config.budget.tokenLimit,
            used: 0,
            unknown: 0,
            inputTokens: 0,
            outputTokens: 0,
            finalBudgetState: 'NORMAL',
          },
          unknownEffects: [],
        };
        const runSummaryRef = await store(target, MEDIA_TYPES.runSummary, canonicalJson(summary));
        const end = { closeReason, ...outcome, unknownEffects: [], runSummaryRef };
        emitWorkflow(target, { type: 'RunClosed', ...end } as RunClosed);
        emitInteraction(target, { type: 'RunFinished', ...end } as RunFinished);
      });
    };

    const submit = async (
      target: FakeRun,
      request: SubmitUnitRequest,
    ): Promise<GatewayResponse> => {
      if (!target.agentRuns.has(request.agentRunId))
        return reject(request.requestId, 'AGENT_RUN_NOT_FOUND');
      const { id, version } = request.unitRef;
      const found = await deps.catalog.getDefinition(
        { kind: 'UNIT', id, version },
        contextOf(target.workflowRunId),
      );
      if (!found.ok || found.value.digest !== request.unitRef.digest)
        return reject(request.requestId, 'FORBIDDEN');
      const unit = found.value;
      if (['FILE_WRITE', 'COMMAND', 'TEST'].includes(unit.executionKind))
        return reject(request.requestId, 'UNSUPPORTED_CAPABILITY');
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
      if (mustAsk && target.authorization === 'PENDING') target.waiting.push({ request, unit });
      else report(target, request, unit);
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
          units: { submitted: 0, ok: 0, rejected: 0 },
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
        case 'registerAgentRun':
          if (target.closeReason !== undefined)
            return blocked(request.requestId, target.closeReason);
          if (target.agentRuns.has(forward.request.agentRunId))
            return reject(request.requestId, 'AGENT_RUN_EXISTS');
          target.agentRuns.set(forward.request.agentRunId, {
            agentRef: forward.request.agentRef,
            modelCalls: 0,
          });
          return ack(request.requestId);
        case 'submitUnit':
          if (target.closeReason !== undefined)
            return blocked(request.requestId, target.closeReason);
          return await submit(target, forward.request);
        case 'endAgentRun':
          return ack(request.requestId);
        case 'closeRun':
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
            report(target, waiting.request, waiting.unit);
          return ack(request.requestId);
        }
        case 'readArtifact': {
          const ref = target.artifacts.get(forward.request.ref.artifactId);
          if (ref === undefined) return reject(request.requestId, 'INVALID_ARTIFACT_REF');
          const content = await deps.artifacts.get(target.workflowRunId, ref);
          return {
            requestId: request.requestId,
            outcome: 'ACCEPTED',
            ref,
            text: Buffer.from(content).toString('utf8'),
          };
        }
      }
    };

    return lifecycle('kernel-core', ['fabric', 'artifact-store', 'persistence'], {
      start: () => {
        deps.fabric.register<GatewayForward, GatewayResponse>(
          SCHEMA_IDS.gatewayForward,
          (envelope) => handle(envelope.payload, envelope.correlationId),
        );
        serveExecutionFacts(deps.fabric, { report: () => Promise.resolve() });
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
