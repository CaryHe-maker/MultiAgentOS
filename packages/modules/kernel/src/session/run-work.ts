import {
  approvalDigestOf,
  isProjectInstructionPath,
  newId,
  normalizeRequestPath,
  writableRoots,
  type CommandInput,
  type DelegationReserved,
  type ReleaseDelegationRequest,
  type ReserveDelegationRequest,
  type SandboxProfile,
} from '@multiagentos/contracts';
import type {
  AnswerAuthorizationRequest,
  AuthorizationRequest,
  AuthorizationResolved,
  CloseReason,
  CoreRejectedCode,
  EndAgentRunRequest,
  ArtifactRef,
  ExecutionScope,
  MemoryLevel,
  ProjectFileContent,
  ReadProjectFileRequest,
  RegisterAgentRunRequest,
  RunSummary,
  SubmitUnitRequest,
  SyscallAck,
  SyscallRejected,
  TurnUsage,
  UnitDefinition,
  UnitReport,
  UnknownEffect,
  UpdateActivityRequest,
} from '@multiagentos/contracts';
import { RequestLedger } from './request-ledger.js';
import type { SchedulerDuties } from '../interfaces/index.js';
import { minShare, type RunLedgers } from '../monitor/index.js';
import type { AgentShare } from './pinned-agent.js';
import { RunDelegations, rootsWithin } from './run-delegations.js';
import {
  RunAttempts,
  type AttemptAudit,
  type AttemptFault,
  type AttemptSpec,
  type PinnedAgent,
} from './run-attempts.js';
import { RunActivity, type ActivityOutput } from './run-activity.js';
import { RunAuthorization, type QuestionResolved } from './run-authorization.js';
import { admitWork, readsProjectFile, type Decision, type RunControl } from './run-control.js';
import { admitUnit } from './unit-admission.js';
import {
  ceilingOf,
  type CapabilityCeiling,
  type CommandAnalysis,
  type CommandDemand,
  type UnitDecision,
} from './unit-decision.js';
import type { RetryingActivity } from './run-execution.js';
import { WallClocks } from './wall-clocks.js';

export type PinResult =
  | { readonly ok: true; readonly agent: PinnedAgent }
  | {
      readonly ok: false;
      readonly reasonCode: Extract<
        CoreRejectedCode,
        'DEFINITION_UNAVAILABLE' | 'DEFINITION_MISMATCH' | 'FORBIDDEN'
      >;
    };

/** The run as the Session actor owns it: control state, ordering and the Outbox stay there. */
export interface RunHost {
  readonly workflowRunId: string;
  control(): RunControl;
  closeReason(): CloseReason | undefined;
  runEpoch(): number;
  registerAgentRun(agentRunId: string): Decision;
  endAgentRun(agentRunId: string): Decision;
  attemptStarted(unitAttemptId: string): void;
  attemptEnded(unitAttemptId: string): void;
  toWorkflow(report: UnitReport): void;
  toInteraction(event: AuthorizationRequest | AuthorizationResolved | ActivityOutput): void;
  fault(fault: AttemptFault): void;
  /** Runs `work` as a control message of the actor; timers only do this. */
  enqueue(work: () => void): void;
}

/** What running commands needs from outside Core (Kernel/Core 5b); absent, no command runs. */
export interface CommandSupport {
  /** The line analysed with the lists applied; `text` is the line as the model wrote it. */
  readonly analyze: (command: string) => CommandAnalysis;
  /** What the probe at the start of the Session found. */
  readonly sandbox: () => 'AVAILABLE' | 'UNAVAILABLE';
  readonly unavailablePolicy: 'deny' | 'ask-unisolated';
  readonly homeReadOnly: readonly string[];
  readonly homeMaskedFiles: readonly string[];
  /** Hidden from commands when it lies outside the home directory (M2Design 6.1). */
  readonly dataDir?: string;
  /** The files to mask and the protected paths that exist, found by looking at the repository. */
  readonly scan: () => Promise<
    Pick<SandboxProfile, 'maskedFiles' | 'maskedDirs' | 'protectedExisting'>
  >;
}

