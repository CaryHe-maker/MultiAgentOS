import type {
  AppendLogPort,
  SessionListEntry,
  SessionRefLine,
  TrustedInstructionLine,
  TrustedWebSearchLine,
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

  /** Exists and is not deleted: a Session of another folder is opened too, once the user agrees. */
  isOpenable(sessionId: string): boolean {
    return this.#refs.get(sessionId)?.status === 'ACTIVE';
  }

  /** The folder the Session was last worked on in; undefined for a Session Kernel does not know. */
  rootOf(sessionId: string): string | undefined {
    return this.#refs.get(sessionId)?.repositoryRoot;
  }

  /** Whether the Session was last worked on in the folder of this process (M2Design 2.3). */
  isHere(sessionId: string): boolean {
    return this.rootOf(sessionId) === this.#repositoryRoot;
  }

  /** The Session is worked on in the folder of this process from now on. */
  rebind(sessionId: string): Promise<void> {
    return this.#write(sessionId, 'ACTIVE');
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

/**
 * The folders the user allowed the web search for from now on. One line per folder; it is read at
 * start and consulted when a run begins, and a run that has it does not ask again. It lives in the
 * data directory, where nothing the model runs can write; deleting the line, or the file, takes
 * the permission back.
 */
export class WebSearchTrust {
  readonly #log: AppendLogPort<TrustedWebSearchLine>;
  readonly #now: () => Date;
  readonly #folders = new Set<string>();

  public constructor(log: AppendLogPort<TrustedWebSearchLine>, now: () => Date) {
    this.#log = log;
    this.#now = now;
  }

  async load(): Promise<void> {
    await this.#log.repairTail();
    for await (const line of this.#log.readAll()) this.#folders.add(line.repositoryRoot);
  }

  isTrusted(repositoryRoot: string): boolean {
    return this.#folders.has(repositoryRoot);
  }

  async record(repositoryRoot: string): Promise<void> {
    if (this.#folders.has(repositoryRoot)) return;
    await this.#log.append({
      repositoryRoot,
      source: 'USER_CONFIRMED',
      at: this.#now().toISOString(),
    });
    this.#folders.add(repositoryRoot);
  }
}
