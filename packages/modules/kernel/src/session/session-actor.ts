import {
  newId,
  type ArtifactRef,
  type CloseReason,
  type DefinitionRef,
  type HumanRequest,
  type InterruptReason,
  type KernelToWorkflowEvent,
  type ReportSessionCommandRequest,
  type RunFailure,
  type RunFinished,
  type RequestHumanRequest,
  type RunSummary,
  type SyscallRejected,
  type TurnDiff,
  type UndoCancelled,
  type UserInput,
  type WorkspaceReverted,
} from '@multiagentos/contracts';
import { Inbox } from '@multiagentos/fabric';
import {
  answerOpenInput,
  attemptEnded,
  answerLocalQuestion,
  attemptStarted,
  beginConvergence,
  beginInterrupt,
  closeRun,
  endAgentRun,
  initialRunControl,
  openInitialTurn,
  pauseReached,
  pauseRun,
  registerAgentRun,
  requestLocalQuestion,
  requestOpenInput,
  resumeRun,
  steerRun,
  admitWork,
  type TurnEnd,
  type Decision,
  type RunControl,
} from './run-control.js';
import type { MemoryLevel } from '@multiagentos/contracts';
import type { AttemptFault } from './run-attempts.js';
import { WallClocks } from './wall-clocks.js';
import type { RunHost, RunWork } from './run-work.js';
import type { KernelOutbox } from './session-outbox.js';
import type { UndoPlan, WorkspaceSnapshots } from './workspace-snapshots.js';

/**
 * One Session's Inbox and serial loop (Kernel/Interaction 5.2). The actor owns ordering, the
 * Session lifecycle, runs and Turns; everything about attempts, artifacts and ledgers is asked of
 * `SessionDuties`, so these rules do not depend on how a Unit is executed.
 */
export interface SessionDuties {
  storeUserInput(input: UserInput): Promise<ArtifactRef>;
  /** Absent when writes are off (`readonly`, or no git): nothing is captured or undone. */
  readonly snapshots?: Pick<
    WorkspaceSnapshots,
    'turnStarted' | 'turnEnded' | 'planUndo' | 'applyUndo' | 'diffTurn' | 'divergedFiles'
  >;
  /** The name of a Session, read from the artifact its list entry refers to. */
  titleOf?(ref: ArtifactRef): Promise<string | undefined>;
  /** A fork takes over what the copied log refers to. */
  inheritArtifacts?(fromSessionId: string, refs: readonly ArtifactRef[]): Promise<void>;
  /** Keeps the text of a diff; the answer only refers to it. */
  storeDiff?(text: string): Promise<ArtifactRef>;
  /** The Unit path of a new run. */
  openRunWork(host: RunHost): RunWork;
  /** Writes the RunSummary; undefined means the write failed and the run ends without one. */
  /** Writes the run record; undefined when it could not be stored. */
  writeRunSummary(summary: RunSummary): Promise<ArtifactRef | undefined>;
  /** A new Session could not be created: its reference and everything written for it go. */
  discardSession(): Promise<void>;
}

export type SessionStart =
  | {
      readonly kind: 'NEW';
      readonly requestId: string;
      readonly input: UserInput;
      readonly template?: DefinitionRef;
    }
  | {
      readonly kind: 'FORK';
      readonly requestId: string;
      readonly input: UserInput;
      readonly fromSessionId: string;
    }
  | { readonly kind: 'OPEN'; readonly requestId: string };

export type RunClosing =
  | {
      readonly closeReason: Exclude<CloseReason, 'FAILED' | 'VIOLATION'>;
      readonly resultRef?: ArtifactRef;
    }
  | { readonly closeReason: 'FAILED' | 'VIOLATION'; readonly failure: RunFailure };

export interface SessionActorDeps {
  readonly sessionId: string;
  readonly repositoryRoot: string;
  readonly outbox: KernelOutbox;
  readonly duties: SessionDuties;
  readonly preset?: 'standard' | 'readonly';
  readonly newTurnId?: () => string;
  /** The actor is finished: Session management takes it out. */
  readonly onClosed: (sessionId: string) => void;
  readonly onFatal: (error: unknown) => void;
  /** A run ended because of memory pressure (Kernel/Core 5c): the system now exits in control. */
  readonly onInterrupted?: () => void;
  /** How long Workflow has to close an interrupted run before the Kernel does. */
  readonly interruptBackstopMs?: number;
  /** The Turn and pause limits of Kernel/Core 5e; the defaults are those of M2Design 7.4. */
  readonly timeouts?: {
    readonly turnMs: number;
    readonly orchestrationMs: number;
    readonly pauseMs: number;
  };
  readonly now?: () => number;
  /** Arms a timer that only enqueues; returns its cancel. */
  readonly schedule?: (delayMs: number, due: () => void) => () => void;
  /** What Gateway may let in; pushed on every change of a run. */
  readonly admission: (
    workflowRunId: string,
    runState: 'RUNNING' | 'CONVERGING' | 'CLOSED',
    closeReason?: CloseReason,
  ) => void;
}

