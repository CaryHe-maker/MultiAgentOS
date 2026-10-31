export interface WallClocksDeps {
  readonly now: () => number;
  /** Arms a timer and returns its cancel; the timer only enqueues (Kernel/Interaction 5.4). */
  readonly schedule: (delayMs: number, due: () => void) => () => void;
  readonly due: () => void;
}

interface Clock {
  readonly limitMs: number;
  usedMs: number;
  /** Set while the clock runs. */
  since?: number;
  expired: boolean;
}

/**
 * The `maxWallClockMs` of each AgentRun (Kernel/Monitor 3). A clock runs from registration and
 * stops while its AgentRun only waits for the user; a question never times out, so the time spent
 * waiting must not count either. The actor reconciles after every message, and one timer is armed
 * for the earliest clock that can run out.
 */
export class WallClocks {
  readonly #deps: WallClocksDeps;
  readonly #clocks = new Map<string, Clock>();
  #cancel: (() => void) | undefined;

  public constructor(deps: WallClocksDeps) {
    this.#deps = deps;
  }

  /** An Agent without `maxWallClockMs` has no clock. */
  register(agentRunId: string, limitMs: number | undefined): void {
    if (limitMs === undefined) return;
    this.#clocks.set(agentRunId, { limitMs, usedMs: 0, since: this.#deps.now(), expired: false });
  }

  end(agentRunId: string): void {
    this.#clocks.delete(agentRunId);
  }

  #used(clock: Clock, now: number): number {
    return clock.usedMs + (clock.since === undefined ? 0 : now - clock.since);
  }

  usedMs(agentRunId: string): number | undefined {
    const clock = this.#clocks.get(agentRunId);
    return clock === undefined ? undefined : this.#used(clock, this.#deps.now());
  }

  /**
   * Stops the clocks of AgentRuns that only wait for the user and restarts the others, then arms
   * the timer again.
   */
  reconcile(isWaiting: (agentRunId: string) => boolean): void {
    const now = this.#deps.now();
    let earliest: number | undefined;
    for (const [agentRunId, clock] of this.#clocks) {
      if (clock.expired) continue;
      const waiting = isWaiting(agentRunId);
      if (waiting && clock.since !== undefined) {
        clock.usedMs += now - clock.since;
        delete clock.since;
      } else if (!waiting && clock.since === undefined) {
        clock.since = now;
      }
      if (clock.since === undefined) continue;
      const left = clock.limitMs - this.#used(clock, now);
      earliest = earliest === undefined ? left : Math.min(earliest, left);
    }
    this.#cancel?.();
    this.#cancel =
      earliest === undefined
        ? undefined
        : this.#deps.schedule(Math.max(0, earliest), this.#deps.due);
  }

  /** The AgentRuns whose clock ran out since the last call; each is reported once. */
  takeExpired(): string[] {
    const now = this.#deps.now();
    const expired: string[] = [];
    for (const [agentRunId, clock] of this.#clocks)
      if (!clock.expired && clock.since !== undefined && this.#used(clock, now) >= clock.limitMs) {
        clock.expired = true;
        expired.push(agentRunId);
      }
    return expired;
  }

  /** The run is closing: no timer may fire after this. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#clocks.clear();
  }
}
