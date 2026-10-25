import {
  newId,
  type AdmissionProjection,
  type CancelRunExecutionsRequest,
  type ExecutionRequest,
  type InteractionInboxEvent,
  type InteractionInboxPort,
  type KernelToInteractionEvent,
  type KernelToWorkflowEvent,
  type SupervisorPort,
  type WorkflowInboxEvent,
  type WorkflowInboxPort,
} from '@multiagentos/contracts';
import { OrderedSender } from '@multiagentos/fabric';
import type { CoreEvent, CoreEventSink, CoreSupervisorPort } from '../core/index.js';
import type { AttemptDispatcher } from '../execution/index.js';

/** The four cross-subject targets of the run egress. */
export type RunSendTarget = 'supervisor' | 'gateway' | 'workflow' | 'user-interaction';

/** One failed delivery, including whether it was a terminal event. */
export interface RunSendFailure {
  readonly target: RunSendTarget;
  readonly error: unknown;
  /** RunClosed/RunFinished failures are recorded, never turned into KERNEL_FAULT. */
  readonly terminal: boolean;
}

/** The actor uses these callbacks to drive timers without seeing Core internals. */
export interface RunEgressObserver {
  onEvent(event: CoreEvent): void;
  onAdmission(projection: AdmissionProjection): void;
}

export type RunEgressFailureHandler = (failure: RunSendFailure) => void;

type SupervisorSend =
  | { readonly kind: 'execute'; readonly request: ExecutionRequest }
  | { readonly kind: 'cancelRun'; readonly request: CancelRunExecutionsRequest };

export interface RunEgressDeps {
  readonly workflowRunId: string;
  readonly supervisor: SupervisorPort;
  /** Sends `AdmissionProjection` to Gateway's `gateway.admission` address. */
  readonly gatewayAdmission: (projection: AdmissionProjection) => Promise<void>;
  readonly workflowInbox: WorkflowInboxPort;
  readonly interactionInbox: InteractionInboxPort;
  readonly now?: () => Date;
  readonly newEventId?: () => string;
  readonly onFailure?: RunEgressFailureHandler;
}

/**
 * Collects Core events and cross-subject requests during one message handling, then exposes
 * them to the actor's flush step. Nothing is handed to an OrderedSender until `flush()`, so a
 * handler cannot send before the actor has finished processing and settling the message.
 */
export class RunEgress implements CoreEventSink, AttemptDispatcher, CoreSupervisorPort {
  readonly #workflowRunId: string;
  readonly #now: () => Date;
  readonly #newEventId: () => string;
  #failureHandler: RunEgressFailureHandler | undefined;
  #observer: RunEgressObserver | undefined;
  readonly #pendingSupervisor: SupervisorSend[] = [];
  readonly #pendingAdmission: AdmissionProjection[] = [];
  readonly #pendingWorkflow: WorkflowInboxEvent[] = [];
  readonly #pendingInteraction: InteractionInboxEvent[] = [];
  readonly #toSupervisor: OrderedSender<SupervisorSend>;
  readonly #toGateway: OrderedSender<AdmissionProjection>;
  readonly #toWorkflow: OrderedSender<WorkflowInboxEvent>;
  readonly #toInteraction: OrderedSender<InteractionInboxEvent>;
  #workflowSeq = 0;
  #interactionSeq = 0;

  public constructor(deps: RunEgressDeps) {
    this.#workflowRunId = deps.workflowRunId;
    this.#now = deps.now ?? (() => new Date());
    this.#newEventId = deps.newEventId ?? (() => newId('evt'));
    this.#failureHandler = deps.onFailure;
    this.#toSupervisor = new OrderedSender(
      (item) =>
        item.kind === 'execute'
          ? deps.supervisor.execute(item.request)
          : deps.supervisor.cancelRun(item.request),
      (error) => this.#reportFailure('supervisor', error, false),
    );
    this.#toGateway = new OrderedSender(deps.gatewayAdmission, (error) =>
      this.#reportFailure('gateway', error, false),
    );
    this.#toWorkflow = new OrderedSender(
      (event) => deps.workflowInbox.deliver(event),
      (error, event) => this.#reportFailure('workflow', error, event.event.type === 'RunClosed'),
    );
    this.#toInteraction = new OrderedSender(
      (event) => deps.interactionInbox.deliver(event),
      (error, event) =>
        this.#reportFailure('user-interaction', error, event.event.type === 'RunFinished'),
    );
  }

  /** The actor attaches its timers here; egress stays unaware of timer implementation. */
  public setObserver(observer: RunEgressObserver | undefined): void {
    this.#observer = observer;
  }

  /** The actor attaches its fault handler here; 4.4 turns non-terminal failures into KERNEL_FAULT. */
  public setFailureHandler(handler: RunEgressFailureHandler | undefined): void {
    this.#failureHandler = handler;
  }

  /** CoreEventSink: queues an event under the receiver's sequence. */
  public emit(event: CoreEvent): void {
    const occurredAt = this.#now().toISOString();
    if (isWorkflowEvent(event)) {
      this.#pendingWorkflow.push({
        eventId: this.#newEventId(),
        workflowRunId: this.#workflowRunId,
        seq: (this.#workflowSeq += 1),
        occurredAt,
        event,
      });
      this.#observer?.onEvent(event);
      return;
    }
    this.#pendingInteraction.push({
      eventId: this.#newEventId(),
      workflowRunId: this.#workflowRunId,
      seq: (this.#interactionSeq += 1),
      occurredAt,
      event,
    });
    this.#observer?.onEvent(event);
  }

  /** AttemptDispatcher: queues Supervisor.execute instead of sending it inside a handler. */
  public dispatch(request: ExecutionRequest): void {
    this.#pendingSupervisor.push({ kind: 'execute', request });
  }

  /** CoreSupervisorPort: queues Supervisor.cancelRun after any earlier execute. */
  public cancelRun(request: CancelRunExecutionsRequest): Promise<void> {
    this.#pendingSupervisor.push({ kind: 'cancelRun', request });
    return Promise.resolve();
  }

  /** Core admission callback: queues Gateway's admission projection. */
  public admission(projection: AdmissionProjection): void {
    this.#pendingAdmission.push(projection);
    this.#observer?.onAdmission(projection);
  }

  /** Hands everything registered during the message to the target senders. */
  public flush(): void {
    for (const item of this.#pendingSupervisor.splice(0)) this.#toSupervisor.enqueue(item);
    for (const projection of this.#pendingAdmission.splice(0)) this.#toGateway.enqueue(projection);
    for (const event of this.#pendingWorkflow.splice(0)) this.#toWorkflow.enqueue(event);
    for (const event of this.#pendingInteraction.splice(0)) this.#toInteraction.enqueue(event);
  }

  /** Waits until every message flushed so far has been sent or reported as failed. */
  public async drain(): Promise<void> {
    this.flush();
    await Promise.all([
      this.#toSupervisor.flushed(),
      this.#toGateway.flushed(),
      this.#toWorkflow.flushed(),
      this.#toInteraction.flushed(),
    ]);
  }

  #reportFailure(target: RunSendTarget, error: unknown, terminal: boolean): void {
    this.#failureHandler?.({ target, error, terminal });
  }
}

function isWorkflowEvent(event: CoreEvent): event is KernelToWorkflowEvent {
  return event.type === 'RunStart' || event.type === 'UnitReport' || event.type === 'RunClosed';
}

export type { KernelToInteractionEvent, KernelToWorkflowEvent };
