import {
  AnswerAuthorizationRequestSchema,
  AnswerHumanRequestSchema,
  AckCompactionRequestSchema,
  CompactContextRequestSchema,
  ReportCompactionSourceRequestSchema,
  InterruptRunRequestSchema,
  PauseRunRequestSchema,
  ResumeRunRequestSchema,
  SteerRunRequestSchema,
  CloseRunRequestSchema,
  ConfirmUndoRequestSchema,
  DeleteSessionRequestSchema,
  DiffTurnsRequestSchema,
  EndAgentRunRequestSchema,
  ListSessionsRequestSchema,
  OpenSessionRequestSchema,
  ReadArtifactRequestSchema,
  ReadProjectFileRequestSchema,
  RegisterAgentRunRequestSchema,
  ReleaseDelegationRequestSchema,
  ReserveDelegationRequestSchema,
  ReportSessionCommandRequestSchema,
  ReportSessionListRequestSchema,
  RequestHumanRequestSchema,
  ShutdownRequestSchema,
  StartRunRequestSchema,
  StartSessionRequestSchema,
  SubmitUnitRequestSchema,
  UndoTurnsRequestSchema,
  UpdateActivityRequestSchema,
  newId,
  validate,
  type CloseReason,
  type GatewayForward,
  type GatewayRejectedCode,
  type InteractionGatewayPort,
  type SyscallRejected,
  type WorkflowGatewayPort,
} from '@multiagentos/contracts';
import type { CoreResponse } from './session-core.js';

export type Caller = 'workflow' | 'user-interaction';
export type RequestType = GatewayForward['requestType'];

/** The message a request arrived in, for the context Core sees (Kernel/Gateway 2). */
export interface RequestOrigin {
  readonly correlationId: string;
  readonly messageId: string;
}
type Schema = Parameters<typeof validate>[0];

interface Route {
  readonly caller: Caller;
  readonly schema: Schema;
  /** What the request must name: Interface/Gateway table of Kernel/Gateway 3. */
  readonly needs: 'NOTHING' | 'SESSION' | 'RUN';
  /** Refused at the door once the run left RUNNING (Kernel/Gateway 4). */
  readonly blocked?: true;
}