type Message =
  | { readonly kind: 'SESSION_BEGIN'; readonly start: SessionStart }
  | { readonly kind: 'SESSION_CLOSE'; readonly reason: 'SWITCHED' | 'SHUTDOWN' }
  | { readonly kind: 'COMMAND_REPORT'; readonly report: ReportSessionCommandRequest }
  | { readonly kind: 'CALL'; readonly work: () => Promise<unknown> };

const DEFAULT_TIMEOUTS = { turnMs: 1_800_000, orchestrationMs: 3_600_000, pauseMs: 1_800_000 };

interface Run {
  readonly workflowRunId: string;
  readonly work: RunWork;
  readonly mode: 'CHAT' | 'ORCHESTRATION';
  /** The Turn's working time: it stops while paused and while all work waits for the user. */
  readonly turnClock: WallClocks;
  /** Ends the wait for a pause to run out. */
  pauseTimer?: () => void;
  control: RunControl;
  runEpoch: number;
  closing?: RunClosing;
  /** The Turn that ends once the run has drained, just before RunClosed. */
  closingTurn?: string;
  fault?: AttemptFault;
}

type Pending = (result: ReportSessionCommandRequest['result']) => Promise<void>;

export type UndoDecision =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reasonCode: 'UNDO_NOT_AVAILABLE' | 'NOTHING_TO_UNDO' | 'UNDO_UNKNOWN';
    };

export class SessionActor {
  readonly #deps: SessionActorDeps;
  readonly #inbox: Inbox<Message, unknown, 'control' | 'work'>;
  readonly #pending = new Map<string, Pending>();
  #run: Run | undefined;
  #closeAfterRun: 'SWITCHED' | 'SHUTDOWN' | undefined;
  /** An undo waiting for the user because of external changes; it has no timer (M2Design 4.6). */
  #pendingUndo: { readonly undoId: string; readonly plan: UndoPlan } | undefined;

