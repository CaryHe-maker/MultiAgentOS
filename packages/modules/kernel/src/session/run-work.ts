import type {
  AnswerAuthorizationRequestV1,
  AuthorizationRequestV1,
  AuthorizationResolvedV1,
  CloseReasonV1,
  CoreRejectedCodeV1,
  EndAgentRunRequestV1,
  ExecutionScope,
  RegisterAgentRunRequestV1,
  SubmitUnitRequestV1,
  SyscallAck,
  SyscallRejectedV1,
  TurnUsage,
  UnitDefinitionV1,
  UnitReportV1,
} from '@multiagentos/contracts';
import { RequestLedger } from '../core/request-ledger.js';
import type { SchedulerDuties } from '../interfaces/index.js';
import type { RunLedgers } from '../monitor/run-ledgers.js';
import {
  RunAttempts,
  type AttemptAudit,
  type AttemptFault,
  type AttemptSpec,
  type PinnedAgent,
} from './run-attempts.js';
import { RunAuthorization, type QuestionResolved } from './run-authorization.js';
import { admitWork, type Decision, type RunControl } from './run-control.js';
import { admitUnit } from './unit-admission.js';
import { WallClocks } from './wall-clocks.js';

export type PinResult =
  | { readonly ok: true; readonly agent: PinnedAgent }
  | {
      readonly ok: false;
      readonly reasonCode: Extract<
        CoreRejectedCodeV1,
        'DEFINITION_UNAVAILABLE' | 'DEFINITION_MISMATCH' | 'FORBIDDEN'
      >;
    };

/** The run as the Session actor owns it: control state, ordering and the Outbox stay there. */
export interface RunHost {
  control(): RunControl;
  closeReason(): CloseReasonV1 | undefined;
  runEpoch(): number;
  registerAgentRun(agentRunId: string): Decision;
  endAgentRun(agentRunId: string): Decision;
  attemptStarted(unitAttemptId: string): void;
  attemptEnded(unitAttemptId: string): void;
  toWorkflow(report: UnitReportV1): void;
  toInteraction(event: AuthorizationRequestV1 | AuthorizationResolvedV1): void;
  fault(fault: AttemptFault): void;
  /** Runs `work` as a control message of the actor; timers only do this. */
  enqueue(work: () => void): void;
}

export interface RunWorkDeps {
  readonly host: RunHost;
  readonly ledgers: RunLedgers;
  readonly scheduler: SchedulerDuties;
  readonly provider: string;
  readonly technicalRetryLimit: number;
  readonly repositoryRoot: string;
  readonly repositoryExclusions: readonly string[];
  readonly pinAgent: (request: RegisterAgentRunRequestV1) => Promise<PinResult>;
  readonly inputIsValid: (unit: UnitDefinitionV1, input: unknown) => boolean;
  /** Execution takes the attempt over and registers it through `attempts`. */
  readonly createAttempt: (spec: AttemptSpec, attempts: RunAttempts) => Promise<string>;
  /** Stops what is queued or running; every attempt still ends through `attempts`. */
  readonly cancelExecutions: (runEpoch: number) => Promise<void>;
  readonly executionsClosed: () => void;
  readonly audit: (entry: AttemptAudit) => void;
  readonly now: () => Date;
  readonly schedule: (delayMs: number, due: () => void) => () => void;
}

type Response = SyscallAck | SyscallRejectedV1;

interface AgentRunRecord {
  readonly agent: PinnedAgent;
  state: 'ACTIVE' | 'ENDED';
}

interface WaitingUnit {
  readonly request: SubmitUnitRequestV1;
  readonly unit: UnitDefinitionV1;
  readonly agent: PinnedAgent;
}

/**
 * The Unit path of one run (Kernel/Interaction 7): request records, AgentRuns, admission, quotas,
 * authorization and attempts. Every method runs inside one message of the Session actor.
 */
export class RunWork {
  readonly #deps: RunWorkDeps;
  readonly #host: RunHost;
  readonly #requests = new RequestLedger();
  readonly #agentRuns = new Map<string, AgentRunRecord>();
  readonly #waiting = new Map<string, WaitingUnit>();
  readonly #inFlight = new Map<string, number>();
  readonly #authorization: RunAuthorization<string>;
  readonly #clocks: WallClocks;
  readonly #attempts: RunAttempts;

