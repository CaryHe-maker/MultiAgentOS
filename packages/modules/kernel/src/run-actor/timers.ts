import type { AdmissionProjection } from '@multiagentos/contracts';
import type { CoreEvent } from '../core/index.js';
import type { KernelConfig } from '../interfaces/index.js';
import type { RunEgressObserver } from './egress.js';
import type { RunTimer } from './messages.js';

export interface RunTimerConfig {
  readonly runTimeoutMs: number;
  readonly authorizationTimeoutMs: number;
  readonly convergenceDeadlineMs: number;
}

/** Derives the three run timers from the Kernel configuration. */
export function runTimerConfig(config: KernelConfig): RunTimerConfig {
  return {
    runTimeoutMs: config.runTimeoutMs,
    authorizationTimeoutMs: config.authorizationTimeoutMs,
    convergenceDeadlineMs: config.cancelGraceMs + config.convergenceMarginMs,
  };
}

/**
 * Owns the three run timers. A timer callback only submits a control message; it never changes
 * run state. Events and admission projections are used to start and clear timers, so the actor
 * remains the only place that processes messages.
 */
export class RunTimers implements RunEgressObserver {
  readonly #config: RunTimerConfig;
  readonly #enqueue: (timer: RunTimer) => void;
  #runTimer: ReturnType<typeof setTimeout> | undefined;
  #authorizationTimer: ReturnType<typeof setTimeout> | undefined;
  #convergenceTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  public constructor(config: RunTimerConfig, enqueue: (timer: RunTimer) => void) {
    this.#config = config;
    this.#enqueue = enqueue;
  }

  public onEvent(event: CoreEvent): void {
    if (this.#closed) return;
    switch (event.type) {
      case 'RunStart':
        this.#runTimer ??= this.#schedule('RUN_TIMEOUT', this.#config.runTimeoutMs);
        break;
      case 'AuthorizationRequest':
        this.#authorizationTimer ??= this.#schedule(
          'AUTHORIZATION_TIMEOUT',
          this.#config.authorizationTimeoutMs,
        );
        break;
      case 'AuthorizationResolved':
        this.#clearAuthorization();
        break;
      case 'RunClosed':
      case 'RunFinished':
        this.close();
        break;
      default:
        break;
    }
  }

  public onAdmission(projection: AdmissionProjection): void {
    if (this.#closed) return;
    if (projection.runState === 'CONVERGING') {
      this.#clearRun();
      this.#clearAuthorization();
      this.#convergenceTimer ??= this.#schedule(
        'CONVERGENCE_DEADLINE',
        this.#config.convergenceDeadlineMs,
      );
      return;
    }
    if (projection.runState === 'CLOSED') this.close();
  }

  public close(): void {
    this.#closed = true;
    this.#clearRun();
    this.#clearAuthorization();
    this.#clearConvergence();
  }

  #schedule(timer: RunTimer, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(
      () => {
        if (this.#closed) return;
        try {
          this.#enqueue(timer);
        } catch {
          // The actor is already stopped; a late timer must not change state.
        }
      },
      Math.max(0, delayMs),
    );
    return handle;
  }

  #clearRun(): void {
    if (this.#runTimer === undefined) return;
    clearTimeout(this.#runTimer);
    this.#runTimer = undefined;
  }

  #clearAuthorization(): void {
    if (this.#authorizationTimer === undefined) return;
    clearTimeout(this.#authorizationTimer);
    this.#authorizationTimer = undefined;
  }

  #clearConvergence(): void {
    if (this.#convergenceTimer === undefined) return;
    clearTimeout(this.#convergenceTimer);
    this.#convergenceTimer = undefined;
  }
}
