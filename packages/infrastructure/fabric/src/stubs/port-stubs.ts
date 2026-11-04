import type {
  BoundaryContext,
  CancelRunExecutionsRequest,
  ExecutionFact,
  ExecutionRequest,
  FabricPort,
  InteractionGatewayPort,
  InteractionInboxEvent,
  InteractionSessionEvent,
  InteractionSystemEvent,
  SupervisorShutdownRequest,
  WorkflowGatewayPort,
  WorkflowInboxEvent,
  WorkflowSessionEvent,
  WorkflowSystemEvent,
} from '@multiagentos/contracts';

/**
 * Typed Port stubs over one subject's Fabric client (Interface 4). The composition root builds
 * them, so each subject can only call and serve what its Port allows.
 */

/** Schema IDs of the Fabric routes (Interface 4). */
export const SCHEMA_IDS = {
  registerAgentRun: 'kernel.unit.RegisterAgentRunRequest.v1',
  submitUnit: 'kernel.unit.SubmitUnitRequest.v1',
  endAgentRun: 'kernel.unit.EndAgentRunRequest.v1',
  closeRun: 'kernel.unit.CloseRunRequest.v1',
  requestHuman: 'kernel.unit.RequestHumanRequest.v1',
  readProjectFile: 'kernel.unit.ReadProjectFileRequest.v1',
  reportSessionCommand: 'kernel.unit.ReportSessionCommandRequest.v1',
  reportSessionList: 'kernel.unit.ReportSessionListRequest.v1',
  startSession: 'kernel.control.StartSessionRequest.v1',
  openSession: 'kernel.control.OpenSessionRequest.v1',
  startRun: 'kernel.control.StartRunRequest.v1',
  listSessions: 'kernel.control.ListSessionsRequest.v1',
  deleteSession: 'kernel.control.DeleteSessionRequest.v1',
  answerAuthorization: 'kernel.control.AnswerAuthorizationRequest.v1',
  undoTurns: 'kernel.control.UndoTurnsRequest.v1',
  confirmUndo: 'kernel.control.ConfirmUndoRequest.v1',
  diffTurns: 'kernel.control.DiffTurnsRequest.v1',
  updateActivity: 'kernel.unit.UpdateActivityRequest.v1',
  answerHuman: 'kernel.control.AnswerHumanRequest.v1',
  readArtifact: 'kernel.control.ReadArtifactRequest.v1',
  shutdown: 'kernel.control.ShutdownRequest.v1',
  gatewayForward: 'kernel.control.GatewayForward.v1',
  admissionProjection: 'kernel.control.AdmissionProjection.v1',
  sessionProjection: 'kernel.control.SessionProjection.v1',
  execute: 'kernel.execution.ExecutionRequest.v1',
  cancelRunExecutions: 'kernel.execution.CancelRunExecutionsRequest.v1',
  supervisorShutdown: 'kernel.execution.SupervisorShutdownRequest.v1',
  executionFact: 'kernel.execution.ExecutionFact.v1',
  workflowRunEvent: 'kernel.unit.WorkflowInboxEvent.v1',
  workflowSessionEvent: 'kernel.session.WorkflowSessionEvent.v1',
  workflowSystemEvent: 'kernel.session.WorkflowSystemEvent.v1',
  interactionRunEvent: 'kernel.control.InteractionInboxEvent.v1',
  interactionSessionEvent: 'kernel.session.InteractionSessionEvent.v1',
  interactionSystemEvent: 'kernel.session.InteractionSystemEvent.v1',
} as const;

/** The syscalls Gateway serves, by the subject allowed to call them (Kernel/Gateway 3). */
export const WORKFLOW_SYSCALLS = [
  'registerAgentRun',
  'submitUnit',
  'endAgentRun',
  'closeRun',
  'requestHuman',
  'readProjectFile',
  'updateActivity',
  'reportSessionCommand',
  'reportSessionList',
] as const satisfies readonly (keyof WorkflowGatewayPort)[];
export const INTERACTION_SYSCALLS = [
  'startSession',
  'openSession',
  'startRun',
  'listSessions',
  'deleteSession',
  'answerAuthorization',
  'answerHuman',
  'readArtifact',
  'undoTurns',
  'confirmUndo',
  'diffTurns',
  'shutdown',
] as const satisfies readonly (keyof InteractionGatewayPort)[];

