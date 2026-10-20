import type { BoundaryContext, ExecutionFact, GatewayForward } from '@multiagentos/contracts';
import { Inbox } from '@multiagentos/fabric';
import {
  runChannelOf,
  type RunChannel,
  type RunMessage,
  type RunResponse,
  type RunTimer,
} from './messages.js';

/**
 * The run-scoped work behind the actor. Stage 4.2 supplies a processor that drives
 * `CoreRequestHandler` and `Execution`; stage 4.1 only needs the message in, response out
 * contract and can be tested with a fake processor.
 */
export interface RunProcessor {
  dispatch(message: RunMessage): Promise<RunResponse | void>;
  /**
   * Called after every dispatch. Stage 4.2 binds this to Core's settlement step so a
   * convergence that was registered while handling a message finishes before the actor takes
   * the next one.
   */
  settle?(): Promise<void>;
}

export interface RunActorDeps {
  readonly processor: RunProcessor;
}

/**
 * One run's Inbox and serial processing loop (docs/M1/Kernel/Interaction.md 4.2).
 *
 * The actor owns the ordering guarantees; it does not own run state. Control messages are
 * only preferred between two messages, so a handler already running is never interrupted.
 */
export class RunActor {
  readonly #inbox: Inbox<RunMessage, RunResponse | void, RunChannel>;
  readonly #processor: RunProcessor;
  readonly #closed: Promise<void>;
  #resolveClosed: () => void = () => undefined;
  #started = false;
  #stopped = false;
  #closedResolved = false;

  public constructor(deps: RunActorDeps) {
    this.#processor = deps.processor;
    this.#inbox = new Inbox<RunMessage, RunResponse | void, RunChannel>({
      channels: ['control', 'work'],
    });
    this.#closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  /** Starts consuming; messages queued before this call are handled first. */
  public start(): void {
    if (this.#stopped) throw new Error('Run actor has stopped');
    if (this.#started) return;
    this.#started = true;
    this.#inbox.start((message) => this.#handle(message));
  }

  /** Queues `RUN_INIT`; the processor starts the run and emits `RunStart`. */
  public init(): Promise<void> {
    this.#assertOpen();
    this.#inbox.enqueue({ kind: 'RUN_INIT' }, 'control');
    return Promise.resolve();
  }

  /** Queues a Gateway request and resolves with the processor's response. */
  public forward(
    forward: GatewayForward,
    context: Readonly<BoundaryContext>,
  ): Promise<RunResponse> {
    this.#assertOpen();
    const message: RunMessage = { kind: 'FORWARD', forward, context };
    return this.#inbox.request(message, runChannelOf(message)).then((response) => {
      if (response === undefined)
        throw new Error('A forwarded request was handled without a response');
      return response;
    });
  }

  /** Queues an execution fact; the processor decides whether it settles one attempt. */
  public reportFact(fact: ExecutionFact): Promise<void> {
    this.#assertOpen();
    const message: RunMessage = { kind: 'EXECUTION_FACT', fact };
    this.#inbox.enqueue(message, runChannelOf(message));
    return Promise.resolve();
  }

  /** A timer only enqueues its control message. */
  public timer(timer: RunTimer): Promise<void> {
    this.#assertOpen();
    this.#inbox.enqueue({ kind: timer }, 'control');
    return Promise.resolve();
  }

  /** Requests run convergence through the control channel. */
  public abort(faultId: string): Promise<void> {
    this.#assertOpen();
    this.#inbox.enqueue({ kind: 'KERNEL_FAULT', faultId }, 'control');
    return Promise.resolve();
  }

  /** Records that the run reached CLOSED; later readArtifact requests remain valid. */
  public markClosed(): void {
    if (this.#closedResolved) return;
    this.#closedResolved = true;
    this.#resolveClosed();
  }

  /** Resolves when the run reached CLOSED, independent of when the actor is stopped. */
  public whenClosed(): Promise<void> {
    return this.#closed;
  }

  /** Waits until everything queued so far has been handled. */
  public async drain(): Promise<void> {
    if (!this.#started) throw new Error('Run actor has not started');
    await this.#inbox.idle();
  }

  /** Stops accepting new messages and drains what was already queued. */
  public async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#started) await this.drain();
  }

  #assertOpen(): void {
    if (this.#stopped) throw new Error('Run actor has stopped');
  }

  async #handle(message: RunMessage): Promise<RunResponse | void> {
    const response = await this.#processor.dispatch(message);
    await this.#processor.settle?.();
    return response;
  }
}
