import type { MemoryLevel } from '@multiagentos/contracts';
import {
  newId,
  type CoreRejectedCode,
  type DeleteSessionRequest,
  type ListSessionsRequest,
  type OpenSessionRequest,
  type ReportSessionCommandRequest,
  type ReportSessionListRequest,
  type SessionAccepted,
  type SessionList,
  type SessionListEntry,
  type StartRunRequest,
  type StartSessionRequest,
  type SyscallAck,
  type SyscallRejected,
} from '@multiagentos/contracts';
import type { SessionActor } from './session-actor.js';
import type { KernelOutbox } from './session-outbox.js';
import type { SessionRefs } from './session-refs.js';

export interface SessionManagerDeps {
  readonly repositoryRoot: string;
  readonly refs: SessionRefs;
  readonly outbox: KernelOutbox;
  /** Builds a Session's actor; `onClosed` fires once when it is finished. */
  readonly openActor: (
    sessionId: string,
    session: { readonly onClosed: () => void; readonly discard: () => Promise<void> },
  ) => Promise<SessionActor>;
  /** Removes what Kernel wrote for a deleted Session; a failure is reported, not raised. */
  readonly removeSessionFiles: (sessionId: string) => Promise<void>;
  readonly titleOf: (entry: SessionListEntry) => Promise<string | undefined>;
  /** How long a closing Session may take before it is given up (Kernel/Interaction 6.4). */
  readonly closeTimeoutMs: number;
  /** Begins a sweep in the background, unless one is still running. */
  readonly startArtifactSweep: () => void;
  readonly sweepIntervalMs: number;
  readonly schedule: (delayMs: number, due: () => void) => () => void;
}

type Refused = SyscallRejected;
type Accepted = SessionAccepted | Refused;

interface Open {
  readonly sessionId: string;
  readonly actor: SessionActor;
  readonly closed: Promise<void>;
}

const refused = (requestId: string, reasonCode: CoreRejectedCode): Refused => ({
  requestId,
  outcome: 'REJECTED',
  issuer: 'CORE',
  reasonCode,
});

/**
 * The cross-Session part of Core (Kernel/Interaction 5.1): at most one Session is open, Session
 * requests run one at a time, and the replies they wait for bypass that queue.
 */
export class SessionManager {
  readonly #deps: SessionManagerDeps;
  readonly #queries = new Map<string, (sessions: readonly SessionListEntry[]) => void>();
  readonly #deletes = new Map<string, () => void>();
  #open: Open | undefined;
  #turn: Promise<unknown> = Promise.resolve();
  #shuttingDown = false;
  #cancelSweepTimer: (() => void) | undefined;

  public constructor(deps: SessionManagerDeps) {
    this.#deps = deps;
  }

