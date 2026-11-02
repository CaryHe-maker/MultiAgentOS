import type {
  ArtifactContent,
  GatewayForwardV1,
  ProjectFileContent,
  SessionAccepted,
  SyscallAck,
  SyscallRejectedV1,
} from '@multiagentos/contracts';
import type { RunWork } from './run-work.js';
import type { RunClosing, SessionActor } from './session-actor.js';
import type { SessionArtifacts } from './session-artifacts.js';
import type { SessionManager } from './session-manager.js';

export type CoreResponse =
  SyscallAck | SyscallRejectedV1 | SessionAccepted | ArtifactContent | ProjectFileContent;

export interface SessionCoreDeps {
  readonly manager: SessionManager;
  readonly artifactsOf: (sessionId: string) => SessionArtifacts | undefined;
}

type Forward<T extends GatewayForwardV1['requestType']> = Extract<
  GatewayForwardV1,
  { requestType: T }
>['request'];
type RunRequest = Forward<'submitUnit'> | Forward<'answerHuman'>;

const refused = (
  requestId: string,
  reasonCode: 'RUN_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'INVALID_ARTIFACT_REF' | 'ARTIFACT_EXPIRED',
): SyscallRejectedV1 => ({ requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode });

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
  ): Promise<R | SyscallRejectedV1> {
    const actor = this.#deps.manager.actor(request.sessionId);
    if (actor === undefined)
      return Promise.resolve(refused(request.requestId, 'SESSION_NOT_FOUND'));
    return actor.call(() => {
      const run = actor.run(request.workflowRunId);
      if (run === undefined) return refused(request.requestId, 'RUN_NOT_FOUND');
      return work(run.work, actor, run);
    });
  }

  async #closeRun(request: Forward<'closeRun'>): Promise<SyscallAck | SyscallRejectedV1> {
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

  handle(forward: GatewayForwardV1, generatedSessionId?: string): Promise<CoreResponse> {
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
            actor.requestOpenInput(run, request.humanRequestId),
          ),
        );
      }
      case 'answerHuman': {
        const { request } = forward;
        const { input, humanRequestId, template } = request;
        // The same input counts once, whatever request carries it (Kernel/Core 6).
        return this.#inRun(request, (work, actor, run) =>
          work.once(request.requestId, input, () =>
            actor.answerOpenInput(run, humanRequestId, input, template),
          ),
        );
      }
      case 'readProjectFile':
        return this.#readProjectFile(forward.request);
      case 'readArtifact':
        return this.#readArtifact(forward.request);
    }
  }
}
