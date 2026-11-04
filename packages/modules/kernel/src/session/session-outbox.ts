import {
  newId,
  type InteractionInboxEvent,
  type InteractionSessionEvent,
  type InteractionSystemEvent,
  type KernelToInteractionEvent,
  type KernelToWorkflowEvent,
  type SessionCommand,
  type WorkflowInboxEvent,
  type WorkflowSessionEvent,
  type WorkflowSystemEvent,
} from '@multiagentos/contracts';
import { OrderedSender } from '@multiagentos/fabric';

export type ToWorkflow = WorkflowInboxEvent | WorkflowSessionEvent | WorkflowSystemEvent;
export type ToInteraction =
  InteractionInboxEvent | InteractionSessionEvent | InteractionSystemEvent;

export interface OutboundPort {
  toWorkflow(event: ToWorkflow): Promise<void>;
  toInteraction(event: ToInteraction): Promise<void>;
}

export type SendFailureHandler = (error: unknown, target: 'workflow' | 'user-interaction') => void;

interface SessionCounters {
  workflow: number;
  interaction: number;
}

/**
 * The run, Session and system sequences of Interface 4. Each has its own `seq`, but they share one
 * ordered sender per receiver, so delivery follows registration: SessionOpened always reaches the
 * receiver before the RunStart of that Session. Nothing leaves until `flush`, which the actor calls
 * once a message has been handled.
 */
export class KernelOutbox {
  readonly #now: () => Date;
  readonly #pendingWorkflow: ToWorkflow[] = [];
  readonly #pendingInteraction: ToInteraction[] = [];
  readonly #workflow: OrderedSender<ToWorkflow>;
  readonly #interaction: OrderedSender<ToInteraction>;
  readonly #sessions = new Map<string, SessionCounters>();
  readonly #runs = new Map<string, SessionCounters>();
  #systemWorkflow = 0;
  #systemInteraction = 0;

  public constructor(port: OutboundPort, onFailure: SendFailureHandler, now: () => Date) {
    this.#now = now;
    this.#workflow = new OrderedSender(
      (event) => port.toWorkflow(event),
      (error) => onFailure(error, 'workflow'),
    );
    this.#interaction = new OrderedSender(
      (event) => port.toInteraction(event),
      (error) => onFailure(error, 'user-interaction'),
    );
  }

  #stamp() {
    return { eventId: newId('evt'), occurredAt: this.#now().toISOString() };
  }

  static #counters(map: Map<string, SessionCounters>, key: string): SessionCounters {
    const counters = map.get(key) ?? { workflow: 0, interaction: 0 };
    map.set(key, counters);
    return counters;
  }

  runToWorkflow(sessionId: string, workflowRunId: string, event: KernelToWorkflowEvent): void {
    const counters = KernelOutbox.#counters(this.#runs, workflowRunId);
    counters.workflow += 1;
    this.#pendingWorkflow.push({
      ...this.#stamp(),
      sessionId,
      workflowRunId,
      seq: counters.workflow,
      event,
    });
  }

  runToInteraction(
    sessionId: string,
    workflowRunId: string,
    event: KernelToInteractionEvent,
  ): void {
    const counters = KernelOutbox.#counters(this.#runs, workflowRunId);
    counters.interaction += 1;
    this.#pendingInteraction.push({
      ...this.#stamp(),
      sessionId,
      workflowRunId,
      seq: counters.interaction,
      event,
    });
  }

  sessionToWorkflow(sessionId: string, event: SessionCommand): void {
    const counters = KernelOutbox.#counters(this.#sessions, sessionId);
    counters.workflow += 1;
    this.#pendingWorkflow.push({ ...this.#stamp(), sessionId, seq: counters.workflow, event });
  }

  sessionToInteraction(sessionId: string, event: InteractionSessionEvent['event']): void {
    const counters = KernelOutbox.#counters(this.#sessions, sessionId);
    counters.interaction += 1;
    this.#pendingInteraction.push({
      ...this.#stamp(),
      sessionId,
      seq: counters.interaction,
      event,
    });
  }

  systemToWorkflow(event: WorkflowSystemEvent['event']): void {
    this.#systemWorkflow += 1;
    this.#pendingWorkflow.push({ ...this.#stamp(), seq: this.#systemWorkflow, event });
  }

  systemToInteraction(event: InteractionSystemEvent['event']): void {
    this.#systemInteraction += 1;
    this.#pendingInteraction.push({ ...this.#stamp(), seq: this.#systemInteraction, event });
  }

  flush(): void {
    for (const event of this.#pendingWorkflow.splice(0)) this.#workflow.enqueue(event);
    for (const event of this.#pendingInteraction.splice(0)) this.#interaction.enqueue(event);
  }

  async drained(): Promise<void> {
    this.flush();
    await Promise.all([this.#workflow.flushed(), this.#interaction.flushed()]);
  }
}
