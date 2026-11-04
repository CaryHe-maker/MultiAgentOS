import type { ExecutionRequest } from '@multiagentos/contracts';

/** The Supervisor's view of one accepted execution. */
export type ExecutionState = 'ACCEPTED' | 'RUNNING' | 'TERMINAL';

export interface ExecutionEntry {
  readonly request: ExecutionRequest;
  readonly correlationId: string;
  /** Created per execution so a later stage can abort it without shared handles. */
  readonly abortController: AbortController;
  state: ExecutionState;
  startedAt?: string;
  endedAt?: string;
  /** Set before the single terminal fact is produced; late results are ignored. */
  terminal: boolean;
  /** The first abort trigger wins; later triggers do not reset the grace period. */
  abortReason?: 'UNIT_TIMEOUT' | 'EXECUTION_CANCELLED';
  notBeforeTimer: ReturnType<typeof setTimeout> | undefined;
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
}

/** The execution table is the only place a Supervisor execution is registered or replaced. */
export class ExecutionTable {
  readonly #entries = new Map<string, ExecutionEntry>();

  /** Returns false for a duplicate executionId; the first accepted request wins. */
  public add(entry: ExecutionEntry): boolean {
    if (this.#entries.has(entry.request.executionId)) return false;
    this.#entries.set(entry.request.executionId, entry);
    return true;
  }

  public values(): IterableIterator<ExecutionEntry> {
    return this.#entries.values();
  }
}