export interface RunWorkDeps {
  readonly command?: CommandSupport;
  readonly host: RunHost;
  readonly ledgers: RunLedgers;
  readonly scheduler: SchedulerDuties;
  readonly provider: string;
  readonly technicalRetryLimit: number;
  readonly repositoryRoot: string;
  readonly repositoryExclusions: readonly string[];
  readonly pinAgent: (request: RegisterAgentRunRequest) => Promise<PinResult>;
  /** The share and the budget of an Agent a task names; absent: nothing can be delegated. */
  readonly agentShare?: (
    ref: ReserveDelegationRequest['tasks'][number]['agentRef'],
    context: { readonly sessionId: string; readonly workflowRunId: string },
  ) => AgentShare;
  readonly newDelegationId?: () => string;
  readonly inputIsValid: (unit: UnitDefinition, input: unknown) => boolean;
  readonly preset: 'standard' | 'readonly';
  readonly readProjectFile: (path: string, scope: ExecutionScope) => Promise<ProjectFileRead>;
  readonly isTrusted: (path: string, sha256: string) => boolean;
  readonly trust: (path: string, sha256: string) => Promise<void>;
  /** Keeps what a critical question shows; the question then only refers to it. */
  readonly storeQuestionContent: (text: string) => Promise<ArtifactRef>;
  /** Execution takes the attempt over and registers it through `attempts`. */
  readonly createAttempt: (spec: AttemptSpec, attempts: RunAttempts) => Promise<string>;
  /** Stops what is queued or running; every attempt still ends through `attempts`. */
  readonly cancelExecutions: (runEpoch: number) => void;
  readonly executionsClosed: () => void;
  /** Offers the call slots given back to the attempts that wait for one (M2Design 7.2). */
  readonly drainCapacityWaiters?: () => Promise<void>;
  readonly unknownEffects: () => UnknownEffect[];
  readonly audit: (entry: AttemptAudit) => void;
  readonly now: () => Date;
  readonly schedule: (delayMs: number, due: () => void) => () => void;
  /** The live memory level; a WARNING ends when it says the pressure is gone. */
  readonly memoryLevel?: () => MemoryLevel | undefined;
}

type Response = SyscallAck | SyscallRejected;
type Decided =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reasonCode: CoreRejectedCode | 'RUN_BLOCKED' };
type FileResponse = ProjectFileContent | SyscallRejected;

/** What Execution read; `truncated` says a question shows only the head of the file. */
export type ProjectFileRead =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly ref: ArtifactRef;
      readonly sha256: string;
      readonly text: string;
      readonly truncated: boolean;
    };

interface AgentRunRecord {
  /** The AgentRun that spawned this one; absent for a top-level AgentRun. */
  readonly parent?: string;
  readonly agent: PinnedAgent;
  readonly ceiling: CapabilityCeiling;
  state: 'ACTIVE' | 'ENDED';
  /** For the RunSummary. */
  readonly agentRef: RegisterAgentRunRequest['agentRef'];
  readonly registeredAt: string;
  endedAt?: string;
  rounds: number;
}

/** How a run ended, as the RunSummary repeats it. */
export type RunEnding = Pick<RunSummary, 'closeReason' | 'unknownEffects' | 'resultRef'> & {
  readonly failure?: Extract<RunSummary, { failure: unknown }>['failure'];
};

/** A request parked on a question: first `repo.read`, then trust in the exact content. */
interface WaitingFile {
  readonly request: ReadProjectFileRequest;
  readonly done: (response: FileResponse) => void;
  read?: Extract<ProjectFileRead, { exists: true }>;
}

interface WaitingUnit {
  readonly request: SubmitUnitRequest;
  readonly unit: UnitDefinition;
  readonly record: AgentRunRecord;
}

/** What a write shows when it asks; an edit has no whole new content yet (ExecutorSet 5b). */
function shownContent(input: SubmitUnitRequest['input']): string {
  if ('content' in input) return input.content;
  if ('oldString' in input) return `--- replaces\n${input.oldString}\n+++ with\n${input.newString}`;
  throw new Error('A write has neither content nor an edit');
}

const pathOf = (input: SubmitUnitRequest['input']): string | undefined =>
  'path' in input && typeof input.path === 'string' ? input.path : undefined;

/**
 * The Unit path of one run (Kernel/Interaction 7): request records, AgentRuns, admission, quotas,
 * authorization and attempts. Every method runs inside one message of the Session actor.
 */
export class RunWork {
  readonly #deps: RunWorkDeps;
  readonly #host: RunHost;
  readonly #requests = new RequestLedger();
  readonly #agentRuns = new Map<string, AgentRunRecord>();
  readonly #delegations = new RunDelegations();
  readonly #waiting = new Map<string, WaitingUnit>();
  readonly #waitingFiles = new Map<string, WaitingFile>();
  readonly #inFlight = new Map<string, number>();
  readonly #authorization: RunAuthorization;
  readonly #clocks: WallClocks;
  readonly #attempts: RunAttempts;
  readonly #activity: RunActivity;
  readonly #startedAt: string;
  /** Memory is short (Kernel/Core 5c): no new AgentRun, and the tools of running ones stop. */
  #memoryWarning = false;
  /** The run is being interrupted (Kernel/Core 5c): only the closing reply may still be published. */
  #interrupting = false;
  #turns = 0;
  #modelRequests = 0;
  readonly #units = { submitted: 0, ok: 0, rejected: 0, failed: 0 };

