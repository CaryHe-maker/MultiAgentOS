import type {
  ArtifactContent,
  DelegationReserved,
  GatewayForward,
  ProjectFileContent,
  SessionAccepted,
  SyscallAck,
  SyscallRejected,
} from '@multiagentos/contracts';
import type { RunWork } from './run-work.js';
import type { RunClosing, SessionActor } from './session-actor.js';
import type { SessionArtifacts } from './session-artifacts.js';
import type { SessionManager } from './session-manager.js';

export type CoreResponse =
  | SyscallAck
  | SyscallRejected
  | SessionAccepted
  | ArtifactContent
  | ProjectFileContent
  | DelegationReserved;

export interface SessionCoreDeps {
  readonly manager: SessionManager;
  readonly artifactsOf: (sessionId: string) => SessionArtifacts | undefined;
}

type Forward<T extends GatewayForward['requestType']> = Extract<
  GatewayForward,
  { requestType: T }
>['request'];
type RunRequest =
  | Forward<'submitUnit'>
  | Forward<'answerHuman'>
  | Forward<'pauseRun'>
  | Forward<'resumeRun'>
  | Forward<'steerRun'>;

const refused = (
  requestId: string,
  reasonCode:
    | 'RUN_NOT_FOUND'
    | 'SESSION_NOT_FOUND'
    | 'INVALID_ARTIFACT_REF'
    | 'ARTIFACT_EXPIRED'
    | 'COMPACTION_UNKNOWN',
): SyscallRejected => ({ requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode });

/**
 * What Gateway hands over, sent to the part of Core that owns it: Session requests to Session
 * management, run requests into the actor of the open Session (Kernel/Interaction 5.1).
 */
export class SessionCore {
  readonly #deps: SessionCoreDeps;

  public constructor(deps: SessionCoreDeps) {
    this.#deps = deps;
  }