  public constructor(deps: RunWorkDeps) {
    this.#deps = deps;
    const { host } = deps;
    this.#host = host;
    this.#authorization = new RunAuthorization<string>({
      repositoryRoot: deps.repositoryRoot,
      provider: deps.provider,
      repositoryExclusions: deps.repositoryExclusions,
      now: deps.now,
    });
    this.#clocks = new WallClocks({
      now: () => deps.now().getTime(),
      schedule: deps.schedule,
      due: () => {
        host.enqueue(() => {
          for (const agentRunId of this.#clocks.takeExpired())
            deps.ledgers.wallClockExceeded(agentRunId);
        });
      },
    });
    const closing = () => {
      const { phase } = host.control();
      return phase === 'CONVERGING' || phase === 'CLOSED';
    };
    this.#attempts = new RunAttempts({
      provider: deps.provider,
      technicalRetryLimit: deps.technicalRetryLimit,
      ledger: deps.ledgers,
      scheduler: deps.scheduler,
      createAttempt: (spec) => deps.createAttempt(spec, this.#attempts),
      isDeliverable: (runEpoch) => !closing() && runEpoch === host.runEpoch(),
      isConverging: closing,
      leaseIsValid: () => this.#authorization.lease !== undefined,
      deliver: (report) => {
        host.toWorkflow(report);
      },
      attemptStarted: (spec, unitAttemptId) => {
        this.#countInFlight(spec.agentRunId, 1);
        host.attemptStarted(unitAttemptId);
      },
      attemptEnded: (spec, unitAttemptId) => {
        this.#countInFlight(spec.agentRunId, -1);
        host.attemptEnded(unitAttemptId);
      },
      onFault: (fault) => {
        host.fault(fault);
      },
      audit: deps.audit,
    });
  }

  /** Execution reports back through this object. */
  get attempts(): RunAttempts {
    return this.#attempts;
  }

  #countInFlight(agentRunId: string, change: number): void {
    this.#inFlight.set(agentRunId, (this.#inFlight.get(agentRunId) ?? 0) + change);
  }

  openTurn(turnId: string): void {
    this.#deps.ledgers.openTurnLedger(turnId);
  }

  closeTurn(turnId: string): TurnUsage {
    return this.#deps.ledgers.closeTurnLedger(turnId);
  }

  #refuse(
    requestId: string,
    payload: unknown,
    reasonCode: CoreRejectedCodeV1 | 'RUN_BLOCKED',
  ): Response {
    let response: SyscallRejectedV1;
    if (reasonCode === 'RUN_BLOCKED') {
      const closeReason = this.#host.closeReason();
      if (closeReason === undefined) throw new Error('RUN_BLOCKED requires closeReason');
      response = { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode, closeReason };
    } else response = { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode };
    this.#requests.remember(requestId, payload, response);
    return response;
  }

  #accept(requestId: string, payload: unknown): Response {
    const response: SyscallAck = { requestId, outcome: 'ACCEPTED' };
    this.#requests.remember(requestId, payload, response);
    return response;
  }

  /** The answer to a request seen before; the same requestId with other content conflicts. */
  #replay(requestId: string, payload: unknown): Response | undefined {
    const found = this.#requests.lookup<Response>(requestId, payload);
    if (found.kind === 'replay') return found.response;
    if (found.kind === 'conflict')
      return { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode: 'REQUEST_CONFLICT' };
    return undefined;
  }

  async registerAgentRun(request: RegisterAgentRunRequestV1): Promise<Response> {
    const { requestId, agentRunId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const admitted = admitWork(this.#host.control());
    if (!admitted.accepted) return this.#refuse(requestId, request, admitted.reasonCode);
    if (this.#agentRuns.has(agentRunId))
      return this.#refuse(requestId, request, 'AGENT_RUN_EXISTS');
    if (this.#host.control().activeAgentRuns.size > 0)
      return this.#refuse(requestId, request, 'AGENT_RUN_ACTIVE');

    const pinned = await this.#deps.pinAgent(request);
    if (!pinned.ok) return this.#refuse(requestId, request, pinned.reasonCode);
    const registered = this.#host.registerAgentRun(agentRunId);
    if (!registered.accepted) return this.#refuse(requestId, request, registered.reasonCode);
    this.#agentRuns.set(agentRunId, { agent: pinned.agent, state: 'ACTIVE' });
    this.#clocks.register(agentRunId, pinned.agent.maxWallClockMs);
    return this.#accept(requestId, request);
  }

  endAgentRun(request: EndAgentRunRequestV1): Response {
    const { requestId, agentRunId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const { phase } = this.#host.control();
    if (phase === 'CONVERGING' || phase === 'CLOSED') return this.#accept(requestId, request);
    const record = this.#agentRuns.get(agentRunId);
    if (record === undefined) return this.#refuse(requestId, request, 'AGENT_RUN_NOT_FOUND');
    if (record.state === 'ENDED') return this.#refuse(requestId, request, 'AGENT_RUN_ENDED');
    record.state = 'ENDED';
    this.#clocks.end(agentRunId);
    const ended = this.#host.endAgentRun(agentRunId);
    if (!ended.accepted) return this.#refuse(requestId, request, ended.reasonCode);
    return this.#accept(requestId, request);
  }

  async submitUnit(request: SubmitUnitRequestV1): Promise<Response> {
    const { requestId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const record = this.#agentRuns.get(request.agentRunId);
    const admission = admitUnit(request, {
      control: this.#host.control(),
      agentRun:
        record === undefined
          ? undefined
          : {
              state: record.state,
              units: record.agent.units,
              maxToolUnits: record.agent.maxToolUnits,
            },
      inputIsValid: this.#deps.inputIsValid,
    });
    if (!admission.accepted) return this.#refuse(requestId, request, admission.reasonCode);
    if (record === undefined) throw new Error('An admitted Unit has no AgentRun');
    const { unit } = admission;
    const response = this.#accept(requestId, request);

    if (admission.countsAsTool) {
      const quota = this.#deps.ledgers.countToolUnit(request.agentRunId, record.agent.maxToolUnits);
      if (!quota.ok) {
        this.#refuseUnit(request, unit, { reasonCode: 'QUOTA_EXHAUSTED', quota: quota.quota });
        return response;
      }
    }
    if (!admission.needsRepoRead) {
      await this.#startAttempt(request, unit, record.agent);
      return response;
    }
    const { decision, requested } = this.#authorization.requireRepoRead(requestId);
    if (requested !== undefined) this.#host.toInteraction(requested);
    if (decision.kind === 'ALLOWED') await this.#startAttempt(request, unit, record.agent);
    else if (decision.kind === 'DECLINED')
      this.#refuseUnit(request, unit, { reasonCode: 'USER_DECLINED' });
    else this.#waiting.set(requestId, { request, unit, agent: record.agent });
    return response;
  }

  #refuseUnit(
    request: SubmitUnitRequestV1,
    unit: UnitDefinitionV1,
    refusal: Parameters<RunAttempts['rejectWithoutAttempt']>[1],
  ): void {
    this.#attempts.rejectWithoutAttempt(
      {
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        unitRunId: request.unitRunId,
        unit,
      },
      refusal,
    );
  }

  #scopeOf(unit: UnitDefinitionV1, agent: PinnedAgent): ExecutionScope {
    if (unit.executionKind === 'MODEL') return agent.modelScope;
    if (!unit.protectedCapabilities.includes('repo.read')) return { kind: 'NONE' };
    const lease = this.#authorization.lease;
    if (lease === undefined) throw new Error('A protected Unit needs a valid Lease');
    return {
      kind: 'REPOSITORY',
      repositoryRoot: lease.repositoryRoot,
      exclusions: [...lease.exclusions],
    };
  }

  async #startAttempt(
    request: SubmitUnitRequestV1,
    unit: UnitDefinitionV1,
    agent: PinnedAgent,
  ): Promise<void> {
    const { turnId } = this.#host.control();
    if (turnId === undefined) throw new Error('A Unit starts only in an open Turn');
    await this.#attempts.start({
      requestId: request.requestId,
      agentRunId: request.agentRunId,
      unitRunId: request.unitRunId,
      turnId,
      unit,
      input: request.input,
      scope: this.#scopeOf(unit, agent),
      runEpoch: this.#host.runEpoch(),
      agent,
    });
  }

  async answerAuthorization(request: AnswerAuthorizationRequestV1): Promise<Response> {
    const { requestId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const settled = this.#authorization.answer(request.questionId, request.answer.scope);
    if (settled === undefined) return this.#refuse(requestId, request, 'QUESTION_NOT_PENDING');
    this.#host.toInteraction(settled.resolved);
    await this.#release(settled);
    return this.#accept(requestId, request);
  }

  async #release(settled: QuestionResolved<string>): Promise<void> {
    for (const requestId of settled.waiters) {
      const waiting = this.#waiting.get(requestId);
      if (waiting === undefined) continue;
      this.#waiting.delete(requestId);
      if (settled.resolution === 'GRANTED')
        await this.#startAttempt(waiting.request, waiting.unit, waiting.agent);
      else this.#refuseUnit(waiting.request, waiting.unit, { reasonCode: 'USER_DECLINED' });
    }
  }

  /**
   * An AgentRun's clock stops while it only waits for the user: nothing dispatched or queued, and
   * a question open on one of its Units (Kernel/Monitor 3).
   */
  reconcile(): void {
    const waitingFor = new Set([...this.#waiting.values()].map((w) => w.request.agentRunId));
    this.#clocks.reconcile(
      (agentRunId) => waitingFor.has(agentRunId) && (this.#inFlight.get(agentRunId) ?? 0) === 0,
    );
  }

  /** The run started converging: Units on a question end with it and get no report. */
  async beginClosing(): Promise<void> {
    for (const settled of this.#authorization.cancelQuestions())
      this.#host.toInteraction(settled.resolved);
    this.#waiting.clear();
    this.#clocks.stop();
    await this.#deps.cancelExecutions(this.#host.runEpoch());
  }

  /** Nothing is in flight any more, so the Lease can end. */
  finishClosing(): void {
    this.#authorization.endLease();
    this.#deps.executionsClosed();
  }
}