/** Schema IDs only Gateway may serve with an invalid-body callback. */
export const GATEWAY_SYSCALL_SCHEMAS: ReadonlySet<string> = new Set(
  [...WORKFLOW_SYSCALLS, ...INTERACTION_SYSCALLS].map((name) => SCHEMA_IDS[name]),
);

/** For Workflow: its syscalls, sent to Gateway. */
export function createWorkflowGatewayPort(fabric: FabricPort): WorkflowGatewayPort {
  const port = Object.fromEntries(
    WORKFLOW_SYSCALLS.map((name) => [
      name,
      (request: unknown, context: BoundaryContext) =>
        fabric.request(SCHEMA_IDS[name], request, context),
    ]),
  );
  return port as unknown as WorkflowGatewayPort;
}

/** For UserInteraction: its requests, sent to Gateway. */
export function createInteractionGatewayPort(fabric: FabricPort): InteractionGatewayPort {
  const port = Object.fromEntries(
    INTERACTION_SYSCALLS.map((name) => [
      name,
      (request: unknown, context: BoundaryContext) =>
        fabric.request(SCHEMA_IDS[name], request, context),
    ]),
  );
  return port as unknown as InteractionGatewayPort;
}

/** What a receiver of Kernel events handles: one handler per sequence (Fabric 3). */
export interface WorkflowInbox {
  handleRunEvent(event: WorkflowInboxEvent): Promise<void>;
  handleSessionEvent(event: WorkflowSessionEvent): Promise<void>;
  handleSystemEvent(event: WorkflowSystemEvent): Promise<void>;
}
export interface InteractionInbox {
  handleRunEvent(event: InteractionInboxEvent): Promise<void>;
  handleSessionEvent(event: InteractionSessionEvent): Promise<void>;
  handleSystemEvent(event: InteractionSystemEvent): Promise<void>;
}

export type ToWorkflowEvent = WorkflowInboxEvent | WorkflowSessionEvent | WorkflowSystemEvent;
export type ToInteractionEvent =
  InteractionInboxEvent | InteractionSessionEvent | InteractionSystemEvent;

/** The context of an event follows the sequence it belongs to. */
const eventContext = (event: object, correlationId: string): BoundaryContext => ({
  correlationId,
  tenantId: 'local',
  projectId: 'local',
  ...('sessionId' in event ? { sessionId: event.sessionId as string } : {}),
  ...('workflowRunId' in event ? { workflowRunId: event.workflowRunId as string } : {}),
});

const sequenceOf = (event: object): 'run' | 'session' | 'system' =>
  'workflowRunId' in event ? 'run' : 'sessionId' in event ? 'session' : 'system';

/** For the Kernel core: sends one event to Workflow on the schema of its sequence. */
export function createWorkflowEventSender(
  fabric: FabricPort,
  correlationOf: (event: ToWorkflowEvent) => string,
): (event: ToWorkflowEvent) => Promise<void> {
  const schemas = {
    run: SCHEMA_IDS.workflowRunEvent,
    session: SCHEMA_IDS.workflowSessionEvent,
    system: SCHEMA_IDS.workflowSystemEvent,
  } as const;
  return (event) =>
    fabric.send(
      'inbox.workflow',
      schemas[sequenceOf(event)],
      event,
      eventContext(event, correlationOf(event)),
    );
}

/** For the Kernel core: sends one event to UserInteraction on the schema of its sequence. */
export function createInteractionEventSender(
  fabric: FabricPort,
  correlationOf: (event: ToInteractionEvent) => string,
): (event: ToInteractionEvent) => Promise<void> {
  const schemas = {
    run: SCHEMA_IDS.interactionRunEvent,
    session: SCHEMA_IDS.interactionSessionEvent,
    system: SCHEMA_IDS.interactionSystemEvent,
  } as const;
  return (event) =>
    fabric.send(
      'inbox.user-interaction',
      schemas[sequenceOf(event)],
      event,
      eventContext(event, correlationOf(event)),
    );
}