const ROUTES: Readonly<Record<RequestType, Route>> = {
  registerAgentRun: {
    caller: 'workflow',
    schema: RegisterAgentRunRequestSchema,
    needs: 'RUN',
    blocked: true,
  },
  reserveDelegation: {
    caller: 'workflow',
    schema: ReserveDelegationRequestSchema,
    needs: 'RUN',
    blocked: true,
  },
  releaseDelegation: {
    caller: 'workflow',
    schema: ReleaseDelegationRequestSchema,
    needs: 'RUN',
  },
  reportCompactionSource: {
    caller: 'workflow',
    schema: ReportCompactionSourceRequestSchema,
    needs: 'RUN',
  },
  ackCompaction: { caller: 'workflow', schema: AckCompactionRequestSchema, needs: 'RUN' },
  compactContext: {
    caller: 'user-interaction',
    schema: CompactContextRequestSchema,
    needs: 'RUN',
  },
  submitUnit: {
    caller: 'workflow',
    schema: SubmitUnitRequestSchema,
    needs: 'RUN',
    blocked: true,
  },
  requestHuman: {
    caller: 'workflow',
    schema: RequestHumanRequestSchema,
    needs: 'RUN',
    blocked: true,
  },
  readProjectFile: {
    caller: 'workflow',
    schema: ReadProjectFileRequestSchema,
    needs: 'RUN',
    blocked: true,
  },
  updateActivity: {
    caller: 'workflow',
    schema: UpdateActivityRequestSchema,
    needs: 'RUN',
    blocked: true,
  },
  undoTurns: { caller: 'user-interaction', schema: UndoTurnsRequestSchema, needs: 'RUN' },
  confirmUndo: { caller: 'user-interaction', schema: ConfirmUndoRequestSchema, needs: 'RUN' },
  diffTurns: { caller: 'user-interaction', schema: DiffTurnsRequestSchema, needs: 'SESSION' },
  endAgentRun: { caller: 'workflow', schema: EndAgentRunRequestSchema, needs: 'RUN' },
  closeRun: { caller: 'workflow', schema: CloseRunRequestSchema, needs: 'RUN' },
  reportSessionCommand: {
    caller: 'workflow',
    schema: ReportSessionCommandRequestSchema,
    needs: 'NOTHING',
  },
  reportSessionList: {
    caller: 'workflow',
    schema: ReportSessionListRequestSchema,
    needs: 'NOTHING',
  },
  startSession: { caller: 'user-interaction', schema: StartSessionRequestSchema, needs: 'NOTHING' },
  startRun: { caller: 'user-interaction', schema: StartRunRequestSchema, needs: 'NOTHING' },
  openSession: { caller: 'user-interaction', schema: OpenSessionRequestSchema, needs: 'NOTHING' },
  listSessions: { caller: 'user-interaction', schema: ListSessionsRequestSchema, needs: 'NOTHING' },
  deleteSession: {
    caller: 'user-interaction',
    schema: DeleteSessionRequestSchema,
    needs: 'NOTHING',
  },
  shutdown: { caller: 'user-interaction', schema: ShutdownRequestSchema, needs: 'NOTHING' },
  answerAuthorization: {
    caller: 'user-interaction',
    schema: AnswerAuthorizationRequestSchema,
    needs: 'RUN',
  },
  answerHuman: { caller: 'user-interaction', schema: AnswerHumanRequestSchema, needs: 'RUN' },
  pauseRun: { caller: 'user-interaction', schema: PauseRunRequestSchema, needs: 'RUN' },
  resumeRun: { caller: 'user-interaction', schema: ResumeRunRequestSchema, needs: 'RUN' },
  interruptRun: { caller: 'user-interaction', schema: InterruptRunRequestSchema, needs: 'RUN' },
  steerRun: { caller: 'user-interaction', schema: SteerRunRequestSchema, needs: 'RUN' },
  readArtifact: {
    caller: 'user-interaction',
    schema: ReadArtifactRequestSchema,
    needs: 'SESSION',
  },
};

interface Admission {
  readonly sessionId: string;
  readonly runState: 'RUNNING' | 'CONVERGING' | 'CLOSED';
  readonly closeReason?: CloseReason;
}

export interface SessionGatewayDeps {
  readonly handle: (
    forward: GatewayForward,
    sessionId?: string,
    origin?: RequestOrigin,
  ) => Promise<CoreResponse>;
  readonly isOpenSession: (sessionId: string) => boolean;
  readonly newSessionId?: () => string;
}

/**
 * The only way into the Kernel core (Kernel/Gateway): caller, Schema and admission checks, nothing
 * else. It keeps no Lease and no quota, and Core still decides everything it lets through.
 */
export class SessionGateway {
  readonly #deps: SessionGatewayDeps;
  readonly #admissions = new Map<string, Admission>();

  public constructor(deps: SessionGatewayDeps) {
    this.#deps = deps;
  }