  #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#turn.then(work);
    this.#turn = result.catch(() => undefined);
    return result;
  }

  /** ARTIFACT_SWEEP_TICK: taken in turn with Session requests, which do not wait for the sweep. */
  startSweepTimer(): void {
    this.#cancelSweepTimer = this.#deps.schedule(this.#deps.sweepIntervalMs, () => {
      void this.#inTurn(() => {
        if (!this.#shuttingDown) this.#deps.startArtifactSweep();
        return Promise.resolve();
      });
      this.startSweepTimer();
    });
  }

  /** Memory pressure of this process reaches the open Session's run, if any. */
  memoryPressure(level: MemoryLevel): Promise<void> {
    const open = this.#open;
    if (open === undefined) return Promise.resolve();
    return open.actor.memoryPressure(level);
  }

  /** The open Session, when `sessionId` names it. */
  actor(sessionId: string): SessionActor | undefined {
    return this.#open?.sessionId === sessionId ? this.#open.actor : undefined;
  }

  async #closeOpen(reason: 'SWITCHED' | 'SHUTDOWN'): Promise<void> {
    const open = this.#open;
    if (open === undefined) return;
    open.actor.close(reason);
    // A silent Workflow must not hold every later Session request; its lock expires on its own.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#deps.closeTimeoutMs);
    });
    await Promise.race([open.closed, gaveUp]);
    clearTimeout(timer);
    await this.#deps.outbox.drained();
    if (this.#open === open) this.#open = undefined;
  }

  async #begin(sessionId: string, start: Parameters<SessionActor['start']>[0]): Promise<void> {
    let closed: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const open: Open = {
      sessionId,
      actor: await this.#deps.openActor(sessionId, {
        onClosed: () => {
          if (this.#open === open) this.#open = undefined;
          closed();
        },
        discard: async () => {
          await this.#deps.refs.markDeleted(sessionId);
          await this.#deps.removeSessionFiles(sessionId);
        },
      }),
      closed: finished,
    };
    this.#open = open;
    open.actor.start(start);
  }

  #startNew(
    requestId: string,
    start: Parameters<SessionActor['start']>[0],
    sessionId: string,
  ): Promise<Accepted> {
    return this.#inTurn(async () => {
      if (this.#shuttingDown) return refused(requestId, 'RUN_LIMIT');
      await this.#closeOpen('SWITCHED');
      await this.#deps.refs.add(sessionId);
      await this.#begin(sessionId, start);
      return { requestId, outcome: 'ACCEPTED', sessionId };
    });
  }

  /** `sessionId` comes from Gateway, which owns generating it (Interface 3). */
  startSession(request: StartSessionRequest, sessionId: string): Promise<Accepted> {
    const { requestId, prompt } = request;
    if (request.mode === 'FORK') {
      const { fromSessionId } = request;
      // A fork starts from the open Session, whose run this closes first.
      if (this.actor(fromSessionId) === undefined)
        return Promise.resolve(refused(requestId, 'SESSION_NOT_FOUND'));
      return this.#startNew(
        requestId,
        { kind: 'FORK', requestId, input: prompt, fromSessionId },
        sessionId,
      );
    }
    return this.#startNew(requestId, { kind: 'NEW', requestId, input: prompt }, sessionId);
  }

  startRun(request: StartRunRequest, sessionId: string): Promise<Accepted> {
    const { requestId, goal, template } = request;
    return this.#startNew(requestId, { kind: 'NEW', requestId, input: goal, template }, sessionId);
  }

  openSession(request: OpenSessionRequest): Promise<Accepted> {
    const { requestId, sessionId } = request;
    return this.#inTurn(async () => {
      if (this.#shuttingDown) return refused(requestId, 'RUN_LIMIT');
      const open = this.actor(sessionId);
      if (open !== undefined)
        return (await open.continueIfClosed())
          ? { requestId, outcome: 'ACCEPTED', sessionId }
          : refused(requestId, 'SESSION_IN_USE');
      if (!this.#deps.refs.isOpenable(sessionId)) return refused(requestId, 'SESSION_NOT_FOUND');
      await this.#closeOpen('SWITCHED');
      await this.#begin(sessionId, { kind: 'OPEN', requestId });
      return { requestId, outcome: 'ACCEPTED', sessionId };
    });
  }

  listSessions(request: ListSessionsRequest): Promise<SyscallAck | Refused> {
    const { requestId } = request;
    return this.#inTurn(async () => {
      const queryId = newId('slq');
      const sessions = new Promise<readonly SessionListEntry[]>((resolve) => {
        this.#queries.set(queryId, resolve);
      });
      const { outbox, refs, repositoryRoot, titleOf } = this.#deps;
      outbox.systemToWorkflow({ type: 'SessionListQuery', queryId, repositoryRoot });
      outbox.flush();
      const entries: SessionList['sessions'][number][] = [];
      for (const entry of refs.filterList(await sessions)) {
        const title = await titleOf(entry);
        const { sessionId, createdAt, lastActiveAt, turnCount, fork } = entry;
        entries.push({
          sessionId,
          createdAt,
          lastActiveAt,
          turnCount,
          ...(title === undefined ? {} : { title: title.slice(0, 80) }),
          ...(fork === undefined ? {} : { fork }),
        });
      }
      outbox.systemToInteraction({ type: 'SessionList', requestId, sessions: entries });
      outbox.flush();
      return { requestId, outcome: 'ACCEPTED' };
    });
  }

  /** Reference first: a sweep stops counting the Session even when the rest fails. */
  deleteSession(request: DeleteSessionRequest): Promise<SyscallAck | Refused> {
    const { requestId, sessionId } = request;
    return this.#inTurn(async () => {
      if (this.actor(sessionId) !== undefined) return refused(requestId, 'SESSION_IN_USE');
      const { outbox, refs, removeSessionFiles } = this.#deps;
      if (!refs.isOpenable(sessionId)) return refused(requestId, 'SESSION_NOT_FOUND');
      await refs.markDeleted(sessionId);
      const commandId = newId('scm');
      const replied = new Promise<void>((resolve) => {
        this.#deletes.set(commandId, resolve);
      });
      outbox.systemToWorkflow({ type: 'SessionDelete', commandId, sessionId });
      outbox.flush();
      await replied;
      let outcome: 'DELETED' | 'FAILED' = 'DELETED';
      try {
        await removeSessionFiles(sessionId);
      } catch {
        outcome = 'FAILED';
      }
      outbox.systemToInteraction({ type: 'SessionDeleted', requestId, sessionId, outcome });
      outbox.flush();
      return { requestId, outcome: 'ACCEPTED' };
    });
  }

  /** Not queued: the request that waits for this reply holds the queue. */
  reportSessionList(request: ReportSessionListRequest): SyscallAck | Refused {
    const { requestId, queryId } = request;
    const waiting = this.#queries.get(queryId);
    if (waiting === undefined) return refused(requestId, 'SESSION_QUERY_UNKNOWN');
    this.#queries.delete(queryId);
    waiting(request.sessions);
    return { requestId, outcome: 'ACCEPTED' };
  }

  reportSessionCommand(request: ReportSessionCommandRequest): SyscallAck | Refused {
    const { requestId, commandId } = request;
    const deleted = this.#deletes.get(commandId);
    if (deleted !== undefined) {
      this.#deletes.delete(commandId);
      deleted();
      return { requestId, outcome: 'ACCEPTED' };
    }
    const actor = this.actor(request.sessionId);
    if (actor?.expectsCommand(commandId) !== true)
      return refused(requestId, 'SESSION_COMMAND_UNKNOWN');
    actor.reportCommand(request);
    return { requestId, outcome: 'ACCEPTED' };
  }

  /** Later Session requests are refused; the open Session closes with SHUTDOWN. */
  shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#cancelSweepTimer?.();
    return this.#inTurn(() => this.#closeOpen('SHUTDOWN'));
  }
}
