import type {
  BoundaryContext,
  ExecutionFact,
  ExecutionFactSink,
  FabricPort,
  InteractionGatewayPort,
  InteractionInboxEvent,
  InteractionInboxPort,
  SupervisorPort,
  WorkflowGatewayPort,
  WorkflowInboxEvent,
  WorkflowInboxPort,
} from '@multiagentos/contracts';

/**
 * Typed Port stubs over one subject's Fabric client (M1Interface 2.1 rule 3 and 2.2). The
 * composition root builds them, so each subject can only call and serve what its Port allows.
 */

/** Builds the BoundaryContext of a message that the Port signature does not carry. */
export type ContextOf = (workflowRunId: string | undefined) => BoundaryContext;

/** Schema IDs of the Fabric routes (M1Interface 2.2). */
export const SCHEMA_IDS = {
  registerAgentRun: 'kernel.unit.RegisterAgentRunRequest.v0',
  submitUnit: 'kernel.unit.SubmitUnitRequest.v0',
  endAgentRun: 'kernel.unit.EndAgentRunRequest.v0',
  closeRun: 'kernel.unit.CloseRunRequest.v0',
  createRun: 'kernel.control.CreateRunRequest.v0',
  answerAuthorization: 'kernel.control.AnswerAuthorizationRequest.v0',
  cancelRun: 'kernel.control.CancelRunRequest.v0',
  readArtifact: 'kernel.control.ReadArtifactRequest.v0',
  shutdown: 'kernel.control.ShutdownRequest.v0',
  gatewayForward: 'kernel.control.GatewayForward.v0',
  admissionProjection: 'kernel.control.AdmissionProjection.v0',
  execute: 'kernel.execution.ExecutionRequest.v0',
  cancelRunExecutions: 'kernel.execution.CancelRunExecutionsRequest.v0',
  supervisorShutdown: 'kernel.execution.SupervisorShutdownRequest.v0',
  executionFact: 'kernel.execution.ExecutionFact.v0',
  workflowInboxEvent: 'kernel.unit.WorkflowInboxEvent.v0',
  interactionInboxEvent: 'kernel.control.InteractionInboxEvent.v0',
} as const;

/** For Workflow: its four syscalls, sent to Gateway. */
export function createWorkflowGatewayPort(fabric: FabricPort): WorkflowGatewayPort {
  return {
    registerAgentRun: (request, context) =>
      fabric.request(SCHEMA_IDS.registerAgentRun, request, context),
    submitUnit: (request, context) => fabric.request(SCHEMA_IDS.submitUnit, request, context),
    endAgentRun: (request, context) => fabric.request(SCHEMA_IDS.endAgentRun, request, context),
    closeRun: (request, context) => fabric.request(SCHEMA_IDS.closeRun, request, context),
  };
}

/** For UserInteraction: its five requests, sent to Gateway. */
export function createInteractionGatewayPort(fabric: FabricPort): InteractionGatewayPort {
  return {
    createRun: (request, context) => fabric.request(SCHEMA_IDS.createRun, request, context),
    answerAuthorization: (request, context) =>
      fabric.request(SCHEMA_IDS.answerAuthorization, request, context),
    cancelRun: (request, context) => fabric.request(SCHEMA_IDS.cancelRun, request, context),
    readArtifact: (request, context) => fabric.request(SCHEMA_IDS.readArtifact, request, context),
    shutdown: (request, context) => fabric.request(SCHEMA_IDS.shutdown, request, context),
  };
}

/** For the Kernel core: delivers Outbox events to Workflow's Inbox. */
export function createWorkflowInboxSender(
  fabric: FabricPort,
  contextOf: ContextOf,
): WorkflowInboxPort {
  return {
    deliver: (event) =>
      fabric.send(
        'inbox.workflow',
        SCHEMA_IDS.workflowInboxEvent,
        event,
        contextOf(event.workflowRunId),
      ),
  };
}

/** For the Kernel core: delivers Outbox events to UserInteraction's Inbox. */
export function createInteractionInboxSender(
  fabric: FabricPort,
  contextOf: ContextOf,
): InteractionInboxPort {
  return {
    deliver: (event) =>
      fabric.send(
        'inbox.user-interaction',
        SCHEMA_IDS.interactionInboxEvent,
        event,
        contextOf(event.workflowRunId),
      ),
  };
}

/** For Workflow: receives its Inbox events from Fabric. */
export function serveWorkflowInbox(fabric: FabricPort, inbox: WorkflowInboxPort): void {
  fabric.subscribe<WorkflowInboxEvent>('inbox.workflow', (envelope) =>
    inbox.deliver(envelope.payload),
  );
}

/** For UserInteraction: receives its Inbox events from Fabric. */
export function serveInteractionInbox(fabric: FabricPort, inbox: InteractionInboxPort): void {
  fabric.subscribe<InteractionInboxEvent>('inbox.user-interaction', (envelope) =>
    inbox.deliver(envelope.payload),
  );
}

/** For the Kernel core: the SupervisorPort it calls. */
export function createSupervisorPort(fabric: FabricPort, contextOf: ContextOf): SupervisorPort {
  return {
    execute: (request) =>
      fabric.request(SCHEMA_IDS.execute, request, contextOf(request.workflowRunId)),
    cancelRun: (request) =>
      fabric.request(SCHEMA_IDS.cancelRunExecutions, request, contextOf(request.workflowRunId)),
    shutdown: (request) =>
      fabric.request(SCHEMA_IDS.supervisorShutdown, request, contextOf(undefined)),
  };
}

/** For the Supervisor: registers its three request handlers once Fabric is ready. */
export function serveSupervisor(fabric: FabricPort, supervisor: SupervisorPort): void {
  fabric.register(SCHEMA_IDS.execute, (envelope) =>
    supervisor.execute(envelope.payload as Parameters<SupervisorPort['execute']>[0]),
  );
  fabric.register(SCHEMA_IDS.cancelRunExecutions, (envelope) =>
    supervisor.cancelRun(envelope.payload as Parameters<SupervisorPort['cancelRun']>[0]),
  );
  fabric.register(SCHEMA_IDS.supervisorShutdown, (envelope) =>
    supervisor.shutdown(envelope.payload as Parameters<SupervisorPort['shutdown']>[0]),
  );
}

/** For the Supervisor: reports execution facts to the Kernel core. */
export function createExecutionFactSink(
  fabric: FabricPort,
  contextOf: ContextOf,
): ExecutionFactSink {
  return {
    report: (fact) =>
      fabric.send(
        'kernel-core.execution-facts',
        SCHEMA_IDS.executionFact,
        fact,
        contextOf(fact.workflowRunId),
      ),
  };
}

/** For the Kernel core: receives execution facts from Fabric. */
export function serveExecutionFacts(fabric: FabricPort, sink: ExecutionFactSink): void {
  fabric.subscribe<ExecutionFact>('kernel-core.execution-facts', (envelope) =>
    sink.report(envelope.payload),
  );
}
