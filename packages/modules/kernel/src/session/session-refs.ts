import type {
  AppendLogPort,
  SessionListEntry,
  SessionRefLine,
  TrustedInstructionLine,
} from '@multiagentos/contracts';

/**
 * The system-level state of Session management (Kernel/Interaction 5.1): which Sessions exist and
 * which instructions the user trusts. Lines are appended and the last one for a key wins; they are
 * read once at startup and only Session management writes them.
 */
export class SessionRefs {
  readonly #log: AppendLogPort<SessionRefLine>;
  readonly #now: () => Date;
  readonly #repositoryRoot: string;
  readonly #refs = new Map<string, SessionRefLine>();

  public constructor(log: AppendLogPort<SessionRefLine>, repositoryRoot: string, now: () => Date) {
    this.#log = log;
    this.#repositoryRoot = repositoryRoot;
    this.#now = now;
  }

  async load(): Promise<void> {
    await this.#log.repairTail();
    for await (const line of this.#log.readAll()) this.#refs.set(line.sessionId, line);
  }

  async #write(sessionId: string, status: SessionRefLine['status']): Promise<void> {
    const line: SessionRefLine = {
      sessionId,
      repositoryRoot: this.#repositoryRoot,
      status,
      at: this.#now().toISOString(),
    };
    await this.#log.append(line);
    this.#refs.set(sessionId, line);
  }

  add(sessionId: string): Promise<void> {
    return this.#write(sessionId, 'ACTIVE');
  }

  markDeleted(sessionId: string): Promise<void> {
    return this.#write(sessionId, 'DELETED');
  }

  /** Exists, is not deleted and belongs to this process's repository (Interface 2.2). */
  isOpenable(sessionId: string): boolean {
    const ref = this.#refs.get(sessionId);
    return ref?.status === 'ACTIVE' && ref.repositoryRoot === this.#repositoryRoot;
  }

  /** Workflow's list, without what Kernel does not know as an openable Session. */
  filterList(sessions: readonly SessionListEntry[]): readonly SessionListEntry[] {
    return sessions.filter((entry) => this.isOpenable(entry.sessionId));
  }

  /** Bodies of these Sessions survive a sweep; a DELETED one keeps nothing alive. */
  activeSessionIds(): readonly string[] {
    return [...this.#refs.values()]
      .filter((ref) => ref.status === 'ACTIVE')
      .map((ref) => ref.sessionId);
  }
}

export class TrustRecords {
  readonly #log: AppendLogPort<TrustedInstructionLine>;
  readonly #now: () => Date;
  readonly #trusted = new Set<string>();

  public constructor(log: AppendLogPort<TrustedInstructionLine>, now: () => Date) {
    this.#log = log;
    this.#now = now;
  }

  static #key(repositoryRoot: string, path: string, sha256: string): string {
    return `${repositoryRoot}\0${path}\0${sha256}`;
  }

  async load(): Promise<void> {
    await this.#log.repairTail();
    for await (const line of this.#log.readAll())
      this.#trusted.add(TrustRecords.#key(line.repositoryRoot, line.path, line.sha256));
  }

  /** Trust is for exact content: any change asks again (M2Design 9.5). */
  isTrusted(repositoryRoot: string, path: string, sha256: string): boolean {
    return this.#trusted.has(TrustRecords.#key(repositoryRoot, path, sha256));
  }

  async record(
    repositoryRoot: string,
    path: string,
    sha256: string,
    source: TrustedInstructionLine['source'],
  ): Promise<void> {
    await this.#log.append({
      repositoryRoot,
      path,
      sha256,
      source,
      at: this.#now().toISOString(),
    });
    this.#trusted.add(TrustRecords.#key(repositoryRoot, path, sha256));
  }
}
