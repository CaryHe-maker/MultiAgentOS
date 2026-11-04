import type { AppendLogPort, ArtifactOwnerLine, ArtifactStorePort } from '@multiagentos/contracts';
import { isExpired } from './session-artifacts.js';

export interface ArtifactSweepDeps {
  readonly store: Pick<ArtifactStorePort, 'sweep'>;
  /** Only these Sessions keep bodies alive: a DELETED one's leftover index counts for nothing. */
  readonly activeSessionIds: () => readonly string[];
  readonly ownersOf: (sessionId: string) => AppendLogPort<ArtifactOwnerLine>;
  readonly expiringRetentionDays: number;
  readonly now: () => Date;
  /** A failed sweep only leaves a diagnostic; it blocks neither startup nor the next sweep. */
  readonly report: (error: unknown) => void;
}

/**
 * Artifact collection (Kernel/Execution 6). Marks what the ACTIVE Sessions still need, then lets
 * the store remove every other body written before this sweep began. An index that cannot be read
 * stops the whole sweep: nothing can be known unneeded while one Session's marks are missing.
 */
export class ArtifactSweep {
  readonly #deps: ArtifactSweepDeps;
  #running: Promise<void> | undefined;

  public constructor(deps: ArtifactSweepDeps) {
    this.#deps = deps;
  }

  /** The last line of an artifact is its registration, as when a Session loads its index. */
  async #retained(startedAt: Date): Promise<ReadonlySet<string>> {
    const { activeSessionIds, ownersOf, expiringRetentionDays } = this.#deps;
    const retained = new Set<string>();
    for (const sessionId of activeSessionIds()) {
      const owners = ownersOf(sessionId);
      await owners.repairTail();
      const lines = new Map<string, ArtifactOwnerLine>();
      for await (const line of owners.readAll()) lines.set(line.artifactId, line);
      for (const line of lines.values())
        if (!isExpired(line, expiringRetentionDays, startedAt)) retained.add(line.artifactId);
    }
    return retained;
  }

  async #sweep(): Promise<void> {
    try {
      const startedAt = this.#deps.now();
      const retained = await this.#retained(startedAt);
      await this.#deps.store.sweep({ retained, olderThan: startedAt.toISOString() });
    } catch (error) {
      this.#deps.report(error);
    }
  }

  /** Starts a sweep unless one is still running, and resolves when the running one has ended. */
  run(): Promise<void> {
    this.#running ??= this.#sweep().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** Resolves once no sweep is running. */
  async finished(): Promise<void> {
    await this.#running;
  }
}