  /** Runs `work` in turn inside the actor, against the run the request names. */
  #inRun<R>(
    request: Pick<RunRequest, 'requestId' | 'sessionId' | 'workflowRunId'>,
    work: (
      work: RunWork,
      actor: SessionActor,
      run: Parameters<SessionActor['closeRun']>[0],
    ) => Promise<R> | R,
  ): Promise<R | SyscallRejected> {
    const actor = this.#deps.manager.actor(request.sessionId);
    if (actor === undefined)
      return Promise.resolve(refused(request.requestId, 'SESSION_NOT_FOUND'));
    return actor.call(() => {
      const run = actor.run(request.workflowRunId);
      if (run === undefined) return refused(request.requestId, 'RUN_NOT_FOUND');
      return work(run.work, actor, run);
    });
  }

  async #closeRun(request: Forward<'closeRun'>): Promise<SyscallAck | SyscallRejected> {
    const { requestId, sessionId } = request;
    const resultRef = 'resultRef' in request ? request.resultRef : undefined;
    if (resultRef !== undefined && this.#deps.artifactsOf(sessionId)?.owns(resultRef) !== true)
      return refused(requestId, 'INVALID_ARTIFACT_REF');
    const closing: RunClosing =
      request.outcome === 'FAILED'
        ? { closeReason: 'FAILED', failure: request.failure }
        : {
            closeReason: request.outcome,
            ...(resultRef === undefined ? {} : { resultRef }),
          };
    return this.#inRun(request, (work, actor, run) =>
      work.once(requestId, request, async () => {
        await actor.closeRun(run, closing);
        return { accepted: true };
      }),
    );
  }

  async #readArtifact(request: Forward<'readArtifact'>): Promise<CoreResponse> {
    const { requestId, sessionId, ref } = request;
    const artifacts = this.#deps.artifactsOf(sessionId);
    if (artifacts === undefined) return refused(requestId, 'SESSION_NOT_FOUND');
    const content = await artifacts.read(ref);
    if (!content.ok) return refused(requestId, content.reasonCode);
    return { requestId, outcome: 'ACCEPTED', ref, text: content.text };
  }

  async #readProjectFile(request: Forward<'readProjectFile'>): Promise<CoreResponse> {
    const reading = await this.#inRun(request, (work) => work.readProjectFile(request));
    // Awaited here, outside the actor: the answer to its question has to get in.
    return 'response' in reading ? reading.response : reading;
  }

  handle(forward: GatewayForward, generatedSessionId?: string): Promise<CoreResponse> {
    const { manager } = this.#deps;
    const newSession = (): string => {
      if (generatedSessionId === undefined) throw new Error('Gateway generates the sessionId');
      return generatedSessionId;
    };
    switch (forward.requestType) {
      case 'startSession':
        return manager.startSession(forward.request, newSession());
      case 'startRun':
        return manager.startRun(forward.request, newSession());
      case 'openSession':
        return manager.openSession(forward.request);
      case 'listSessions':
        return manager.listSessions(forward.request);
      case 'deleteSession':
        return manager.deleteSession(forward.request);
      case 'shutdown': {
        const { requestId } = forward.request;
        return manager.shutdown().then(() => ({ requestId, outcome: 'ACCEPTED' }));
      }
      case 'reportSessionList':
        return Promise.resolve(manager.reportSessionList(forward.request));
      case 'reportSessionCommand':
        return Promise.resolve(manager.reportSessionCommand(forward.request));
      case 'registerAgentRun':
        return this.#inRun(forward.request, (work) => work.registerAgentRun(forward.request));
      case 'reserveDelegation':
        return this.#inRun(forward.request, (work) => work.reserveDelegation(forward.request));
      case 'releaseDelegation':
        return this.#inRun(forward.request, (work) =>
          Promise.resolve(work.releaseDelegation(forward.request)),
        );
      case 'retainArtifacts':
        return this.#inRun(forward.request, (work) => work.retainArtifacts(forward.request));
      case 'scheduleWake':
        return this.#inRun(forward.request, (work) =>
          Promise.resolve(work.scheduleWake(forward.request)),
        );
      case 'reportCompactionSource':
        return this.#inRun(forward.request, (work) =>
          Promise.resolve(work.reportCompactionSource(forward.request)),
        );
      case 'ackCompaction':
        return this.#inRun(forward.request, (work) =>
          Promise.resolve(work.ackCompaction(forward.request)),
        );
      case 'compactContext': {
        const { request } = forward;
        return this.#inRun(request, (work, actor, run) =>
          work.once(request.requestId, request, () => Promise.resolve(actor.compactContext(run))),
        );
      }
      case 'submitUnit':
        return this.#inRun(forward.request, (work) => work.submitUnit(forward.request));
      case 'endAgentRun':
        return this.#inRun(forward.request, (work) => work.endAgentRun(forward.request));
      case 'answerAuthorization':
        return this.#inRun(forward.request, (work) => work.answerAuthorization(forward.request));
      case 'closeRun':
        return this.#closeRun(forward.request);
      case 'requestHuman': {
        const { request } = forward;
        return this.#inRun(request, (work, actor, run) =>
          work.once(request.requestId, request, () =>
            request.kind === 'prompt'
              ? actor.requestOpenInput(run, request.humanRequestId)
              : Promise.resolve(actor.requestLocalQuestion(run, request)),
          ),
        );
      }
      case 'answerHuman': {
        const { request } = forward;
        const { input, humanRequestId, template } = request;
        // The same input counts once, whatever request carries it (Kernel/Core 6).
        return this.#inRun(request, (work, actor, run) =>
          work.once(request.requestId, input, () =>
            actor.answerHuman(run, humanRequestId, input, template),
          ),
        );
      }
      case 'pauseRun': {
        const { request } = forward;
        return this.#inRun(request, (work, actor, run) =>
          work.once(request.requestId, request, () => Promise.resolve(actor.pauseRun(run))),
        );
      }
      case 'resumeRun': {
        const { request } = forward;
        return this.#inRun(request, (work, actor, run) =>
          work.once(request.requestId, request, () => actor.resumeRun(run, request.steer)),
        );
      }
      case 'interruptRun': {
        const { request } = forward;
        return this.#inRun(request, (work, actor, run) =>
          work.once(request.requestId, request, () =>
            Promise.resolve(actor.interrupt(run, 'USER_ABORT')),
          ),
        );
      }
      case 'steerRun': {
        const { request } = forward;
        return this.#inRun(request, (work, actor, run) =>
          work.once(request.requestId, request, () =>
            actor.steerRun(run, request.input, request.targetAgentRunId),
          ),
        );
      }
      case 'readProjectFile':
        return this.#readProjectFile(forward.request);
      case 'readArtifact':
        return this.#readArtifact(forward.request);
      case 'updateActivity':
        return this.#inRun(forward.request, (work) =>
          Promise.resolve(work.updateActivity(forward.request)),
        );
      case 'undoTurns': {
        const { request } = forward;
        return this.#inRun(request, (work, actor, run) =>
          work.once(request.requestId, request, () => actor.undoTurns(run, request.scope)),
        );
      }
      case 'confirmUndo': {
        const { request } = forward;
        return this.#inRun(request, (work, actor, run) =>
          work.once(request.requestId, request, () =>
            actor.confirmUndo(run, request.undoId, request.decision),
          ),
        );
      }
      case 'diffTurns': {
        const { requestId, sessionId, n } = forward.request;
        const actor = manager.actor(sessionId);
        if (actor === undefined) return Promise.resolve(refused(requestId, 'SESSION_NOT_FOUND'));
        return actor.call(() => actor.diffTurn(requestId, n ?? 1));
      }
    }
  }
}
