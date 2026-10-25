import { randomUUID } from 'node:crypto';
import type { BoundaryContext, ExecutionFact, GatewayForward } from '@multiagentos/contracts';
import { Inbox } from '@multiagentos/fabric';
import type { RunEgressObserver, RunSendFailure } from './egress.js';
import {
  runChannelOf,
  type RunChannel,
  type RunMessage,
  type RunResponse,
  type RunTimer,
} from './messages.js';
import { RunTimers, type RunTimerConfig } from './timers.js';

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
  /** Flushes outbox events and cross-subject requests after each message. */
  readonly egress?: RunEgressPort;
  /** Starts and clears the run, authorization and convergence timers. */
  readonly timers?: RunTimerConfig;
  /** Last-resort escalation when the actor's own fault handling fails. */
  readonly onFatal?: (error: unknown) => void;
}

export interface RunEgressPort {
  flush(): void;
  drain(): Promise<void>;
  setObserver?(observer: RunEgressObserver | undefined): void;
  setFailureHandler?(handler: ((failure: RunSendFailure) => void) | undefined): void;
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
  readonly #egress: RunEgressPort | undefined;
  readonly #timers: RunTimers | undefined;
  readonly #onFatal: ((error: unknown) => void) | undefined;
  readonly #closed: Promise<void>;
  #resolveClosed: () => void = () => undefined;
  #started = false;
  #stopped = false;
  #closedResolved = false;
  #faultPending = false;
  #handling = false;

  public constructor(deps: RunActorDeps) {
    this.#processor = deps.processor;
    this.#egress = deps.egress;
    this.#onFatal = deps.onFatal;
    this.#inbox = new Inbox<RunMessage, RunResponse | void, RunChannel>({
      channels: ['control', 'work'],
      onError: (error, message) => this.#handleQueuedFailure(error, message),
    });
    this.#timers =
      deps.timers === undefined
        ? undefined
        : new RunTimers(deps.timers, (timer) => {
            if (this.#stopped || this.#closedResolved) return;
            try {
              this.#inbox.enqueue({ kind: timer }, 'control');
            } catch (error) {
              this.#panic(error);
            }
          });
    this.#egress?.setObserver?.(this.#timers);
    this.#egress?.setFailureHandler?.((failure) => {
      if (failure.terminal) return;
      this.#requestFault(failure.error);
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
    return this.#inbox
      .request(message, runChannelOf(message))
      .then((response) => {
        if (response === undefined)
          throw new Error('A forwarded request was handled without a response');
        return response;
      })
      .catch((error: unknown) => {
        this.#requestFault(error);
        throw error;
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

  /** Queues the internal shutdown convergence message. */
  public cancel(): Promise<void> {
    this.#assertOpen();
    this.#inbox.enqueue({ kind: 'CANCEL_RUN' }, 'control');
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
    this.#timers?.close();
    this.#resolveClosed();
  }

  /** Resolves when the run reached CLOSED, independent of when the actor is stopped. */
  public whenClosed(): Promise<void> {
    return this.#closed;
  }

  /** Waits until everything queued so far has been handled and flushed. */
  public async drain(): Promise<void> {
    if (!this.#started) throw new Error('Run actor has not started');
    await this.#inbox.idle();
    await this.#egress?.drain();
  }

  /**
   * Flushes work settled by an asynchronous operation after its initiating dispatch returned.
   * While a message is being handled, the normal `finally` flush already covers it.
   */
  public flushPending(): void {
    if (this.#handling || this.#stopped || !this.#started) return;
    try {
      this.#egress?.flush();
    } catch (error) {
      this.#panic(error);
    }
  }

  /** Stops accepting new messages and drains what was already queued. */
  public async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#timers?.close();
    if (this.#started) await this.drain();
  }

  #assertOpen(): void {
    if (this.#stopped) throw new Error('Run actor has stopped');
  }

  async #handle(message: RunMessage): Promise<RunResponse | void> {
    this.#handling = true;
    try {
      const response = await this.#processor.dispatch(message);
      await this.#processor.settle?.();
      return response;
    } finally {
      try {
        this.#egress?.flush();
      } finally {
        this.#handling = false;
      }
    }
  }

  #handleQueuedFailure(error: unknown, message: RunMessage): void {
    if (message.kind === 'KERNEL_FAULT') this.#panic(error);
    else this.#requestFault(error);
  }

  /** Injects one KERNEL_FAULT; only the Kernel core's actor decides to do this. */
  #requestFault(error: unknown): void {
    if (this.#stopped || this.#closedResolved || this.#faultPending) return;
    this.#faultPending = true;
    try {
      this.#inbox.enqueue({ kind: 'KERNEL_FAULT', faultId: `flt_${randomUUID()}` }, 'control');
    } catch (enqueueError) {
      this.#panic(enqueueError);
    }
    void error;
  }

  #panic(error: unknown): void {
    try {
      this.#onFatal?.(error);
    } catch {
      // The last-resort handler must not turn a fault into another actor failure.
    }
  }
}