  public constructor(deps: RunWorkDeps) {
    this.#deps = deps;
    const { host } = deps;
    this.#host = host;
    this.#startedAt = deps.now().toISOString();
    this.#authorization = new RunAuthorization({
      repositoryRoot: deps.repositoryRoot,
      provider: deps.provider,
      repositoryExclusions: deps.repositoryExclusions,
      now: deps.now,
    });
    const activity = new RunActivity({ emit: (event) => host.toInteraction(event), now: deps.now });
    this.#activity = activity;
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
      deliver: (report, spec) => {
        host.toWorkflow(report);
        activity.reported(spec, report);
        this.#counted(report);
      },
      attemptStarted: (spec, unitAttemptId) => {
        this.#countInFlight(spec.agentRunId, 1);
        host.attemptStarted(unitAttemptId);
        activity.queued(spec, unitAttemptId);
      },
      attemptRunning: (spec, unitAttemptId, final) => {
        if (spec.unit.executionKind === 'MODEL') this.#modelRequests += 1;
        activity.running(spec, unitAttemptId, final);
      },
      attemptEnded: (spec, unitAttemptId) => {
        this.#countInFlight(spec.agentRunId, -1);
        this.#authorization.attemptEnded(spec.requestId);
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

  /** At the end of every message of the actor: the slots given back go to those who wait. */
  async drainCapacityWaiters(): Promise<void> {
    await this.#deps.drainCapacityWaiters?.();
  }

  setMemoryWarning(): void {
    this.#memoryWarning = true;
  }

  /**
   * New work is refused while this process is short of memory. The live level decides, so a
   * Turn after an interrupt is refused with the reason while the pressure lasts and accepted as
   * soon as it has fallen; without a live level the message that raised the warning decides.
   */
  #underWarning(): boolean {
    if (this.#interrupting) return true;
    if (this.#deps.memoryLevel !== undefined) return this.#deps.memoryLevel() !== undefined;
    return this.#memoryWarning;
  }

  openTurn(turnId: string): void {
    this.#turns += 1;
    this.#deps.ledgers.openTurnLedger(turnId);
  }

  #counted(report: UnitReport): void {
    if (report.status === 'OK') this.#units.ok += 1;
    else if (report.status === 'REJECTED') this.#units.rejected += 1;
    else this.#units.failed += 1;
    const record = this.#agentRuns.get(report.agentRunId);
    if (record !== undefined && report.executionKind === 'MODEL' && report.status !== 'REJECTED')
      record.rounds += 1;
  }

  /** The run record of Execution (RunSummary), once the run closed and its last Turn too. */
  summary(ids: { readonly sessionId: string }, ending: RunEnding): RunSummary {
    const closedAt = this.#deps.now();
    const delivered = this.#units.ok + this.#units.rejected + this.#units.failed;
    return {
      workflowRunId: this.#host.workflowRunId,
      sessionId: ids.sessionId,
      startedAt: this.#startedAt,
      closedAt: closedAt.toISOString(),
      durationMs: Math.max(0, closedAt.getTime() - Date.parse(this.#startedAt)),
      turns: this.#turns,
      agentRuns: [...this.#agentRuns].map(([agentRunId, record]) => ({
        agentRunId,
        agentRef: record.agentRef,
        registeredAt: record.registeredAt,
        ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
        rounds: record.rounds,
        finalCallUsed: this.#attempts.usedFinalCall(agentRunId),
      })),
      units: { ...this.#units, notDelivered: this.#units.submitted - delivered },
      model: { requests: this.#modelRequests },
      tokens: this.#deps.ledgers.usage(),
      ...ending,
    } as RunSummary;
  }

  closeTurn(turnId: string): TurnUsage {
    return this.#deps.ledgers.closeTurnLedger(turnId);
  }

  #refuse(
    requestId: string,
    payload: unknown,
    reasonCode: CoreRejectedCode | 'RUN_BLOCKED',
  ): Response {
    let response: SyscallRejected;
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

  /** Idempotency for a request whose decision lives in the actor. */
  async once(
    requestId: string,
    payload: unknown,
    decide: () => Promise<Decided> | Decided,
  ): Promise<Response> {
    const replay = this.#replay(requestId, payload);
    if (replay !== undefined) return replay;
    const decision = await decide();
    return decision.accepted
      ? this.#accept(requestId, payload)
      : this.#refuse(requestId, payload, decision.reasonCode);
  }

  async registerAgentRun(request: RegisterAgentRunRequest): Promise<Response> {
    const { requestId, agentRunId, parentAgentRunId, delegationId, taskName } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const admitted = admitWork(this.#host.control());
    if (!admitted.accepted) return this.#refuse(requestId, request, admitted.reasonCode);
    if (this.#agentRuns.has(agentRunId))
      return this.#refuse(requestId, request, 'AGENT_RUN_EXISTS');
    if (this.#underWarning()) return this.#refuse(requestId, request, 'MEMORY_PRESSURE');
    // A SubAgent names its parent, the delegation that funds it and its task: all three or none.
    const given = [parentAgentRunId, delegationId, taskName].filter((each) => each !== undefined);
    if (given.length !== 0 && given.length !== 3)
      return this.#refuse(requestId, request, 'INVALID_INPUT');
    const child =
      parentAgentRunId !== undefined && delegationId !== undefined && taskName !== undefined
        ? { parentAgentRunId, delegationId, taskName }
        : undefined;
    // A top-level AgentRun is alone until Orchestration runs several (M2Design 2.3).
    if (
      child === undefined &&
      [...this.#agentRuns.values()].some(
        (each) => each.state === 'ACTIVE' && each.parent === undefined,
      )
    )
      return this.#refuse(requestId, request, 'AGENT_RUN_ACTIVE');
    const parent = child === undefined ? undefined : this.#agentRuns.get(child.parentAgentRunId);
    if (child !== undefined) {
      if (parent === undefined) return this.#refuse(requestId, request, 'AGENT_RUN_NOT_FOUND');
      if (parent.state === 'ENDED') return this.#refuse(requestId, request, 'AGENT_RUN_ENDED');
    }

    const pinned = await this.#deps.pinAgent(request);
    if (!pinned.ok) return this.#refuse(requestId, request, pinned.reasonCode);
    const ceiling = ceilingOf({
      agentCapabilities: pinned.agent.capabilities,
      requestedCapabilities: request.requestedCapabilities,
      writeRoots: request.writeRoots,
      preset: this.#deps.preset,
      exclusions: this.#authorization.exclusions,
    });
    if (!ceiling.ok) return this.#refuse(requestId, request, ceiling.reasonCode);
    const roots = writableRoots(ceiling.ceiling);
    if (child !== undefined && parent !== undefined) {
      // A SubAgent can do no more than its parent, never spawns, and writes only where its task may.
      const task = this.#delegations.taskOf(child.delegationId, child.taskName);
      if (
        task === undefined ||
        this.#delegations.parentOf(child.delegationId) !== child.parentAgentRunId
      )
        return this.#refuse(requestId, request, 'DELEGATION_NOT_FOUND');
      const beyond = [...ceiling.ceiling.capabilities].some(
        (capability) =>
          capability === 'agent.spawn' || !parent.ceiling.capabilities.has(capability),
      );
      if (beyond || !rootsWithin(roots, task.roots))
        return this.#refuse(requestId, request, 'CAPABILITY_NOT_SUBSET');
    }
    // Running AgentRuns write apart from each other (M2Design 6.4).
    const writes = ceiling.ceiling.capabilities.has('workspace.write');
    const holders = [...this.#agentRuns].map(([id, each]) => ({
      agentRunId: id,
      parent: each.parent,
      running: each.state === 'ACTIVE',
      roots: each.ceiling.capabilities.has('workspace.write') ? writableRoots(each.ceiling) : [],
    }));
    const ancestors = this.#delegations.ancestorsOf(
      child?.parentAgentRunId,
      (id) => this.#agentRuns.get(id)?.parent,
    );
    if (
      this.#delegations.conflict(holders, { ancestors, roots: writes ? roots : [] }) !== undefined
    )
      return this.#refuse(requestId, request, 'WRITE_SCOPE_CONFLICT');
    const registered = this.#host.registerAgentRun(agentRunId);
    if (!registered.accepted) return this.#refuse(requestId, request, registered.reasonCode);
    // The ledger of the AgentRun: a SubAgent spends its own share, the others the Turn's.
    if (child !== undefined) {
      this.#delegations.claim(
        child.delegationId,
        child.parentAgentRunId,
        child.taskName,
        agentRunId,
      );
      this.#deps.ledgers.registerAgentRun({
        agentRunId,
        delegationId: child.delegationId,
        taskName: child.taskName,
        agent: pinned.agent.budget,
      });
    } else this.#deps.ledgers.registerTopLevel(agentRunId, pinned.agent.budget);
    this.#agentRuns.set(agentRunId, {
      ...(child === undefined ? {} : { parent: child.parentAgentRunId }),
      agent: pinned.agent,
      ceiling: ceiling.ceiling,
      state: 'ACTIVE',
      agentRef: request.agentRef,
      registeredAt: this.#deps.now().toISOString(),
      rounds: 0,
    });
    this.#activity.registered(agentRunId, request.display.label);
    this.#clocks.register(agentRunId, pinned.agent.maxWallClockMs);
    return this.#accept(requestId, request);
  }

  endAgentRun(request: EndAgentRunRequest): Response {
    const { requestId, agentRunId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const { phase } = this.#host.control();
    if (phase === 'CONVERGING' || phase === 'CLOSED') return this.#accept(requestId, request);
    const record = this.#agentRuns.get(agentRunId);
    if (record === undefined) return this.#refuse(requestId, request, 'AGENT_RUN_NOT_FOUND');
    if (record.state === 'ENDED') return this.#refuse(requestId, request, 'AGENT_RUN_ENDED');
    record.state = 'ENDED';
    record.endedAt = this.#deps.now().toISOString();
    this.#clocks.end(agentRunId);
    this.#activity.ended(agentRunId);
    // The unused part of a SubAgent's share goes back to its parent at once (M2Design 7.3, rule 4).
    this.#deps.ledgers.endAgentRun(agentRunId);
    this.#delegations.childEnded(agentRunId);
    const ended = this.#host.endAgentRun(agentRunId);
    if (!ended.accepted) return this.#refuse(requestId, request, ended.reasonCode);
    return this.#accept(requestId, request);
  }

  /**
   * Takes the shares of all the tasks of a `run_subagents` call out of the parent's ledger, or none
   * (M2Design 3.6, 7.3). The parent holds no write roots from now until its children have ended.
   */
  async reserveDelegation(
    request: ReserveDelegationRequest,
  ): Promise<DelegationReserved | SyscallRejected> {
    const { requestId, parentAgentRunId } = request;
    const refuse = (reasonCode: CoreRejectedCode | 'RUN_BLOCKED') =>
      this.#refuse(requestId, request, reasonCode) as SyscallRejected;
    const replay = this.#replay(requestId, request) as
      DelegationReserved | SyscallRejected | undefined;
    if (replay !== undefined) return replay;
    const admitted = admitWork(this.#host.control());
    if (!admitted.accepted) return refuse(admitted.reasonCode);
    if (this.#underWarning()) return refuse('MEMORY_PRESSURE');
    const parent = this.#agentRuns.get(parentAgentRunId);
    if (parent === undefined) return refuse('AGENT_RUN_NOT_FOUND');
    if (parent.state === 'ENDED') return refuse('AGENT_RUN_ENDED');
    // Only an AgentRun with `agent.spawn` in its ceiling spawns (M2Design 5.4, layer 3).
    if (!parent.ceiling.capabilities.has('agent.spawn') || this.#deps.agentShare === undefined)
      return refuse('FORBIDDEN');
    const names = new Set(request.tasks.map((task) => task.name));
    if (names.size !== request.tasks.length) return refuse('INVALID_INPUT');
    const parentRoots = writableRoots(parent.ceiling);
    const context = { sessionId: request.sessionId, workflowRunId: request.workflowRunId };
    const tasks: { name: string; roots: string[]; tokens: number; clamped?: 'MIN' | 'MAX' }[] = [];
    for (const task of request.tasks) {
      const share = this.#deps.agentShare(task.agentRef, context);
      if (!share.ok) return refuse(share.reasonCode);
      if (share.defaultShare === undefined) return refuse('FORBIDDEN');
      const roots = task.writeRoots.flatMap((root) => normalizeRequestPath(root) ?? []);
      if (roots.length !== task.writeRoots.length) return refuse('INVALID_INPUT');
      if (!rootsWithin(roots, parentRoots)) return refuse('CAPABILITY_NOT_SUBSET');
      // Between the least the Agent can work with and twice what it gets by default.
      const least = minShare(share.budget);
      const most = 2 * share.defaultShare;
      const asked = task.tokens ?? share.defaultShare;
      const tokens = Math.min(most, Math.max(least, asked));
      tasks.push({
        name: task.name,
        roots,
        tokens,
        ...(tokens > asked
          ? { clamped: 'MIN' as const }
          : tokens < asked
            ? { clamped: 'MAX' as const }
            : {}),
      });
    }
    const delegationId = this.#deps.newDelegationId?.() ?? newId('dlg');
    const result = this.#deps.ledgers.reserveDelegation({
      delegationId,
      parentAgentRunId,
      shares: tasks.map((task) => ({ name: task.name, tokens: task.tokens })),
    });
    if (!result.ok) {
      const response: SyscallRejected = {
        requestId,
        outcome: 'REJECTED',
        issuer: 'CORE',
        reasonCode: 'BUDGET_INSUFFICIENT',
        delegable: result.delegable,
      };
      this.#requests.remember(requestId, request, response);
      return response;
    }
    this.#delegations.create(delegationId, parentAgentRunId, tasks);
    const response: DelegationReserved = {
      requestId,
      outcome: 'ACCEPTED',
      delegationId,
      shares: tasks.map(({ name, tokens, clamped }) => ({
        name,
        tokens,
        ...(clamped === undefined ? {} : { clamped }),
      })),
    };
    this.#requests.remember(requestId, request, response);
    return response;
  }

  /** The shares of the tasks that never registered go back to the parent (M2Design 7.3, rule 3). */
  releaseDelegation(request: ReleaseDelegationRequest): Response {
    const { requestId, delegationId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    const { phase } = this.#host.control();
    if (phase === 'CONVERGING' || phase === 'CLOSED') return this.#accept(requestId, request);
    if (!this.#delegations.has(delegationId))
      return this.#refuse(requestId, request, 'DELEGATION_NOT_FOUND');
    this.#deps.ledgers.releaseDelegation(delegationId);
    this.#delegations.release(delegationId);
    return this.#accept(requestId, request);
  }

  async submitUnit(request: SubmitUnitRequest): Promise<Response> {
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
    this.#units.submitted += 1;

    if (this.#interrupting && unit.executionKind !== 'MESSAGE_PUBLISH')
      return this.#refuse(requestId, request, 'MEMORY_PRESSURE');
    // The roots of a parent are its children's while they run; it is waiting and writes nothing
    // (M2Design 6.4). This only guards the case where it submits all the same.
    if (
      this.#delegations.isDelegated(request.agentRunId) &&
      (unit.executionKind === 'FILE_WRITE' ||
        unit.executionKind === 'FILE_EDIT' ||
        unit.executionKind === 'COMMAND')
    ) {
      this.#refuseUnit(request, unit, { reasonCode: 'WRITE_SCOPE_DELEGATED' });
      return response;
    }
    if (admission.countsAsTool && this.#underWarning()) {
      this.#refuseUnit(request, unit, { reasonCode: 'QUOTA_EXHAUSTED', quota: 'MEMORY' });
      return response;
    }
    if (admission.countsAsTool) {
      const quota = this.#deps.ledgers.countToolUnit(request.agentRunId, record.agent.maxToolUnits);
      if (!quota.ok) {
        this.#refuseUnit(request, unit, { reasonCode: 'QUOTA_EXHAUSTED', quota: quota.quota });
        return response;
      }
    }
    await this.#decide({ request, unit, record });
    return response;
  }

  /** Kernel/Core 5a.3; an answer to a question comes back here, because it only adds an entry. */
  async #decide(waiting: WaitingUnit): Promise<void> {
    const { request, unit, record } = waiting;
    let readOnly = false;
    for (const capability of unit.protectedCapabilities) {
      const path = pathOf(request.input);
      const command = capability === 'command.exec' ? this.#commandDemand(request) : undefined;
      if (capability === 'command.exec' && command === undefined) {
        this.#refuseUnit(request, unit, { reasonCode: 'ADMISSION_CHECK_FAILED' });
        return;
      }
      const decision = this.#authorization.decide(
        {
          requestId: request.requestId,
          agentRunId: request.agentRunId,
          capability,
          ...(path === undefined ? {} : { path }),
          ...(command === undefined ? {} : { command }),
        },
        record.ceiling,
      );
      if (decision.kind === 'ALLOW' && decision.readOnly === true) readOnly = true;
      if (decision.kind === 'REFUSE') {
        this.#refuseUnit(request, unit, { reasonCode: decision.reasonCode });
        return;
      }
      if (decision.kind === 'ASK') {
        await this.#ask(waiting, decision);
        return;
      }
    }
    await this.#startAttempt(request, unit, record, readOnly);
  }

  async #ask(waiting: WaitingUnit, decision: Extract<UnitDecision, { kind: 'ASK' }>) {
    const { requestId, agentRunId, input } = waiting.request;
    let check;
    if (decision.capability === 'command.exec') check = this.#askCommand(waiting, decision);
    else if (decision.capability === 'repo.read')
      check = this.#authorization.requireRepoRead(requestId, agentRunId);
    else if (decision.critical) {
      const path = pathOf(input);
      if (path === undefined) throw new Error('A critical write has no path');
      const contentRef = await this.#deps.storeQuestionContent(shownContent(input));
      check = this.#authorization.askWrite(
        { critical: true, path, contentRef },
        requestId,
        agentRunId,
      );
    } else
      check = this.#authorization.askWrite(
        { critical: false, writeRoot: decision.resourceKey },
        requestId,
        agentRunId,
      );
    if (check.requested !== undefined) this.#host.toInteraction(check.requested);
    this.#waiting.set(requestId, waiting);
    this.#activity.awaitingAuthorization(agentRunId);
  }

  #commandDemand(request: SubmitUnitRequest): CommandDemand | undefined {
    const support = this.#deps.command;
    if (support === undefined || !('command' in request.input) || !('timeoutMs' in request.input))
      return undefined;
    const { input } = request as { input: CommandInput };
    return {
      analysis: support.analyze(input.command),
      workdir: input.workdir,
      network: input.network,
      sandbox: support.sandbox(),
      unavailablePolicy: support.unavailablePolicy,
      repoReadGranted: this.#authorization.lease !== undefined,
    };
  }

  #askCommand(waiting: WaitingUnit, decision: Extract<UnitDecision, { kind: 'ASK' }>) {
    const { request, record } = waiting;
    const demand = this.#commandDemand(request);
    if (demand === undefined) throw new Error('A command question has no command');
    const input = request.input as CommandInput;
    const unisolated = demand.sandbox === 'UNAVAILABLE';
    const roots = [...writableRoots(record.ceiling)];
    return this.#authorization.askCommand(
      {
        analysis: demand.analysis,
        workdir: input.workdir,
        writableRoots: roots,
        network: input.network,
        unisolated,
        approvalDigest: approvalDigestOf({
          command: input.command,
          workdir: input.workdir,
          network: input.network,
          writableRoots: roots,
          backend: unisolated ? 'UNISOLATED' : 'BWRAP',
        }),
      },
      decision.critical,
      request.requestId,
      request.agentRunId,
    );
  }

  #refuseUnit(
    request: SubmitUnitRequest,
    unit: UnitDefinition,
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

  /** Where a command runs and with what; the scanned lists are not part of what was approved. */
  async #commandScope(
    request: SubmitUnitRequest,
    record: AgentRunRecord,
    readOnly: boolean,
  ): Promise<ExecutionScope> {
    const support = this.#deps.command;
    if (support === undefined) throw new Error('A command needs the command support');
    const input = request.input as CommandInput;
    const backend = support.sandbox() === 'UNAVAILABLE' ? 'UNISOLATED' : 'BWRAP';
    // A line of the read-only list runs where nothing can be written, whatever the AgentRun may.
    const roots = readOnly ? [] : [...writableRoots(record.ceiling)];
    return {
      kind: 'SANDBOX',
      backend,
      approvalDigest: approvalDigestOf({
        command: input.command,
        workdir: input.workdir,
        network: input.network,
        writableRoots: roots,
        backend,
      }),
      profile: {
        repositoryRoot: this.#deps.repositoryRoot,
        workdir: input.workdir,
        writableRoots: roots,
        network: input.network,
        homeReadOnly: [...support.homeReadOnly],
        homeMaskedFiles: [...support.homeMaskedFiles],
        ...(support.dataDir === undefined ? {} : { dataDir: support.dataDir }),
        ...(await support.scan()),
      },
    };
  }

  #scopeOf(unit: UnitDefinition, record: AgentRunRecord): ExecutionScope {
    if (unit.executionKind === 'MODEL') return record.agent.modelScope;
    if (unit.protectedCapabilities.includes('workspace.write'))
      return {
        kind: 'WORKSPACE',
        repositoryRoot: this.#deps.repositoryRoot,
        writableRoots: [...writableRoots(record.ceiling)],
        exclusions: [...record.ceiling.exclusions],
      };
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
    request: SubmitUnitRequest,
    unit: UnitDefinition,
    record: AgentRunRecord,
    readOnly = false,
  ): Promise<void> {
    const { turnId } = this.#host.control();
    if (turnId === undefined) throw new Error('A Unit starts only in an open Turn');
    let scope: ExecutionScope;
    try {
      scope =
        unit.executionKind === 'COMMAND'
          ? await this.#commandScope(request, record, readOnly)
          : this.#scopeOf(unit, record);
    } catch (error) {
      // E.g. the repository is too large to scan for secrets: the command does not run unmasked.
      if (unit.executionKind !== 'COMMAND') throw error;
      this.#refuseUnit(request, unit, { reasonCode: 'ADMISSION_CHECK_FAILED' });
      return;
    }
    if (readOnly && unit.executionKind === 'COMMAND')
      this.#deps.audit({
        type: 'COMMAND_READ_ONLY',
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        command: (request.input as CommandInput).command,
        workdir: (request.input as CommandInput).workdir,
      });
    await this.#attempts.start({
      requestId: request.requestId,
      agentRunId: request.agentRunId,
      unitRunId: request.unitRunId,
      turnId,
      unit,
      input: request.input,
      scope,
      runEpoch: this.#host.runEpoch(),
      agent: record.agent,
      display: request.display,
    });
  }

  /** Execution waits before the next try; Core says so in the activity area (Kernel/Execution 4a). */
  retrying(retry: RetryingActivity): void {
    this.#activity.retrying(retry.spec, retry.unitAttemptId, retry.attempt, retry.retryAt);
  }

  async answerAuthorization(request: AnswerAuthorizationRequest): Promise<Response> {
    const { requestId } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    if (!this.#authorization.offers(request.questionId, request.answer.scope))
      return this.#refuse(requestId, request, 'INVALID_INPUT');
    const settled = this.#authorization.answer(request.questionId, request.answer.scope);
    if (settled === undefined) return this.#refuse(requestId, request, 'QUESTION_NOT_PENDING');
    this.#host.toInteraction(settled.resolved);
    await this.#release(settled);
    return this.#accept(requestId, request);
  }

  async #release(settled: QuestionResolved): Promise<void> {
    for (const requestId of settled.waiters) {
      const file = this.#waitingFiles.get(requestId);
      if (file !== undefined) {
        await this.#continueFile(file, settled.resolution === 'GRANTED');
        continue;
      }
      const waiting = this.#waiting.get(requestId);
      if (waiting === undefined) continue;
      this.#waiting.delete(requestId);
      await this.#decide(waiting);
    }
  }

  /**
   * Answers later than the message that asked: the request may wait on the user, and a handler
   * that waited here would block the answer behind it. The caller awaits `response` outside.
   */
  async readProjectFile(
    request: ReadProjectFileRequest,
  ): Promise<{ readonly response: Promise<FileResponse> }> {
    const { requestId } = request;
    const replay = this.#requests.lookup<FileResponse>(requestId, request);
    if (replay.kind === 'replay') return { response: Promise.resolve(replay.response) };
    const refused = (reasonCode: 'REQUEST_CONFLICT' | 'RUN_BLOCKED') => ({
      response: Promise.resolve(this.#refuse(requestId, request, reasonCode) as SyscallRejected),
    });
    if (replay.kind === 'conflict') return refused('REQUEST_CONFLICT');
    if (!readsProjectFile(this.#host.control()).accepted) return refused('RUN_BLOCKED');

    let done: WaitingFile['done'] = () => undefined;
    const response = new Promise<FileResponse>((resolve) => {
      done = (result) => {
        this.#waitingFiles.delete(requestId);
        this.#requests.remember(requestId, request, result);
        resolve(result);
      };
    });
    const file: WaitingFile = { request, done };
    const { decision, requested } = this.#authorization.requireRepoRead(requestId);
    if (requested !== undefined) this.#host.toInteraction(requested);
    if (decision.kind === 'ALLOWED') await this.#continueFile(file, true);
    else if (decision.kind === 'DECLINED') await this.#continueFile(file, false);
    else this.#waitingFiles.set(requestId, file);
    return { response };
  }

  async #continueFile(file: WaitingFile, granted: boolean): Promise<void> {
    const { requestId, path } = file.request;
    const accepted = { requestId, outcome: 'ACCEPTED' } as const;
    if (file.read !== undefined) {
      if (granted) await this.#deps.trust(path, file.read.sha256);
      this.#answerInstructions(file, file.read, granted);
      return;
    }
    if (!granted) {
      file.done({ requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode: 'USER_DECLINED' });
      return;
    }
    const { lease } = this.#authorization;
    if (lease === undefined) throw new Error('A project file needs a valid Lease');
    const read = await this.#deps.readProjectFile(path, {
      kind: 'REPOSITORY',
      repositoryRoot: lease.repositoryRoot,
      exclusions: [...lease.exclusions],
    });
    if (!read.exists) {
      file.done({ ...accepted, path, exists: false });
      return;
    }
    if (!isProjectInstructionPath(path)) {
      const { ref, sha256, text } = read;
      file.done({ ...accepted, path, exists: true, ref, sha256, text });
      return;
    }
    if (this.#deps.isTrusted(path, read.sha256)) {
      this.#answerInstructions(file, read, true);
      return;
    }
    if (this.#deps.preset === 'readonly') {
      this.#answerInstructions(file, read, false);
      return;
    }
    const { decision, requested } = this.#authorization.askInstructions(
      { path, sha256: read.sha256, contentRef: read.ref, truncated: read.truncated },
      requestId,
    );
    if (requested !== undefined) this.#host.toInteraction(requested);
    if (decision.kind === 'PENDING') {
      file.read = read;
      this.#waitingFiles.set(requestId, file);
    } else this.#answerInstructions(file, read, false);
  }

  #answerInstructions(
    file: WaitingFile,
    read: Extract<ProjectFileRead, { exists: true }>,
    trusted: boolean,
  ): void {
    file.done({
      requestId: file.request.requestId,
      outcome: 'ACCEPTED',
      path: file.request.path,
      exists: true,
      ref: read.ref,
      sha256: read.sha256,
      trusted,
    });
  }

  /** Only for the interface: goes into the AgentRun's next ActivityEvents as it came. */
  updateActivity(request: UpdateActivityRequest): Response {
    const { requestId, agentRunId, todos } = request;
    const replay = this.#replay(requestId, request);
    if (replay !== undefined) return replay;
    if (this.#agentRuns.get(agentRunId)?.state !== 'ACTIVE')
      return this.#refuse(requestId, request, 'AGENT_RUN_NOT_FOUND');
    this.#activity.todos(agentRunId, todos);
    return this.#accept(requestId, request);
  }

  /**
   * An AgentRun's clock stops while it only waits for the user: nothing dispatched or queued, and
   * a question open on one of its Units (Kernel/Monitor 3).
   */
  reconcile(): void {
    const waitingFor = new Set([...this.#waiting.values()].map((w) => w.request.agentRunId));
    this.#clocks.reconcile(
      (agentRunId) =>
        ((waitingFor.has(agentRunId) || this.#waitingFiles.size > 0) &&
          (this.#inFlight.get(agentRunId) ?? 0) === 0) ||
        // Waiting for its SubAgents is not working (Kernel/Monitor 4).
        ((this.#inFlight.get(agentRunId) ?? 0) === 0 && this.#delegations.isDelegated(agentRunId)),
    );
  }

  /** The run started converging: Units on a question end with it and get no report. */
  /**
   * INTERRUPTING (Kernel/Core 5c): what runs is cancelled and nothing new starts, but the run
   * stays open so that Workflow can publish the reply that says what happened and close it. The
   * facts of the cancelled work still arrive; Workflow no longer waits for them.
   */
  beginInterrupt(backstopMs: number, due: () => void): void {
    this.#interrupting = true;
    this.#memoryWarning = true;
    for (const settled of this.#authorization.cancelQuestions())
      this.#host.toInteraction(settled.resolved);
    this.#waiting.clear();
    this.#clocks.stop();
    this.#deps.cancelExecutions(this.#host.runEpoch());
    // If Workflow does not close the run, the Kernel does, so that memory is not held for ever.
    this.#deps.schedule(backstopMs, () => {
      this.#host.enqueue(due);
    });
  }

  beginClosing(): void {
    for (const settled of this.#authorization.cancelQuestions())
      this.#host.toInteraction(settled.resolved);
    this.#waiting.clear();
    for (const file of [...this.#waitingFiles.values()])
      file.done(
        this.#refuse(file.request.requestId, file.request, 'RUN_BLOCKED') as SyscallRejected,
      );
    this.#clocks.stop();
    this.#deps.cancelExecutions(this.#host.runEpoch());
  }

  unknownEffects(): UnknownEffect[] {
    return this.#deps.unknownEffects();
  }

  /** Nothing is in flight any more, so the Lease can end. */
  finishClosing(): void {
    this.#authorization.endLease();
    this.#deps.executionsClosed();
  }
}