/**
 * The receiving side of the three sequences (Fabric 3): a repeated `eventId` is dropped, and a
 * `seq` that does not follow the last one of its sequence is a fault of the sender.
 */
class SequenceCheck {
  readonly #seen = new Set<string>();
  readonly #last = new Map<string, number>();

  /** False when the event was delivered before. */
  accept(event: { readonly eventId: string; readonly seq: number }): boolean {
    if (this.#seen.has(event.eventId)) return false;
    const key = `${sequenceOf(event)}:${eventScope(event)}`;
    const expected = (this.#last.get(key) ?? 0) + 1;
    if (event.seq !== expected)
      throw new Error(
        `Event sequence ${key} expected seq ${String(expected)}, got ${String(event.seq)}`,
      );
    this.#seen.add(event.eventId);
    this.#last.set(key, event.seq);
    return true;
  }
}

const eventScope = (event: object): string =>
  'workflowRunId' in event
    ? String(event.workflowRunId)
    : 'sessionId' in event
      ? String(event.sessionId)
      : 'system';

/** For Workflow: receives its events from Fabric and hands each to its sequence's handler. */
export function serveWorkflowInbox(fabric: FabricPort, inbox: WorkflowInbox): void {
  const check = new SequenceCheck();
  fabric.subscribe<ToWorkflowEvent>('inbox.workflow', (envelope) => {
    if (envelope.producer !== 'kernel-core')
      throw new Error('A Workflow event has an invalid producer');
    const event = envelope.payload;
    if (!check.accept(event)) return Promise.resolve();
    switch (envelope.schemaName) {
      case 'kernel.unit.WorkflowInboxEvent':
        return inbox.handleRunEvent(event as WorkflowInboxEvent);
      case 'kernel.session.WorkflowSessionEvent':
        return inbox.handleSessionEvent(event as WorkflowSessionEvent);
      default:
        return inbox.handleSystemEvent(event as WorkflowSystemEvent);
    }
  });
}

/** For UserInteraction: receives its events from Fabric, by sequence. */
export function serveInteractionInbox(fabric: FabricPort, inbox: InteractionInbox): void {
  const check = new SequenceCheck();
  fabric.subscribe<ToInteractionEvent>('inbox.user-interaction', (envelope) => {
    if (envelope.producer !== 'kernel-core')
      throw new Error('A UserInteraction event has an invalid producer');
    const event = envelope.payload;
    if (!check.accept(event)) return Promise.resolve();
    switch (envelope.schemaName) {
      case 'kernel.control.InteractionInboxEvent':
        return inbox.handleRunEvent(event as InteractionInboxEvent);
      case 'kernel.session.InteractionSessionEvent':
        return inbox.handleSessionEvent(event as InteractionSessionEvent);
      default:
        return inbox.handleSystemEvent(event as InteractionSystemEvent);
    }
  });
}

/** What the Kernel core asks of the Supervisor. */
export interface SupervisorPort {
  execute(request: ExecutionRequest): Promise<void>;
  cancelRun(request: CancelRunExecutionsRequest): Promise<void>;
  shutdown(request: SupervisorShutdownRequest): Promise<void>;
}

/** For the Kernel core: the Supervisor it calls. */
export function createSupervisorPort(
  fabric: FabricPort,
  contextOf: (request: {
    readonly sessionId?: string;
    readonly workflowRunId?: string;
  }) => BoundaryContext,
): SupervisorPort {
  return {
    execute: (request) => fabric.request(SCHEMA_IDS.execute, request, contextOf(request)),
    cancelRun: (request) => fabric.request(SCHEMA_IDS.cancelRunExecutions, request, contextOf({})),
    shutdown: (request) => fabric.request(SCHEMA_IDS.supervisorShutdown, request, contextOf({})),
  };
}

/** For the Supervisor: reports execution facts to the Kernel core. */
export function createExecutionFactSink(
  fabric: FabricPort,
  contextOf: (fact: ExecutionFact) => BoundaryContext,
): { report(fact: ExecutionFact): Promise<void> } {
  return {
    report: (fact) =>
      fabric.send('kernel-core.execution-facts', SCHEMA_IDS.executionFact, fact, contextOf(fact)),
  };
}
