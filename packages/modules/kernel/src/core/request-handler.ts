import {
  validate,
  type ArtifactContent,
  type ArtifactRef,
  type BoundaryContext,
  type CatalogPort,
  type CloseReason,
  type CloseRunRequest,
  type CoreRejectedCode,
  type GatewayForward,
  type KernelConfig,
  type KernelToInteractionEvent,
  type ProtocolRegistry,
  type SyscallAck,
  type SyscallRejected,
} from '@multiagentos/contracts';
import type { AuditSink } from './audit.js';
import { AuthorizationManager, type AuthorizationResolution } from './authorization.js';
import type { RunRequestHandler, RunResponse } from './run-registry.js';
import type { AgentRunRecord, RunState } from './run-state.js';
import { deriveExecutionScope } from './scope.js';

/** The part of Execution that Core needs before stage 1.4 adds attempts and results. */
export interface CoreExecutionPort {
  ownsArtifact(ref: ArtifactRef): boolean;
  readArtifact(
    ref: ArtifactRef,
  ): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }>;
}

export interface CoreEventSink {
  /** Stage 1.5 replaces the collector with Core's Outbox. */
  emit(event: KernelToInteractionEvent): void | Promise<void>;
}

export interface CoreRequestHandlerDeps {
  readonly catalog: CatalogPort;
  readonly registry: ProtocolRegistry;
  readonly execution: CoreExecutionPort;
  readonly audit: AuditSink;
  readonly config: KernelConfig;
  readonly events?: CoreEventSink;
  readonly now?: () => Date;
}

const UNSUPPORTED_KINDS = new Set(['FILE_WRITE', 'COMMAND', 'TEST']);

/**
 * Core's run-scoped request handling (docs/M1/Kernel/Interaction.md 4.5 and 5.1).
 * Stage 1.2 covers idempotency, the state matrix and the AgentRun lifecycle. Permission,
 * attempts, results, convergence and events are added by stages 1.3–1.5.
 */
export class CoreRequestHandler implements RunRequestHandler {
  readonly #catalog: CatalogPort;
  readonly #registry: ProtocolRegistry;
  readonly #execution: CoreExecutionPort;
  readonly #audit: AuditSink;
  readonly #config: KernelConfig;
  readonly #events: CoreEventSink | undefined;
  readonly #now: () => Date;
  #authorization: AuthorizationManager | undefined;
  #authorizationRunId: string | undefined;

  public constructor(deps: CoreRequestHandlerDeps) {
    this.#catalog = deps.catalog;
    this.#registry = deps.registry;
    this.#execution = deps.execution;
    this.#audit = deps.audit;
    this.#config = deps.config;
    this.#events = deps.events;
    this.#now = deps.now ?? (() => new Date());
  }

  public handleForward(
    forward: GatewayForward,
    context: Readonly<BoundaryContext>,
    run: RunState,
  ): Promise<RunResponse> {
    switch (forward.requestType) {
      case 'registerAgentRun':
        return this.#registerAgentRun(forward.request, context, run);
      case 'submitUnit':
        return this.#submitUnit(forward.request, run);
      case 'endAgentRun':
        return this.#endAgentRun(forward.request, run);
      case 'closeRun':
        return this.#closeRun(forward.request, run);
      case 'answerAuthorization':
        return this.#answerAuthorization(forward.request, run);
      case 'cancelRun':
        return this.#cancelRun(forward.request, run);
      case 'readArtifact':
        return this.#readArtifact(forward.request, run);
      case 'createRun':
      case 'shutdown':
        return Promise.reject(new Error('RunRegistry handles createRun and shutdown'));
    }
  }

