import {
  InteractionInboxEventV1Schema,
  InteractionSessionEventSchema,
  InteractionSystemEventSchema,
  MEDIA_TYPES,
  WorkflowInboxEventV1Schema,
  WorkflowSessionEventSchema,
  WorkflowSystemEventSchema,
  assertValid,
  newId,
  sha256Hex,
  type ArtifactContent,
  type ArtifactRef,
  type DefinitionRef,
  type InteractionGatewayPortV1,
  type InteractionInboxEventV1,
  type InteractionSessionEvent,
  type InteractionSystemEvent,
  type KernelToInteractionEventV1,
  type KernelToWorkflowEventV1,
  type ProjectFileContent,
  type SessionCommand,
  type SubmitUnitRequestV1,
  type SyscallAck,
  type SyscallRejectedV1,
  type UnitReportV1,
  type WorkflowGatewayPortV1,
  type WorkflowInboxEventV1,
  type WorkflowSessionEvent,
  type WorkflowSystemEvent,
} from '@multiagentos/contracts';

/**
 * Kernel stand-in at the port level for Workflow and UserInteraction work on major 1. It follows
 * the external behaviour of Interface/WorkflowKernel and Interface/InteractionKernel: Sessions,
 * Turns, HUMAN requests and the run, Session and system event sequences. It has no Lease, ledger,
 * attempt or Fabric, so never use it to judge Kernel behaviour. Every event is validated against
 * its Schema before it is delivered.
 */
export type FakeUnitScript = (
  request: SubmitUnitRequestV1,
  index: number,
) =>
  | Pick<
      Extract<UnitReportV1, { status: 'OK' }>,
      'output' | 'outputRef' | 'fullRef' | 'reasoningRef'
    >
  | {
      readonly reject: Exclude<
        Extract<UnitReportV1, { status: 'REJECTED' }>['reasonCode'],
        'QUOTA_EXHAUSTED'
      >;
    }
  | { readonly quota: Extract<UnitReportV1, { reasonCode: 'QUOTA_EXHAUSTED' }>['quota'] }
  | { readonly fail: Extract<UnitReportV1, { status: 'FAILED' }>['reasonCode'] };

export interface FakeSessionKernelOptions {
  readonly repositoryRoot?: string;
  /** What each accepted submitUnit reports; without it every Unit is REJECTED as INTERNAL input. */
  readonly units?: FakeUnitScript;
  readonly projectFile?: (path: string) => Omit<ProjectFileContent, 'requestId' | 'outcome'>;
}

export interface FakeSessionKernel {
  readonly gateway: WorkflowGatewayPortV1;
  readonly interaction: InteractionGatewayPortV1;
  onWorkflow(listener: FakeWorkflowListener): void;
  onInteraction(listener: FakeInteractionListener): void;
  /** Every event delivered so far, in order. */
  readonly workflowEvents: readonly (
    WorkflowInboxEventV1 | WorkflowSessionEvent | WorkflowSystemEvent
  )[];
  readonly interactionEvents: readonly (
    InteractionInboxEventV1 | InteractionSessionEvent | InteractionSystemEvent
  )[];
  /** Waits until everything already triggered has been delivered. */
  idle(): Promise<void>;
}
export type FakeWorkflowListener = (
  event: WorkflowInboxEventV1 | WorkflowSessionEvent | WorkflowSystemEvent,
) => void | Promise<void>;
export type FakeInteractionListener = (
  event: InteractionInboxEventV1 | InteractionSessionEvent | InteractionSystemEvent,
) => void | Promise<void>;

interface Run {
  readonly sessionId: string;
  readonly workflowRunId: string;
  readonly activeAgentRuns: Set<string>;
  pendingUnits: number;
  turnId: string | undefined;
  pendingHuman: string | undefined;
  closed: boolean;
  workflowSeq: number;
  interactionSeq: number;
}

const ack = (requestId: string): SyscallAck => ({ requestId, outcome: 'ACCEPTED' });
const rejected = (
  requestId: string,
  reasonCode: Extract<SyscallRejectedV1, { issuer: 'CORE'; reasonCode: string }>['reasonCode'],
): SyscallRejectedV1 => ({ requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode });

const textRef = (text: string): ArtifactRef => {
  const content = new TextEncoder().encode(text);
  const sha256 = sha256Hex(content);
  return {
    artifactId: `art_${sha256}`,
    mediaType: MEDIA_TYPES.fileText,
    sha256,
    size: content.byteLength,
  };
};

export function createFakeSessionKernel(options: FakeSessionKernelOptions = {}): FakeSessionKernel {
  const repositoryRoot = options.repositoryRoot ?? '/repository';
  const workflowEvents: (WorkflowInboxEventV1 | WorkflowSessionEvent | WorkflowSystemEvent)[] = [];
  const interactionEvents: (
    InteractionInboxEventV1 | InteractionSessionEvent | InteractionSystemEvent
  )[] = [];
  const workflowListeners: FakeWorkflowListener[] = [];
  const interactionListeners: FakeInteractionListener[] = [];
  const artifacts = new Map<string, string>();
  const sessionSeq = new Map<string, { workflow: number; interaction: number }>();
  const commands = new Map<
    string,
    { sessionId: string; requestId: string; next: () => Promise<void> }
  >();
  const queries = new Map<string, string>();
  const deletions = new Map<string, { requestId: string; sessionId: string }>();
  const known = new Set<string>();
  let systemWorkflowSeq = 0;
  let systemInteractionSeq = 0;
  let run: Run | undefined;
  let unitIndex = 0;
  let queue: Promise<void> = Promise.resolve();

  const later = (work: () => Promise<void>): void => {
    queue = queue.then(work);
  };
  const now = (): string => new Date().toISOString();

  const toWorkflow = async (
    event: WorkflowInboxEventV1 | WorkflowSessionEvent | WorkflowSystemEvent,
  ) => {
    workflowEvents.push(event);
    for (const listener of workflowListeners) await listener(structuredClone(event));
  };
  const toInteraction = async (
    event: InteractionInboxEventV1 | InteractionSessionEvent | InteractionSystemEvent,
  ) => {
    interactionEvents.push(event);
    for (const listener of interactionListeners) await listener(structuredClone(event));
  };

  const seqOf = (sessionId: string) => {
    const seq = sessionSeq.get(sessionId) ?? { workflow: 0, interaction: 0 };
    sessionSeq.set(sessionId, seq);
    return seq;
  };
  const sessionCommand = async (sessionId: string, event: SessionCommand) => {
    const seq = seqOf(sessionId);
    seq.workflow += 1;
    await toWorkflow(
      assertValid<WorkflowSessionEvent>(WorkflowSessionEventSchema, {
        eventId: newId('evt'),
        sessionId,
        seq: seq.workflow,
        occurredAt: now(),
        event,
      }),
    );
  };
  const sessionEvent = async (sessionId: string, event: InteractionSessionEvent['event']) => {
    const seq = seqOf(sessionId);
    seq.interaction += 1;
    await toInteraction(
      assertValid<InteractionSessionEvent>(InteractionSessionEventSchema, {
        eventId: newId('evt'),
        sessionId,
        seq: seq.interaction,
        occurredAt: now(),
        event,
      }),
    );
  };
  const systemToWorkflow = async (event: WorkflowSystemEvent['event']) => {
    systemWorkflowSeq += 1;
    await toWorkflow(
      assertValid<WorkflowSystemEvent>(WorkflowSystemEventSchema, {
        eventId: newId('evt'),
        seq: systemWorkflowSeq,
        occurredAt: now(),
        event,
      }),
    );
  };
  const systemToInteraction = async (event: InteractionSystemEvent['event']) => {
    systemInteractionSeq += 1;
    await toInteraction(
      assertValid<InteractionSystemEvent>(InteractionSystemEventSchema, {
        eventId: newId('evt'),
        seq: systemInteractionSeq,
        occurredAt: now(),
        event,
      }),
    );
  };
  const runToWorkflow = async (current: Run, event: KernelToWorkflowEventV1) => {
    current.workflowSeq += 1;
    await toWorkflow(
      assertValid<WorkflowInboxEventV1>(WorkflowInboxEventV1Schema, {
        eventId: newId('evt'),
        sessionId: current.sessionId,
        workflowRunId: current.workflowRunId,
        seq: current.workflowSeq,
        occurredAt: now(),
        event,
      }),
    );
  };
  const runToInteraction = async (current: Run, event: KernelToInteractionEventV1) => {
    current.interactionSeq += 1;
    await toInteraction(
      assertValid<InteractionInboxEventV1>(InteractionInboxEventV1Schema, {
        eventId: newId('evt'),
        sessionId: current.sessionId,
        workflowRunId: current.workflowRunId,
        seq: current.interactionSeq,
        occurredAt: now(),
        event,
      }),
    );
  };

  const startRun = (sessionId: string): Run => {
    run = {
      sessionId,
      workflowRunId: newId('wfr'),
      activeAgentRuns: new Set(),
      pendingUnits: 0,
      turnId: undefined,
      pendingHuman: undefined,
      closed: false,
      workflowSeq: 0,
      interactionSeq: 0,
    };
    return run;
  };

  const store = (text: string): ArtifactRef => {
    const ref = textRef(text);
    artifacts.set(ref.artifactId, text);
    return ref;
  };

  const openTurn = async (
    current: Run,
    input: { inputId: string; text: string },
    origin: { origin: 'initial' } | { origin: 'requested'; humanRequestId: string },
    template?: DefinitionRef,
  ) => {
    current.turnId = newId('trn');
    await runToInteraction(current, {
      type: 'RunStateChanged',
      state: 'RUNNING',
      turnId: current.turnId,
    });
    await runToWorkflow(current, {
      type: 'HumanAnswered',
      kind: 'prompt',
      inputId: input.inputId,
      contentRef: store(input.text),
      turnId: current.turnId,
      ...(template === undefined ? {} : { template }),
      ...origin,
    });
  };

  const beginSession = (
    requestId: string,
    command: 'CREATE' | 'OPEN',
    sessionId: string,
    begin: () => Promise<void>,
  ): void => {
    const commandId = newId('scm');
    commands.set(commandId, { sessionId, requestId, next: begin });
    later(() =>
      sessionCommand(sessionId, { type: 'SessionCommand', commandId, command, repositoryRoot }),
    );
  };

  const closeTurn = async (current: Run) => {
    if (current.turnId === undefined) return;
    const turnId = current.turnId;
    current.turnId = undefined;
    await runToWorkflow(current, {
      type: 'TurnClosed',
      turnId,
      reason: 'COMPLETED',
      usage: { inputTokens: 0, outputTokens: 0, unknownTokens: 0, modelRequests: 0, toolUnits: 0 },
    });
  };

  const budget = { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' } as const;
  const deliverReport = async (current: Run, request: SubmitUnitRequestV1, index: number) => {
    const scripted = options.units?.(request, index) ?? { reject: 'INVALID_INPUT' as const };
    const common = {
      type: 'UnitReport' as const,
      requestId: request.requestId,
      agentRunId: request.agentRunId,
      unitRunId: request.unitRunId,
      unitRef: request.unitRef,
      executionKind:
        request.unitRef.id === 'repository-list'
          ? ('REPOSITORY_LIST' as const)
          : ('MODEL' as const),
      budget,
    };
    current.pendingUnits -= 1;
    const report =
      'reject' in scripted
        ? { ...common, status: 'REJECTED' as const, reasonCode: scripted.reject }
        : 'quota' in scripted
          ? {
              ...common,
              status: 'REJECTED' as const,
              reasonCode: 'QUOTA_EXHAUSTED' as const,
              quota: scripted.quota,
            }
          : 'fail' in scripted
            ? {
                ...common,
                unitAttemptId: newId('una'),
                status: 'FAILED' as const,
                reasonCode: scripted.fail,
              }
            : { ...common, unitAttemptId: newId('una'), status: 'OK' as const, ...scripted };
    await runToWorkflow(current, report);
    if ('input' in request && 'kind' in request.input && request.input.kind === 'REPLY') {
      await runToInteraction(current, {
        type: 'MessagePublished',
        messageRef: store('reply'),
        agentLabel: request.input.agentLabel,
        kind: 'REPLY',
      });
    }
  };

  const inRun = (workflowRunId: string): Run | undefined =>
    run?.workflowRunId === workflowRunId && !run.closed ? run : undefined;

  const gateway: WorkflowGatewayPortV1 = {
    registerAgentRun: (request) => {
      const current = inRun(request.workflowRunId);
      if (current?.turnId === undefined)
        return Promise.resolve(rejected(request.requestId, 'NO_OPEN_TURN'));
      current.activeAgentRuns.add(request.agentRunId);
      return Promise.resolve(ack(request.requestId));
    },
    submitUnit: (request) => {
      const current = inRun(request.workflowRunId);
      if (current?.turnId === undefined)
        return Promise.resolve(rejected(request.requestId, 'NO_OPEN_TURN'));
      current.pendingUnits += 1;
      const index = unitIndex;
      unitIndex += 1;
      later(() => deliverReport(current, request, index));
      return Promise.resolve(ack(request.requestId));
    },
    endAgentRun: (request) => {
      inRun(request.workflowRunId)?.activeAgentRuns.delete(request.agentRunId);
      return Promise.resolve(ack(request.requestId));
    },
    closeRun: (request) => {
      const current = inRun(request.workflowRunId);
      if (current === undefined)
        return Promise.resolve(rejected(request.requestId, 'RUN_NOT_FOUND'));
      current.closed = true;
      const ending = {
        unknownEffects: [],
        runSummaryRef: { ...textRef('summary'), mediaType: MEDIA_TYPES.runSummary },
        ...(request.outcome === 'FAILED'
          ? { closeReason: 'FAILED' as const, failure: request.failure }
          : { closeReason: request.outcome }),
      };
      later(async () => {
        await closeTurn(current);
        await runToWorkflow(current, {
          ...ending,
          type: 'RunClosed',
        } as unknown as KernelToWorkflowEventV1);
        await runToInteraction(current, {
          ...ending,
          type: 'RunFinished',
        } as unknown as KernelToInteractionEventV1);
      });
      return Promise.resolve(ack(request.requestId));
    },
    requestHuman: (request) => {
      const current = inRun(request.workflowRunId);
      if (current === undefined)
        return Promise.resolve(rejected(request.requestId, 'RUN_NOT_FOUND'));
      if (current.activeAgentRuns.size > 0 || current.pendingUnits > 0)
        return Promise.resolve(rejected(request.requestId, 'AGENT_RUN_ACTIVE'));
      current.pendingHuman = request.humanRequestId;
      later(async () => {
        await closeTurn(current);
        await runToInteraction(current, { type: 'RunStateChanged', state: 'AWAITING_INPUT' });
        await runToInteraction(current, {
          type: 'HumanRequest',
          humanRequestId: request.humanRequestId,
          kind: 'prompt',
        });
      });
      return Promise.resolve(ack(request.requestId));
    },
    readProjectFile: (request) =>
      Promise.resolve({
        requestId: request.requestId,
        outcome: 'ACCEPTED',
        ...(options.projectFile?.(request.path) ?? { path: request.path, exists: false }),
      } as ProjectFileContent),
    reportSessionCommand: (request) => {
      const command = commands.get(request.commandId);
      if (command === undefined)
        return Promise.resolve(rejected(request.requestId, 'SESSION_COMMAND_UNKNOWN'));
      commands.delete(request.commandId);
      const { result } = request;
      if (result.outcome === 'READY') {
        later(command.next);
      } else if (result.outcome === 'FAILED') {
        later(() =>
          sessionEvent(command.sessionId, {
            type: 'SessionFailed',
            requestId: command.requestId,
            code: result.failure.code,
          }),
        );
      }
      return Promise.resolve(ack(request.requestId));
    },
    reportSessionList: (request) => {
      const listRequest = queries.get(request.queryId);
      if (listRequest === undefined)
        return Promise.resolve(rejected(request.requestId, 'SESSION_QUERY_UNKNOWN'));
      queries.delete(request.queryId);
      later(() =>
        systemToInteraction({
          type: 'SessionList',
          requestId: listRequest,
          sessions: request.sessions
            .filter((entry) => entry.status === 'ACTIVE')
            .map(({ sessionId, createdAt, lastActiveAt, turnCount, fork }) => ({
              sessionId,
              createdAt,
              lastActiveAt,
              turnCount,
              ...(fork === undefined ? {} : { fork }),
            })),
        }),
      );
      return Promise.resolve(ack(request.requestId));
    },
  };

  const startNew = (
    requestId: string,
    prompt: { inputId: string; text: string },
    runStart: { mode: 'CHAT' } | { mode: 'ORCHESTRATION'; templateRef: DefinitionRef },
  ) => {
    const sessionId = newId('ses');
    known.add(sessionId);
    beginSession(requestId, 'CREATE', sessionId, async () => {
      const current = startRun(sessionId);
      await sessionEvent(sessionId, { type: 'SessionOpened', repositoryRoot, turnCount: 0 });
      await runToWorkflow(current, {
        type: 'RunStart',
        preset: 'standard',
        initialInput: true,
        ...runStart,
      });
      await openTurn(current, prompt, { origin: 'initial' });
    });
    return Promise.resolve({ requestId, outcome: 'ACCEPTED' as const, sessionId });
  };

  const interaction: InteractionGatewayPortV1 = {
    startSession: (request) => startNew(request.requestId, request.prompt, { mode: 'CHAT' }),
    startRun: (request) => {
      if (request.template.id !== 'analyze')
        return Promise.resolve(rejected(request.requestId, 'TEMPLATE_UNSUPPORTED'));
      return startNew(request.requestId, request.goal, {
        mode: 'ORCHESTRATION',
        templateRef: request.template,
      });
    },
    openSession: (request) => {
      if (!known.has(request.sessionId))
        return Promise.resolve(rejected(request.requestId, 'SESSION_NOT_FOUND'));
      beginSession(request.requestId, 'OPEN', request.sessionId, async () => {
        const current = startRun(request.sessionId);
        await sessionEvent(request.sessionId, {
          type: 'SessionOpened',
          repositoryRoot,
          turnCount: 0,
        });
        await runToWorkflow(current, {
          type: 'RunStart',
          mode: 'CHAT',
          preset: 'standard',
          initialInput: false,
        });
      });
      return Promise.resolve({
        requestId: request.requestId,
        outcome: 'ACCEPTED',
        sessionId: request.sessionId,
      });
    },
    listSessions: (request) => {
      const queryId = newId('slq');
      queries.set(queryId, request.requestId);
      later(() => systemToWorkflow({ type: 'SessionListQuery', queryId, repositoryRoot }));
      return Promise.resolve(ack(request.requestId));
    },
    deleteSession: (request) => {
      if (run?.sessionId === request.sessionId && !run.closed)
        return Promise.resolve(rejected(request.requestId, 'SESSION_IN_USE'));
      if (!known.has(request.sessionId))
        return Promise.resolve(rejected(request.requestId, 'SESSION_NOT_FOUND'));
      known.delete(request.sessionId);
      later(async () => {
        const commandId = newId('scm');
        deletions.set(commandId, { requestId: request.requestId, sessionId: request.sessionId });
        await systemToWorkflow({ type: 'SessionDelete', commandId, sessionId: request.sessionId });
        await systemToInteraction({
          type: 'SessionDeleted',
          requestId: request.requestId,
          sessionId: request.sessionId,
          outcome: 'DELETED',
        });
      });
      return Promise.resolve(ack(request.requestId));
    },
    answerAuthorization: (request) => Promise.resolve(ack(request.requestId)),
    answerHuman: (request) => {
      const current = inRun(request.workflowRunId);
      if (current?.pendingHuman !== request.humanRequestId)
        return Promise.resolve(rejected(request.requestId, 'HUMAN_REQUEST_NOT_PENDING'));
      current.pendingHuman = undefined;
      later(async () => {
        await runToInteraction(current, {
          type: 'HumanResolved',
          humanRequestId: request.humanRequestId,
          resolution: 'ANSWERED',
        });
        await openTurn(
          current,
          request.input,
          { origin: 'requested', humanRequestId: request.humanRequestId },
          request.template,
        );
      });
      return Promise.resolve(ack(request.requestId));
    },
    readArtifact: (request) => {
      const text = artifacts.get(request.ref.artifactId);
      if (text === undefined)
        return Promise.resolve(rejected(request.requestId, 'INVALID_ARTIFACT_REF'));
      const content: ArtifactContent = {
        requestId: request.requestId,
        outcome: 'ACCEPTED',
        ref: request.ref,
        text,
      };
      return Promise.resolve(content);
    },
    shutdown: (request) => Promise.resolve(ack(request.requestId)),
  };

  return {
    gateway,
    interaction,
    onWorkflow: (listener) => void workflowListeners.push(listener),
    onInteraction: (listener) => void interactionListeners.push(listener),
    workflowEvents,
    interactionEvents,
    idle: async () => {
      let seen: Promise<void> | undefined;
      while (seen !== queue) {
        seen = queue;
        await queue;
      }
    },
  };
}