  /** Pushed by Core. A run only moves forward, and a block is never lifted. */
  admission(
    workflowRunId: string,
    sessionId: string,
    runState: Admission['runState'],
    closeReason?: CloseReason,
  ): void {
    const known = this.#admissions.get(workflowRunId);
    const rank = { RUNNING: 0, CONVERGING: 1, CLOSED: 2 } as const;
    if (known !== undefined && rank[runState] < rank[known.runState]) return;
    this.#admissions.set(workflowRunId, {
      sessionId,
      runState,
      ...(closeReason === undefined ? {} : { closeReason }),
    });
  }

  rejected(requestId: string, reasonCode: GatewayRejectedCode): SyscallRejected {
    return { requestId, outcome: 'REJECTED', issuer: 'GATEWAY', reasonCode };
  }

  /** Checks one request from `caller` and hands it to Core; `origin` is set over Fabric. */
  async serve(
    caller: Caller,
    requestType: RequestType,
    request: unknown,
    origin?: RequestOrigin,
  ): Promise<CoreResponse> {
    const route = ROUTES[requestType];
    const requestId = (request as { readonly requestId: string }).requestId;
    if (route.caller !== caller) return this.rejected(requestId, 'CALLER_FORBIDDEN');
    const parsed = validate<GatewayForward['request']>(route.schema, request);
    if (!parsed.ok) return this.rejected(requestId, 'INVALID_REQUEST');
    const body = parsed.value as { readonly sessionId?: string; readonly workflowRunId?: string };

    if (route.needs !== 'NOTHING') {
      if (body.sessionId === undefined || !this.#deps.isOpenSession(body.sessionId))
        return this.rejected(requestId, 'SESSION_NOT_FOUND');
    }
    if (route.needs === 'RUN') {
      const admission =
        body.workflowRunId === undefined ? undefined : this.#admissions.get(body.workflowRunId);
      if (admission === undefined || admission.sessionId !== body.sessionId)
        return this.rejected(requestId, 'RUN_NOT_FOUND');
      if (route.blocked === true && admission.runState !== 'RUNNING') {
        if (admission.closeReason === undefined)
          throw new Error('A blocked run must carry closeReason');
        return {
          requestId,
          outcome: 'REJECTED',
          issuer: 'GATEWAY',
          reasonCode: 'RUN_BLOCKED',
          closeReason: admission.closeReason,
        };
      }
    }
    const generated =
      requestType === 'startSession' || requestType === 'startRun'
        ? (this.#deps.newSessionId?.() ?? newId('ses'))
        : undefined;
    const forward = {
      caller,
      requestType,
      request: parsed.value,
      ...(generated === undefined ? {} : { sessionId: generated }),
    } as GatewayForward;
    return this.#deps.handle(forward, generated, origin);
  }

  #port<K extends RequestType>(caller: Caller, requestType: K) {
    return (request: unknown): Promise<never> =>
      this.serve(caller, requestType, request) as Promise<never>;
  }

  /** Injected into Workflow only; the caller is who holds the port. */
  readonly workflow: WorkflowGatewayPort = {
    registerAgentRun: this.#port('workflow', 'registerAgentRun'),
    reserveDelegation: this.#port('workflow', 'reserveDelegation'),
    releaseDelegation: this.#port('workflow', 'releaseDelegation'),
    reportCompactionSource: this.#port('workflow', 'reportCompactionSource'),
    ackCompaction: this.#port('workflow', 'ackCompaction'),
    submitUnit: this.#port('workflow', 'submitUnit'),
    endAgentRun: this.#port('workflow', 'endAgentRun'),
    closeRun: this.#port('workflow', 'closeRun'),
    requestHuman: this.#port('workflow', 'requestHuman'),
    readProjectFile: this.#port('workflow', 'readProjectFile'),
    updateActivity: this.#port('workflow', 'updateActivity'),
    reportSessionCommand: this.#port('workflow', 'reportSessionCommand'),
    reportSessionList: this.#port('workflow', 'reportSessionList'),
  };

  /** Injected into UserInteraction only. */
  readonly interaction: InteractionGatewayPort = {
    startSession: this.#port('user-interaction', 'startSession'),
    openSession: this.#port('user-interaction', 'openSession'),
    startRun: this.#port('user-interaction', 'startRun'),
    listSessions: this.#port('user-interaction', 'listSessions'),
    deleteSession: this.#port('user-interaction', 'deleteSession'),
    answerAuthorization: this.#port('user-interaction', 'answerAuthorization'),
    answerHuman: this.#port('user-interaction', 'answerHuman'),
    pauseRun: this.#port('user-interaction', 'pauseRun'),
    resumeRun: this.#port('user-interaction', 'resumeRun'),
    interruptRun: this.#port('user-interaction', 'interruptRun'),
    steerRun: this.#port('user-interaction', 'steerRun'),
    compactContext: this.#port('user-interaction', 'compactContext'),
    readArtifact: this.#port('user-interaction', 'readArtifact'),
    undoTurns: this.#port('user-interaction', 'undoTurns'),
    confirmUndo: this.#port('user-interaction', 'confirmUndo'),
    diffTurns: this.#port('user-interaction', 'diffTurns'),
    shutdown: this.#port('user-interaction', 'shutdown'),
  };
}