  public constructor(deps: SessionActorDeps) {
    this.#deps = deps;
    this.#inbox = new Inbox<Message, unknown, 'control' | 'work'>({
      channels: ['control', 'work'],
      onError: (error) => {
        deps.onFatal(error);
      },
    });
  }

  start(begin: SessionStart): void {
    this.#inbox.start(async (message) => {
      try {
        return await this.#handle(message);
      } finally {
        try {
          await this.#settle();
        } finally {
          this.#deps.outbox.flush();
        }
      }
    });
    this.#inbox.enqueue({ kind: 'SESSION_BEGIN', start: begin }, 'control');
  }

  /**
   * The one entry of memory pressure (Kernel/Core 5c). WARNING takes the run to its wrap-up path
   * and refuses new work; DANGER interrupts it: Workflow is told, in-flight work is cancelled, and
   * the run closes as INTERRUPTED.
   */
  memoryPressure(level: MemoryLevel): Promise<void> {
    return this.call(() => {
      const run = this.#run;
      // With no run open there is nothing to interrupt: the notice and the record were made by
      // the Kernel, and the next start is refused while the process is short (Core 5c).
      if (run === undefined || run.control.phase === 'CLOSED') return;
      if (level === 'WARNING') {
        run.work.setMemoryWarning();
        return;
      }
      this.interrupt(run, 'MEMORY_PRESSURE');
    }, 'control');
  }

  /**
   * The one entry of every interrupt (Kernel/Core 5e): the user's abort, the Turn timeout, the
   * pause limit and memory pressure. Workflow is told first, so that it stops asking for models;
   * then what waits for the user is cancelled and what runs is cancelled with it. The run stays
   * open for the one reply that says what happened.
   */
  interrupt(run: Run, reason: InterruptReason): Decision<{ readonly firstTime: boolean }> {
    const decision = this.#apply(run, beginInterrupt(run.control, reason));
    if (!decision.accepted || decision.effect?.firstTime !== true) return decision;
    const { outbox } = this.#deps;
    const sessionId = this.#sessionId;
    this.#stopTimers(run);
    run.work.cancelCompaction();
    outbox.runToWorkflow(sessionId, run.workflowRunId, { type: 'RunInterrupted', reason });
    outbox.runToInteraction(sessionId, run.workflowRunId, {
      type: 'RunStateChanged',
      state: 'INTERRUPTING',
      ...(run.control.turnId === undefined ? {} : { turnId: run.control.turnId }),
    });
    for (const [humanRequestId, question] of run.control.questions) {
      outbox.runToWorkflow(sessionId, run.workflowRunId, {
        type: 'HumanCancelled',
        humanRequestId,
        nodeId: question.nodeId,
        reason,
      });
      outbox.runToInteraction(sessionId, run.workflowRunId, {
        type: 'HumanResolved',
        humanRequestId,
        resolution: 'CANCELLED',
      });
    }
    run.control = { ...run.control, questions: new Map() };
    // If Workflow does not answer, the Kernel closes the run, so that it is not held for ever.
    run.work.beginInterrupt(reason, this.#deps.interruptBackstopMs ?? 30_000, () => {
      void this.closeRun(run, { closeReason: 'INTERRUPTED' });
    });
    return decision;
  }

  /** `compactContext`: only while the run awaits input, and only when there is a context to compact. */
  compactContext(run: Run): Decision {
    if (run.control.phase !== 'AWAITING_INPUT')
      return { accepted: false, reasonCode: 'REQUEST_CONFLICT' };
    return run.work.startMainCompaction()
      ? { accepted: true, control: run.control }
      : { accepted: false, reasonCode: 'REQUEST_CONFLICT' };
  }

  /** `pauseRun`: Execution holds what has not started and stops what must not run on. */
  pauseRun(run: Run): Decision {
    const decision = this.#apply(run, pauseRun(run.control));
    if (!decision.accepted) return decision;
    this.#state(run, 'PAUSING');
    run.work.cancelCompaction();
    run.work.pause(() => {
      this.#paused(run);
    });
    return decision;
  }

  #paused(run: Run): void {
    if (run.control.phase !== 'PAUSING') return;
    run.control = pauseReached(run.control);
    const sessionId = this.#sessionId;
    this.#state(run, 'PAUSED');
    run.work.showPaused();
    this.#deps.outbox.runToWorkflow(sessionId, run.workflowRunId, { type: 'RunPaused' });
    const { pauseMs } = this.#timeouts();
    run.pauseTimer = this.#schedule(pauseMs, () => {
      this.#inbox.enqueue(
        {
          kind: 'CALL',
          work: () => {
            if (run.control.phase === 'PAUSED') this.interrupt(run, 'PAUSE_TIMEOUT');
            return Promise.resolve();
          },
        },
        'control',
      );
    });
  }

  /** `resumeRun`: a note added while continuing is stored and handed to Workflow as a steer. */
  async resumeRun(
    run: Run,
    steer?: { readonly input: UserInput; readonly targetAgentRunId?: string },
  ): Promise<Decision> {
    if (run.control.phase !== 'PAUSED') return { accepted: false, reasonCode: 'REQUEST_CONFLICT' };
    if (
      steer?.targetAgentRunId !== undefined &&
      !run.control.activeAgentRuns.has(steer.targetAgentRunId)
    )
      return { accepted: false, reasonCode: 'AGENT_RUN_NOT_FOUND' };
    const contentRef =
      steer === undefined ? undefined : await this.#deps.duties.storeUserInput(steer.input);
    const decision = this.#apply(run, resumeRun(run.control));
    if (!decision.accepted) return decision;
    run.pauseTimer?.();
    delete run.pauseTimer;
    this.#state(run, 'RUNNING');
    this.#deps.outbox.runToWorkflow(this.#sessionId, run.workflowRunId, {
      type: 'RunResumed',
      ...(steer === undefined || contentRef === undefined
        ? {}
        : {
            steer: {
              inputId: steer.input.inputId,
              contentRef,
              ...(steer.targetAgentRunId === undefined
                ? {}
                : { targetAgentRunId: steer.targetAgentRunId }),
            },
          }),
    });
    await run.work.resume();
    return decision;
  }

  /** `steerRun`: a note slipped into a run that goes on; it opens no Turn. */
  async steerRun(run: Run, input: UserInput, targetAgentRunId?: string): Promise<Decision> {
    const decision = steerRun(run.control);
    if (!decision.accepted) return decision;
    if (targetAgentRunId !== undefined && !run.control.activeAgentRuns.has(targetAgentRunId))
      return { accepted: false, reasonCode: 'AGENT_RUN_NOT_FOUND' };
    const contentRef = await this.#deps.duties.storeUserInput(input);
    this.#deps.outbox.runToWorkflow(this.#sessionId, run.workflowRunId, {
      type: 'HumanAnswered',
      kind: 'steer',
      inputId: input.inputId,
      contentRef,
      ...(targetAgentRunId === undefined ? {} : { targetAgentRunId }),
    });
    return decision;
  }

  /** A local question of an AgentRun (`ask_user`): it blocks only that AgentRun (M2Design 4.2). */
  requestLocalQuestion(
    run: Run,
    request: Extract<RequestHumanRequest, { kind: 'ask' | 'confirm' | 'review' }>,
  ): Decision {
    const { nodeId } = request;
    const decision = this.#apply(
      run,
      requestLocalQuestion(run.control, request.humanRequestId, {
        agentRunId: request.attachedAgentRunId,
        nodeId,
        kind: request.kind,
      }),
    );
    if (!decision.accepted) return decision;
    run.work.showAwaitingAnswer(request.attachedAgentRunId);
    const event: HumanRequest = {
      type: 'HumanRequest',
      humanRequestId: request.humanRequestId,
      kind: request.kind,
      attachedAgentRunId: request.attachedAgentRunId,
      question: request.question,
      ...(request.fields === undefined ? {} : { fields: request.fields }),
      ...(request.reviewRef === undefined ? {} : { reviewRef: request.reviewRef }),
    };
    this.#deps.outbox.runToInteraction(this.#sessionId, run.workflowRunId, event);
    return decision;
  }

  /** The answer to a local question: delivered, in a paused run too, where Execution holds the rest. */
  async answerLocalQuestion(
    run: Run,
    humanRequestId: string,
    kind: 'ask' | 'confirm' | 'review',
    input: UserInput,
  ): Promise<Decision> {
    const decision = answerLocalQuestion(run.control, humanRequestId);
    if (!decision.accepted) return decision;
    const contentRef = await this.#deps.duties.storeUserInput(input);
    run.control = decision.control;
    const { outbox } = this.#deps;
    outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'HumanResolved',
      humanRequestId,
      resolution: 'ANSWERED',
    });
    outbox.runToWorkflow(this.#sessionId, run.workflowRunId, {
      type: 'HumanAnswered',
      kind,
      origin: 'requested',
      humanRequestId,
      inputId: input.inputId,
      contentRef,
    });
    return decision;
  }

  #timeouts() {
    return this.#deps.timeouts ?? DEFAULT_TIMEOUTS;
  }

  #schedule(delayMs: number, due: () => void): () => void {
    if (this.#deps.schedule !== undefined) return this.#deps.schedule(delayMs, due);
    const timer = setTimeout(due, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }

  /** What the interface is told of a run state, with the Turn it belongs to. */
  #state(run: Run, state: 'RUNNING' | 'PAUSING' | 'PAUSED'): void {
    this.#deps.outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'RunStateChanged',
      state,
      ...(run.control.turnId === undefined ? {} : { turnId: run.control.turnId }),
    });
  }

  /** The pause limit and the Turn clock end with the run, or with the interrupt that ends the Turn. */
  #stopTimers(run: Run): void {
    run.pauseTimer?.();
    delete run.pauseTimer;
    run.turnClock.stop();
  }

  /** Called at the end of every message: the Turn's clock runs only while the system works. */
  #reconcileTurnClock(run: Run): void {
    const { phase, questions } = run.control;
    const idle =
      phase === 'PAUSING' ||
      phase === 'PAUSED' ||
      run.work.awaitsUser(questions.size) ||
      phase === 'INTERRUPTING';
    run.turnClock.reconcile(() => idle);
  }

  close(reason: 'SWITCHED' | 'SHUTDOWN'): void {
    this.#inbox.enqueue({ kind: 'SESSION_CLOSE', reason }, 'control');
  }

  /** Starts the next run of this Session; false while the current run is still live. */
  continueIfClosed(): Promise<boolean> {
    return this.call(() => {
      if (this.#run?.control.phase !== 'CLOSED') return false;
      this.#startRun({ mode: 'CHAT' }, false);
      return true;
    }, 'control');
  }

  expectsCommand(commandId: string): boolean {
    return this.#pending.has(commandId);
  }

  reportCommand(report: ReportSessionCommandRequest): void {
    this.#inbox.enqueue({ kind: 'COMMAND_REPORT', report }, 'work');
  }

  /** Runs `work` in turn with every other message: nothing below ever runs concurrently. */
  call<T>(work: () => Promise<T> | T, channel: 'control' | 'work' = 'work'): Promise<T> {
    return this.#inbox.request(
      { kind: 'CALL', work: () => Promise.resolve(work()) },
      channel,
    ) as Promise<T>;
  }

  idle(): Promise<void> {
    return this.#inbox.idle();
  }

  get #sessionId(): string {
    return this.#deps.sessionId;
  }

  /** The end of every message: a fault converges, and a drained run finishes (Interaction 5.2). */
  async #settle(): Promise<void> {
    const run = this.#run;
    if (run === undefined) return;
    if (run.fault !== undefined) {
      const { fault } = run;
      delete run.fault;
      await this.closeRun(run, closingOf(fault));
      // A process that cannot be confirmed stopped may still be changing the workspace: nothing
      // after it is safe, so the system stops (M2Design 4.7; SystemFaultHandling 2).
      if (fault.kind === 'STOP_UNCONFIRMED')
        this.#deps.onFatal(
          new Error(`STOP_UNCONFIRMED: request ${fault.requestId} could not be confirmed stopped`),
        );
    }
    // The call slots this message gave back go to the attempts that wait (M2Design 7.2).
    if (run.control.phase !== 'CLOSED') await run.work.drainCapacityWaiters();
    await this.#finishIfDrained(run);
    if (run.control.phase !== 'CLOSED') {
      run.work.reconcile();
      this.#reconcileTurnClock(run);
    }
  }

  async #handle(message: Message): Promise<unknown> {
    switch (message.kind) {
      case 'SESSION_BEGIN':
        return this.#begin(message.start);
      case 'SESSION_CLOSE':
        return this.#close(message.reason);
      case 'COMMAND_REPORT': {
        const pending = this.#pending.get(message.report.commandId);
        this.#pending.delete(message.report.commandId);
        return pending?.(message.report.result);
      }
      case 'CALL':
        return message.work();
    }
  }

  #command(
    event:
      | { readonly command: 'CREATE' | 'OPEN'; readonly repositoryRoot: string }
      | {
          readonly command: 'FORK';
          readonly repositoryRoot: string;
          readonly fromSessionId: string;
        }
      | { readonly command: 'CLOSE' },
    next: Pending,
  ): void {
    const commandId = newId('scm');
    this.#pending.set(commandId, next);
    this.#deps.outbox.sessionToWorkflow(this.#sessionId, {
      type: 'SessionCommand',
      commandId,
      ...event,
    });
  }

  async #begin(start: SessionStart): Promise<void> {
    const { sessionId, repositoryRoot, outbox, duties } = this.#deps;
    if (start.kind === 'OPEN') {
      this.#command({ command: 'OPEN', repositoryRoot }, async (result) => {
        if (result.outcome === 'FAILED') {
          this.#failed(start.requestId, result);
          return;
        }
        const diverged = (await duties.snapshots?.divergedFiles()) ?? [];
        const title =
          result.command === 'OPEN' && result.titleRef !== undefined
            ? await duties.titleOf?.(result.titleRef)
            : undefined;
        outbox.sessionToInteraction(sessionId, {
          type: 'SessionOpened',
          repositoryRoot,
          turnCount: result.command === 'OPEN' ? result.turnCount : 0,
          ...(title === undefined ? {} : { title }),
          ...(diverged.length === 0 ? {} : { divergedFiles: [...diverged] }),
        });
        const run = this.#startRun({ mode: 'CHAT' }, false);
        if (diverged.length > 0)
          outbox.runToWorkflow(sessionId, run.workflowRunId, {
            type: 'WorkspaceDiverged',
            files: [...diverged],
          });
      });
      return;
    }
    const contentRef = await duties.storeUserInput(start.input);
    if (start.kind === 'FORK') {
      const { fromSessionId } = start;
      this.#command({ command: 'FORK', repositoryRoot, fromSessionId }, async (result) => {
        if (result.outcome === 'FAILED') {
          await duties.discardSession();
          this.#failed(start.requestId, result);
          return;
        }
        if (result.command !== 'FORK') throw new Error('a fork was answered by another command');
        await duties.inheritArtifacts?.(fromSessionId, result.inheritedArtifacts);
        outbox.sessionToInteraction(sessionId, {
          type: 'SessionOpened',
          repositoryRoot,
          turnCount: result.fromTurnCount,
          fork: { fromSessionId, fromTurnCount: result.fromTurnCount },
        });
        const run = this.#startRun({ mode: 'CHAT' }, true);
        await this.#openTurn(run, start.input.inputId, contentRef, { origin: 'initial' });
      });
      return;
    }
    this.#command({ command: 'CREATE', repositoryRoot }, async (result) => {
      if (result.outcome === 'FAILED') {
        await duties.discardSession();
        this.#failed(start.requestId, result);
        return;
      }
      outbox.sessionToInteraction(sessionId, {
        type: 'SessionOpened',
        repositoryRoot,
        turnCount: 0,
      });
      const run = this.#startRun(
        start.template === undefined
          ? { mode: 'CHAT' }
          : { mode: 'ORCHESTRATION', templateRef: start.template },
        true,
      );
      await this.#openTurn(run, start.input.inputId, contentRef, { origin: 'initial' });
    });
  }

  #failed(requestId: string, result: ReportSessionCommandRequest['result']): void {
    if (result.outcome !== 'FAILED') throw new Error('not a failed command');
    this.#deps.outbox.sessionToInteraction(this.#sessionId, {
      type: 'SessionFailed',
      requestId,
      code: result.failure.code,
    });
    this.#deps.onClosed(this.#sessionId);
  }

  #startRun(
    runStart:
      | { readonly mode: 'CHAT' }
      | { readonly mode: 'ORCHESTRATION'; readonly templateRef: DefinitionRef },
    initialInput: boolean,
  ): Run {
    const run = this.#newRun(runStart.mode);
    this.#run = run;
    this.#deps.admission(run.workflowRunId, 'RUNNING');
    this.#deps.outbox.runToWorkflow(this.#sessionId, run.workflowRunId, {
      type: 'RunStart',
      preset: this.#deps.preset ?? 'standard',
      initialInput,
      ...runStart,
    });
    return run;
  }

  #newRun(mode: Run['mode']): Run {
    const workflowRunId = newId('wfr');
    const { outbox, duties } = this.#deps;
    const sessionId = this.#sessionId;
    const host: RunHost = {
      workflowRunId,
      control: () => run.control,
      closeReason: () => run.closing?.closeReason,
      runEpoch: () => run.runEpoch,
      registerAgentRun: (agentRunId) => this.registerAgentRun(run, agentRunId),
      endAgentRun: (agentRunId) => this.endAgentRun(run, agentRunId),
      attemptStarted: (unitAttemptId) => {
        this.attemptStarted(run, unitAttemptId);
      },
      attemptEnded: (unitAttemptId) => {
        run.control = attemptEnded(run.control, unitAttemptId);
      },
      toWorkflow: (report) => {
        outbox.runToWorkflow(sessionId, workflowRunId, report);
      },
      toInteraction: (event) => {
        outbox.runToInteraction(sessionId, workflowRunId, event);
      },
      toWorkflowEvent: (event) => {
        outbox.runToWorkflow(sessionId, workflowRunId, event);
      },
      fault: (fault) => {
        run.fault ??= fault;
      },
      enqueue: (work) => {
        this.#inbox.enqueue({ kind: 'CALL', work: () => Promise.resolve(work()) }, 'control');
      },
      requestPause: () => {
        this.#inbox.enqueue(
          {
            kind: 'CALL',
            work: () => {
              if (run.control.phase === 'RUNNING') this.pauseRun(run);
              return Promise.resolve();
            },
          },
          'control',
        );
      },
    };
    const run: Run = {
      workflowRunId,
      work: duties.openRunWork(host),
      mode,
      turnClock: new WallClocks({
        now: () => (this.#deps.now ?? Date.now)(),
        schedule: (delayMs, due) => this.#schedule(delayMs, due),
        due: () => {
          this.#inbox.enqueue(
            {
              kind: 'CALL',
              work: () => {
                if (run.turnClock.takeExpired().length > 0) this.interrupt(run, 'TURN_TIMEOUT');
                return Promise.resolve();
              },
            },
            'control',
          );
        },
      }),
      control: initialRunControl(),
      runEpoch: 1,
    };
    return run;
  }

  async #openTurn(
    run: Run,
    inputId: string,
    contentRef: ArtifactRef,
    origin:
      | { readonly origin: 'initial' }
      | { readonly origin: 'requested'; readonly humanRequestId: string },
    template?: DefinitionRef,
  ): Promise<void> {
    const turnId = this.#deps.newTurnId?.() ?? newId('trn');
    // The actor holds every message meanwhile, so no Unit runs before the start is captured.
    await this.#deps.duties.snapshots?.turnStarted(turnId);
    const opened =
      origin.origin === 'initial'
        ? openInitialTurn(run.control, turnId)
        : answerOpenInput(run.control, origin.humanRequestId, turnId);
    if (!opened.accepted) throw new Error(`a Turn cannot open: ${opened.reasonCode}`);
    run.control = opened.control;
    run.work.openTurn(turnId);
    const { turnMs, orchestrationMs } = this.#timeouts();
    run.turnClock.register('turn', run.mode === 'CHAT' ? turnMs : orchestrationMs);
    const { outbox } = this.#deps;
    outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'RunStateChanged',
      state: 'RUNNING',
      turnId,
    });
    outbox.runToWorkflow(this.#sessionId, run.workflowRunId, {
      type: 'HumanAnswered',
      kind: 'prompt',
      inputId,
      contentRef,
      turnId,
      ...(template === undefined ? {} : { template }),
      ...origin,
    });
  }

  async #closeTurn(run: Run, turnId: string, reason: TurnEnd | 'RUN_CLOSED'): Promise<void> {
    run.turnClock.end('turn');
    const captured = await this.#deps.duties.snapshots?.turnEnded(turnId);
    this.#deps.outbox.runToWorkflow(this.#sessionId, run.workflowRunId, {
      type: 'TurnClosed',
      turnId,
      reason,
      usage: run.work.closeTurn(turnId),
      ...captured,
    });
  }

  /** The current run, when `workflowRunId` names it. */
  run(workflowRunId: string): Run | undefined {
    return this.#run?.workflowRunId === workflowRunId ? this.#run : undefined;
  }

  admitWork(run: Run): Decision {
    return admitWork(run.control);
  }

  registerAgentRun(run: Run, agentRunId: string): Decision {
    return this.#apply(run, registerAgentRun(run.control, agentRunId));
  }

  endAgentRun(run: Run, agentRunId: string): Decision {
    return this.#apply(run, endAgentRun(run.control, agentRunId));
  }

  attemptStarted(run: Run, unitAttemptId: string): void {
    run.control = attemptStarted(run.control, unitAttemptId);
  }

  /** A closing run ends as soon as its last attempt does. */
  async attemptEnded(run: Run, unitAttemptId: string): Promise<void> {
    run.control = attemptEnded(run.control, unitAttemptId);
    await this.#finishIfDrained(run);
  }

  #apply<T>(run: Run, decision: Decision<T>): Decision<T> {
    if (decision.accepted) run.control = decision.control;
    return decision;
  }

  async requestOpenInput(
    run: Run,
    humanRequestId: string,
  ): Promise<Decision<{ readonly closedTurnId?: string; readonly turnEnd: TurnEnd }>> {
    const interrupted = run.control.phase === 'INTERRUPTING';
    const decision = this.#apply(run, requestOpenInput(run.control, humanRequestId));
    if (!decision.accepted) return decision;
    // An interrupted Turn ends here, and the run is open again for the next input (Core 5e).
    if (interrupted) run.work.endInterrupt();
    const closed = decision.effect?.closedTurnId;
    if (closed !== undefined)
      await this.#closeTurn(run, closed, decision.effect?.turnEnd ?? 'COMPLETED');
    const { outbox } = this.#deps;
    outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'RunStateChanged',
      state: 'AWAITING_INPUT',
    });
    outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'HumanRequest',
      humanRequestId,
      kind: 'prompt',
    });
    return decision;
  }

  /**
   * The answer to a human request: open input opens the next Turn, the answer to a local question
   * goes to the AgentRun that asked. Which one it is, the request says (M2Design 4.2).
   */
  async answerHuman(
    run: Run,
    humanRequestId: string,
    input: UserInput,
    template?: DefinitionRef,
  ): Promise<Decision> {
    const question = run.control.questions.get(humanRequestId);
    if (question === undefined) return this.answerOpenInput(run, humanRequestId, input, template);
    return this.answerLocalQuestion(run, humanRequestId, question.kind, input);
  }

  async answerOpenInput(
    run: Run,
    humanRequestId: string,
    input: UserInput,
    template?: DefinitionRef,
  ): Promise<Decision> {
    if (run.control.phase !== 'AWAITING_INPUT' || run.control.humanRequestId !== humanRequestId)
      return { accepted: false, reasonCode: 'HUMAN_REQUEST_NOT_PENDING' };
    this.#cancelUndo(run, 'NEW_INPUT');
    const contentRef = await this.#deps.duties.storeUserInput(input);
    this.#deps.outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'HumanResolved',
      humanRequestId,
      resolution: 'ANSWERED',
    });
    await this.#openTurn(
      run,
      input.inputId,
      contentRef,
      { origin: 'requested', humanRequestId },
      template,
    );
    return { accepted: true, control: run.control };
  }

  #cancelUndo(run: Run, reason: UndoCancelled['reason'], undoId?: string): void {
    const pending = this.#pendingUndo;
    if (pending === undefined) return;
    this.#pendingUndo = undefined;
    this.#deps.outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'UndoCancelled',
      undoId: undoId ?? pending.undoId,
      reason,
    });
  }

  #confirmUndoOf(run: Run, plan: UndoPlan): void {
    const undoId = newId('und');
    this.#pendingUndo = { undoId, plan };
    this.#deps.outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'UndoConfirmationRequested',
      undoId,
      files: plan.external.map((file) => ({ ...file })),
    });
  }

  /** Kernel/Core 5a.5. Only while the run waits for input: nothing else can be writing then. */
  async undoTurns(run: Run, scope: 'LAST' | 'ALL'): Promise<UndoDecision> {
    const { snapshots } = this.#deps.duties;
    if (snapshots === undefined || run.control.phase !== 'AWAITING_INPUT')
      return { accepted: false, reasonCode: 'UNDO_NOT_AVAILABLE' };
    this.#cancelUndo(run, 'USER_CANCELLED');
    run.work.cancelCompaction();
    const planned = await snapshots.planUndo(scope);
    if (planned.kind === 'NOTHING_TO_UNDO')
      return { accepted: false, reasonCode: 'NOTHING_TO_UNDO' };
    if (planned.kind === 'NOT_UNDOABLE')
      return { accepted: false, reasonCode: 'UNDO_NOT_AVAILABLE' };
    if (planned.plan.external.length > 0) this.#confirmUndoOf(run, planned.plan);
    else await this.#applyUndo(run, planned.plan, false, scope);
    return { accepted: true };
  }

  async confirmUndo(run: Run, undoId: string, decision: 'FORCE' | 'CANCEL'): Promise<UndoDecision> {
    const pending = this.#pendingUndo;
    if (pending?.undoId !== undoId) return { accepted: false, reasonCode: 'UNDO_UNKNOWN' };
    if (run.control.phase !== 'AWAITING_INPUT')
      return { accepted: false, reasonCode: 'UNDO_NOT_AVAILABLE' };
    if (decision === 'CANCEL') {
      this.#cancelUndo(run, 'USER_CANCELLED');
      return { accepted: true };
    }
    this.#pendingUndo = undefined;
    await this.#applyUndo(run, pending.plan, true);
    return { accepted: true };
  }

  async #applyUndo(
    run: Run,
    plan: UndoPlan,
    forced: boolean,
    scope: 'LAST' | 'ALL' = plan.turnIds.length > 1 ? 'ALL' : 'LAST',
  ): Promise<void> {
    const { snapshots } = this.#deps.duties;
    if (snapshots === undefined) return;
    const applied = await snapshots.applyUndo(plan, forced).catch(() => ({ ok: false }) as const);
    const { outbox } = this.#deps;
    if (applied.ok) {
      const reverted: WorkspaceReverted = {
        type: 'WorkspaceReverted',
        revertedTurnIds: [...plan.turnIds],
        forced,
        externalFiles: plan.external.map((file) => file.path),
        ...(applied.backupSnapshot === undefined ? {} : { backupSnapshot: applied.backupSnapshot }),
      };
      outbox.runToInteraction(this.#sessionId, run.workflowRunId, reverted);
      outbox.runToWorkflow(this.#sessionId, run.workflowRunId, reverted);
      return;
    }
    // Something outside this system changed a file after the plan: ask again what it found now.
    const again = await snapshots.planUndo(scope);
    if (again.kind === 'PLAN' && again.plan.external.length > 0)
      this.#confirmUndoOf(run, again.plan);
    else
      outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
        type: 'UndoCancelled',
        undoId: newId('und'),
        reason: 'FILE_CHANGED',
      });
  }

  /** Any time: looking changes nothing (M2Design 4.6). */
  async diffTurn(requestId: string, n: number): Promise<TurnDiff | SyscallRejected> {
    const { duties } = this.#deps;
    const found = await duties.snapshots?.diffTurn(n);
    if (found === undefined || duties.storeDiff === undefined)
      return { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode: 'NOTHING_TO_UNDO' };
    return {
      requestId,
      outcome: 'ACCEPTED',
      turnId: found.turnId,
      files: found.files.map((file) => ({ ...file })),
      diffRef: await duties.storeDiff(found.diff),
    };
  }

  async closeRun(run: Run, closing: RunClosing): Promise<void> {
    const decision = beginConvergence(run.control);
    if (!decision.accepted || run.closing !== undefined) return;
    this.#cancelUndo(run, 'SESSION_CLOSED');
    run.work.cancelCompaction();
    run.control = decision.control;
    run.closing = closing;
    run.runEpoch += 1;
    this.#stopTimers(run);
    this.#deps.admission(run.workflowRunId, 'CONVERGING', closing.closeReason);
    const closed = decision.effect?.closedTurnId;
    if (closed !== undefined) run.closingTurn = closed;
    this.#deps.outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'RunStateChanged',
      state: 'CONVERGING',
    });
    run.work.beginClosing();
    await this.#finishIfDrained(run);
  }

  async #finishIfDrained(run: Run): Promise<void> {
    if (run.control.phase !== 'CONVERGING' || run.control.inFlightAttempts.size > 0) return;
    const closing = run.closing;
    if (closing === undefined) return;
    run.control = closeRun(run.control);
    this.#deps.admission(run.workflowRunId, 'CLOSED', closing.closeReason);
    run.work.finishClosing();
    if (run.closingTurn !== undefined) await this.#closeTurn(run, run.closingTurn, 'RUN_CLOSED');
    const unknownEffects = run.work.unknownEffects();
    const summary = await this.#deps.duties.writeRunSummary(
      run.work.summary({ sessionId: this.#sessionId }, { unknownEffects, ...closing }),
    );
    const ending = {
      unknownEffects,
      ...closing,
      ...(summary === undefined
        ? { finalizationError: 'RUN_SUMMARY_WRITE_FAILED' as const }
        : { runSummaryRef: summary }),
    };
    const { outbox } = this.#deps;
    outbox.runToWorkflow(this.#sessionId, run.workflowRunId, {
      ...ending,
      type: 'RunClosed',
    } as unknown as KernelToWorkflowEvent);
    outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      ...ending,
      type: 'RunFinished',
    } as unknown as RunFinished);
    if (closing.closeReason === 'INTERRUPTED') this.#deps.onInterrupted?.();
    if (this.#closeAfterRun !== undefined) this.#closeSession(this.#closeAfterRun);
  }

  async #close(reason: 'SWITCHED' | 'SHUTDOWN'): Promise<void> {
    const run = this.#run;
    if (run !== undefined && run.control.phase !== 'CLOSED') {
      this.#closeAfterRun = reason;
      await this.closeRun(run, {
        closeReason: reason === 'SWITCHED' ? 'ENDED_BY_USER' : 'SHUTDOWN',
      });
      return;
    }
    this.#closeSession(reason);
  }

  #closeSession(reason: 'SWITCHED' | 'SHUTDOWN'): void {
    this.#closeAfterRun = undefined;
    this.#command({ command: 'CLOSE' }, () => {
      this.#deps.outbox.sessionToInteraction(this.#sessionId, { type: 'SessionClosed', reason });
      this.#deps.onClosed(this.#sessionId);
      return Promise.resolve();
    });
  }
}

function closingOf(fault: AttemptFault): RunClosing {
  if (fault.kind === 'VIOLATION')
    return {
      closeReason: 'VIOLATION',
      failure: {
        code: fault.reasonCode,
        category: 'INTEGRITY',
        source: 'KERNEL',
        unitRequestId: fault.requestId,
      },
    };
  return {
    closeReason: 'FAILED',
    failure:
      fault.kind === 'STOP_UNCONFIRMED'
        ? {
            code: 'EXECUTION_STOP_UNCONFIRMED',
            category: 'INTERNAL',
            source: 'KERNEL',
            unitRequestId: fault.requestId,
          }
        : { code: 'KERNEL_INTERNAL', category: 'INTERNAL', source: 'KERNEL' },
  };
}