  async #registerAgentRun(
    request: Extract<GatewayForward, { requestType: 'registerAgentRun' }>['request'],
    context: Readonly<BoundaryContext>,
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState !== 'RUNNING') return this.#runBlocked(run, request.requestId, request);

    if (run.agentRuns.has(request.agentRunId))
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_EXISTS');
    if ([...run.agentRuns.values()].some((agentRun) => agentRun.state === 'ACTIVE'))
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_ACTIVE');

    const pinned = await this.#catalog.pinAgent(
      { id: request.agentRef.id, version: request.agentRef.version },
      { ...context, workflowRunId: run.workflowRunId },
    );
    if (!pinned.ok) return this.#reject(run, request.requestId, request, 'DEFINITION_UNAVAILABLE');
    if (pinned.value.agent.digest !== request.agentRef.digest)
      return this.#reject(run, request.requestId, request, 'DEFINITION_MISMATCH');
    if (pinned.value.model.provider !== this.#config.provider)
      return this.#reject(run, request.requestId, request, 'FORBIDDEN');

    const agentRun: AgentRunRecord = {
      agentRunId: request.agentRunId,
      agentRef: request.agentRef,
      pinned: pinned.value,
      state: 'ACTIVE',
      registeredAt: this.#now().toISOString(),
      rounds: 0,
    };
    run.agentRuns.set(request.agentRunId, agentRun);
    await this.#audit.append({
      at: agentRun.registeredAt,
      workflowRunId: run.workflowRunId,
      type: 'AGENT_RUN_REGISTERED',
      requestId: request.requestId,
      agentRunId: request.agentRunId,
    });
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  async #submitUnit(
    request: Extract<GatewayForward, { requestType: 'submitUnit' }>['request'],
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState !== 'RUNNING') return this.#runBlocked(run, request.requestId, request);

    const agentRun = run.agentRuns.get(request.agentRunId);
    if (agentRun === undefined)
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_NOT_FOUND');
    if (agentRun.state === 'ENDED')
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_ENDED');

    const unit = agentRun.pinned.units.find(
      (candidate) =>
        candidate.id === request.unitRef.id &&
        candidate.version === request.unitRef.version &&
        candidate.digest === request.unitRef.digest,
    );
    if (unit === undefined) return this.#reject(run, request.requestId, request, 'FORBIDDEN');
    if (UNSUPPORTED_KINDS.has(unit.executionKind))
      return this.#reject(run, request.requestId, request, 'UNSUPPORTED_CAPABILITY');

    const inputSchema = this.#registry.resolveContract(unit.inputContract);
    if (!validate(inputSchema, request.input).ok)
      return this.#reject(run, request.requestId, request, 'INVALID_INPUT');

    const authorization = this.#authorizationFor(run);
    const check = authorization.check(request.requestId, unit);
    if (check.requested !== undefined) {
      await this.#emit(check.requested);
      await this.#audit.append({
        at: this.#now().toISOString(),
        workflowRunId: run.workflowRunId,
        type: 'AUTHORIZATION_ASKED',
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        questionId: check.requested.questionId,
      });
    }

    if (check.decision.kind === 'ALLOWED') {
      run.unitDecisions.set(request.requestId, {
        kind: 'ALLOWED',
        scope: deriveExecutionScope(unit, agentRun, authorization.lease),
      });
    } else if (check.decision.kind === 'PENDING') {
      run.unitDecisions.set(request.requestId, {
        kind: 'PENDING',
        questionId: check.decision.questionId,
      });
      run.awaitingAuthorization.set(request.requestId, {
        unit,
        input: request.input,
        agentRunId: request.agentRunId,
        questionId: check.decision.questionId,
      });
    } else {
      run.unitDecisions.set(request.requestId, {
        kind: 'DECLINED',
        reasonCode: 'USER_DECLINED',
      });
    }

    // `Execution.createAttempt` consumes the decision in stage 1.4.
    run.units.submitted += 1;
    await this.#audit.append({
      at: this.#now().toISOString(),
      workflowRunId: run.workflowRunId,
      type: 'UNIT_ACCEPTED',
      requestId: request.requestId,
      agentRunId: request.agentRunId,
    });
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  async #endAgentRun(
    request: Extract<GatewayForward, { requestType: 'endAgentRun' }>['request'],
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState !== 'RUNNING')
      return this.#remember(run, request.requestId, request, ack(request.requestId));

    const agentRun = run.agentRuns.get(request.agentRunId);
    if (agentRun === undefined)
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_NOT_FOUND');
    if (agentRun.state === 'ENDED')
      return this.#reject(run, request.requestId, request, 'AGENT_RUN_ENDED');

    agentRun.state = 'ENDED';
    agentRun.endedAt = this.#now().toISOString();
    await this.#audit.append({
      at: agentRun.endedAt,
      workflowRunId: run.workflowRunId,
      type: 'AGENT_RUN_ENDED',
      requestId: request.requestId,
      agentRunId: request.agentRunId,
    });
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  async #closeRun(request: CloseRunRequest, run: RunState): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState !== 'RUNNING')
      return this.#remember(run, request.requestId, request, ack(request.requestId));

    if (request.outcome === 'COMPLETED') {
      if (!this.#execution.ownsArtifact(request.reportRef))
        return this.#reject(run, request.requestId, request, 'INVALID_ARTIFACT_REF');
      this.#enterConverging(run, 'COMPLETED', undefined, request.reportRef);
    } else {
      this.#enterConverging(run, 'FAILED', request.failure);
    }
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  async #answerAuthorization(
    request: Extract<GatewayForward, { requestType: 'answerAuthorization' }>['request'],
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState !== 'RUNNING')
      return this.#reject(run, request.requestId, request, 'QUESTION_NOT_PENDING');

    const answer = this.#authorizationFor(run).answer(request.questionId, request.answer);
    if (answer === undefined)
      return this.#reject(run, request.requestId, request, 'QUESTION_NOT_PENDING');
    await this.#applyAuthorizationResolution(run, answer);
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  /** Used by attempt and result checks to confirm the repo.read Lease is still valid. */
  public isLeaseValid(run: RunState): boolean {
    return this.#authorizationFor(run).isLeaseValid();
  }

  /** Called by Core's authorization timer in stage 1.5. */
  public async expireAuthorization(run: RunState): Promise<AuthorizationResolution | undefined> {
    if (run.runState !== 'RUNNING') return undefined;
    const answer = this.#authorizationFor(run).expire();
    if (answer === undefined) return undefined;
    await this.#applyAuthorizationResolution(run, answer);
    return answer;
  }

  /** Called when the run starts converging in stage 1.5. */
  public async cancelAuthorization(run: RunState): Promise<AuthorizationResolution | undefined> {
    const answer = this.#authorizationFor(run).cancel();
    if (answer === undefined) return undefined;
    await this.#applyAuthorizationResolution(run, answer);
    return answer;
  }

  async #cancelRun(
    request: Extract<GatewayForward, { requestType: 'cancelRun' }>['request'],
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (run.runState === 'RUNNING') this.#enterConverging(run, 'CANCELLED');
    return this.#remember(run, request.requestId, request, ack(request.requestId));
  }

  async #readArtifact(
    request: Extract<GatewayForward, { requestType: 'readArtifact' }>['request'],
    run: RunState,
  ): Promise<RunResponse> {
    const replay = await this.#lookup(run, request.requestId, request);
    if (replay !== undefined) return replay;
    if (!this.#execution.ownsArtifact(request.ref))
      return this.#reject(run, request.requestId, request, 'INVALID_ARTIFACT_REF');
    const content = await this.#execution.readArtifact(request.ref);
    if (!content.ok) return this.#reject(run, request.requestId, request, 'INVALID_ARTIFACT_REF');
    const response: ArtifactContent = {
      requestId: request.requestId,
      outcome: 'ACCEPTED',
      ref: request.ref,
      text: content.text,
    };
    return this.#remember(run, request.requestId, request, response);
  }

  #authorizationFor(run: RunState): AuthorizationManager {
    if (this.#authorization === undefined || this.#authorizationRunId !== run.workflowRunId) {
      this.#authorization = new AuthorizationManager({
        repositoryRoot: run.repositoryRoot,
        provider: this.#config.provider,
        repositoryExclusions: this.#config.repositoryExclusions,
        authorizationTimeoutMs: this.#config.authorizationTimeoutMs,
        now: this.#now,
      });
      this.#authorizationRunId = run.workflowRunId;
    }
    return this.#authorization;
  }

  async #applyAuthorizationResolution(
    run: RunState,
    answer: AuthorizationResolution,
  ): Promise<void> {
    const authorization = this.#authorizationFor(run);
    for (const requestId of answer.released) {
      const waiting = run.awaitingAuthorization.get(requestId);
      if (waiting === undefined) continue;
      if (answer.resolution === 'GRANTED') {
        const agentRun = run.agentRuns.get(waiting.agentRunId);
        if (agentRun === undefined) {
          run.unitDecisions.set(requestId, {
            kind: 'DECLINED',
            reasonCode: 'USER_DECLINED',
          });
        } else {
          run.unitDecisions.set(requestId, {
            kind: 'ALLOWED',
            scope: deriveExecutionScope(waiting.unit, agentRun, authorization.lease),
          });
        }
      } else if (answer.resolution === 'CANCELLED') {
        run.unitDecisions.set(requestId, { kind: 'CANCELLED' });
      } else {
        run.unitDecisions.set(requestId, {
          kind: 'DECLINED',
          reasonCode: 'USER_DECLINED',
        });
      }
      run.awaitingAuthorization.delete(requestId);
    }
    await this.#emit(answer.resolved);
    await this.#audit.append({
      at: this.#now().toISOString(),
      workflowRunId: run.workflowRunId,
      type: 'AUTHORIZATION_RESOLVED',
      questionId: answer.resolved.questionId,
      resolution: answer.resolution,
    });
  }

  async #emit(event: KernelToInteractionEvent): Promise<void> {
    await this.#events?.emit(event);
  }

  #enterConverging(
    run: RunState,
    closeReason: CloseReason,
    failure?: RunState['failure'],
    reportRef?: ArtifactRef,
  ): void {
    run.runState = 'CONVERGING';
    run.runEpoch += 1;
    run.convergingAt = this.#now().toISOString();
    run.closeReason = closeReason;
    if (failure !== undefined) run.failure = failure;
    if (reportRef !== undefined) run.reportRef = reportRef;
  }

  async #lookup(
    run: RunState,
    requestId: string,
    payload: unknown,
  ): Promise<RunResponse | undefined> {
    const lookup = run.requests.lookup<RunResponse>(requestId, payload);
    if (lookup.kind === 'replay') return lookup.response;
    if (lookup.kind === 'conflict') {
      const response = rejected(requestId, 'REQUEST_CONFLICT');
      await this.#audit.append({
        at: this.#now().toISOString(),
        workflowRunId: run.workflowRunId,
        type: 'REQUEST_REJECTED',
        requestId,
        reasonCode: 'REQUEST_CONFLICT',
      });
      return response;
    }
    return undefined;
  }

  #remember<T extends RunResponse>(
    run: RunState,
    requestId: string,
    payload: unknown,
    response: T,
  ): T {
    run.requests.remember(requestId, payload, response);
    return response;
  }

  async #runBlocked(run: RunState, requestId: string, payload: unknown): Promise<RunResponse> {
    if (run.closeReason === undefined) throw new Error('A non-RUNNING run must carry closeReason');
    return this.#reject(run, requestId, payload, 'RUN_BLOCKED', run.closeReason);
  }

  async #reject(
    run: RunState,
    requestId: string,
    payload: unknown,
    reasonCode: CoreRejectedCode | 'RUN_BLOCKED',
    closeReason?: RunState['closeReason'],
  ): Promise<RunResponse> {
    const response = rejected(requestId, reasonCode, closeReason);
    await this.#audit.append({
      at: this.#now().toISOString(),
      workflowRunId: run.workflowRunId,
      type: 'REQUEST_REJECTED',
      requestId,
      reasonCode,
    });
    return this.#remember(run, requestId, payload, response);
  }
}

function ack(requestId: string): SyscallAck {
  return { requestId, outcome: 'ACCEPTED' };
}

function rejected(
  requestId: string,
  reasonCode: CoreRejectedCode | 'RUN_BLOCKED',
  closeReason?: RunState['closeReason'],
): SyscallRejected {
  if (reasonCode === 'RUN_BLOCKED') {
    if (closeReason === undefined) throw new Error('RUN_BLOCKED requires closeReason');
    return { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode, closeReason };
  }
  return { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode };
}
