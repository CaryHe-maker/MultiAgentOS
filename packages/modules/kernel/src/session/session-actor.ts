import {
  newId,
  type ArtifactRef,
  type CloseReasonV1,
  type DefinitionRef,
  type KernelToWorkflowEventV1,
  type ReportSessionCommandRequest,
  type RunFailure,
  type RunFinishedV1,
  type UserInput,
} from '@multiagentos/contracts';
import { Inbox } from '@multiagentos/fabric';
import {
  answerOpenInput,
  attemptEnded,
  attemptStarted,
  beginConvergence,
  closeRun,
  endAgentRun,
  initialRunControl,
  openInitialTurn,
  registerAgentRun,
  requestOpenInput,
  admitWork,
  type Decision,
  type RunControl,
} from './run-control.js';
import type { AttemptFault } from './run-attempts.js';
import type { RunHost, RunWork } from './run-work.js';
import type { KernelOutbox } from './session-outbox.js';

/**
 * One Session's Inbox and serial loop (Kernel/Interaction 5.2). The actor owns ordering, the
 * Session lifecycle, runs and Turns; everything about attempts, artifacts and ledgers is asked of
 * `SessionDuties`, so these rules do not depend on how a Unit is executed.
 */
export interface SessionDuties {
  storeUserInput(input: UserInput): Promise<ArtifactRef>;
  /** The Unit path of a new run. */
  openRunWork(host: RunHost): RunWork;
  /** Writes the RunSummary; undefined means the write failed and the run ends without one. */
  writeRunSummary(
    workflowRunId: string,
    closeReason: CloseReasonV1,
  ): Promise<ArtifactRef | undefined>;
  removeSessionFiles(): Promise<void>;
}

export type SessionStart =
  | {
      readonly kind: 'NEW';
      readonly requestId: string;
      readonly input: UserInput;
      readonly template?: DefinitionRef;
    }
  | { readonly kind: 'OPEN'; readonly requestId: string };

export type RunClosing =
  | {
      readonly closeReason: Exclude<CloseReasonV1, 'FAILED' | 'VIOLATION'>;
      readonly resultRef?: ArtifactRef;
    }
  | { readonly closeReason: 'FAILED' | 'VIOLATION'; readonly failure: RunFailure };

export interface SessionActorDeps {
  readonly sessionId: string;
  readonly repositoryRoot: string;
  readonly outbox: KernelOutbox;
  readonly duties: SessionDuties;
  readonly newTurnId?: () => string;
  /** The actor is finished: Session management takes it out. */
  readonly onClosed: (sessionId: string) => void;
  readonly onFatal: (error: unknown) => void;
}

type Message =
  | { readonly kind: 'SESSION_BEGIN'; readonly start: SessionStart }
  | { readonly kind: 'SESSION_CLOSE'; readonly reason: 'SWITCHED' | 'SHUTDOWN' }
  | { readonly kind: 'COMMAND_REPORT'; readonly report: ReportSessionCommandRequest }
  | { readonly kind: 'CALL'; readonly work: () => Promise<unknown> };

interface Run {
  readonly workflowRunId: string;
  readonly work: RunWork;
  control: RunControl;
  runEpoch: number;
  closing?: RunClosing;
  /** The Turn that ends once the run has drained, just before RunClosed. */
  closingTurn?: string;
  fault?: AttemptFault;
}

type Pending = (result: ReportSessionCommandRequest['result']) => Promise<void>;

export class SessionActor {
  readonly #deps: SessionActorDeps;
  readonly #inbox: Inbox<Message, unknown, 'control' | 'work'>;
  readonly #pending = new Map<string, Pending>();
  #run: Run | undefined;
  #closeAfterRun: 'SWITCHED' | 'SHUTDOWN' | undefined;

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
    }
    await this.#finishIfDrained(run);
    if (run.control.phase !== 'CLOSED') run.work.reconcile();
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
      this.#command({ command: 'OPEN', repositoryRoot }, (result) => {
        if (result.outcome === 'FAILED')
          return Promise.resolve(this.#failed(start.requestId, result));
        outbox.sessionToInteraction(sessionId, {
          type: 'SessionOpened',
          repositoryRoot,
          turnCount: 0,
        });
        this.#startRun({ mode: 'CHAT' }, false);
        return Promise.resolve();
      });
      return;
    }
    const contentRef = await duties.storeUserInput(start.input);
    this.#command({ command: 'CREATE', repositoryRoot }, async (result) => {
      if (result.outcome === 'FAILED') {
        await duties.removeSessionFiles();
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
      this.#openTurn(run, start.input.inputId, contentRef, { origin: 'initial' });
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
    const run = this.#newRun();
    this.#run = run;
    this.#deps.outbox.runToWorkflow(this.#sessionId, run.workflowRunId, {
      type: 'RunStart',
      preset: 'standard',
      initialInput,
      ...runStart,
    });
    return run;
  }

  #newRun(): Run {
    const workflowRunId = newId('wfr');
    const { outbox, duties } = this.#deps;
    const sessionId = this.#sessionId;
    const host: RunHost = {
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
      fault: (fault) => {
        run.fault ??= fault;
      },
      enqueue: (work) => {
        this.#inbox.enqueue({ kind: 'CALL', work: () => Promise.resolve(work()) }, 'control');
      },
    };
    const run: Run = {
      workflowRunId,
      work: duties.openRunWork(host),
      control: initialRunControl(),
      runEpoch: 1,
    };
    return run;
  }

  #openTurn(
    run: Run,
    inputId: string,
    contentRef: ArtifactRef,
    origin:
      | { readonly origin: 'initial' }
      | { readonly origin: 'requested'; readonly humanRequestId: string },
    template?: DefinitionRef,
  ): void {
    const turnId = this.#deps.newTurnId?.() ?? newId('trn');
    const opened =
      origin.origin === 'initial'
        ? openInitialTurn(run.control, turnId)
        : answerOpenInput(run.control, origin.humanRequestId, turnId);
    if (!opened.accepted) throw new Error(`a Turn cannot open: ${opened.reasonCode}`);
    run.control = opened.control;
    run.work.openTurn(turnId);
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

  #closeTurn(run: Run, turnId: string, reason: 'COMPLETED' | 'RUN_CLOSED'): void {
    this.#deps.outbox.runToWorkflow(this.#sessionId, run.workflowRunId, {
      type: 'TurnClosed',
      turnId,
      reason,
      usage: run.work.closeTurn(turnId),
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

  requestOpenInput(run: Run, humanRequestId: string): Decision<{ readonly closedTurnId?: string }> {
    const decision = this.#apply(run, requestOpenInput(run.control, humanRequestId));
    if (!decision.accepted) return decision;
    const closed = decision.effect?.closedTurnId;
    if (closed !== undefined) this.#closeTurn(run, closed, 'COMPLETED');
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

  async answerOpenInput(
    run: Run,
    humanRequestId: string,
    input: UserInput,
    template?: DefinitionRef,
  ): Promise<Decision> {
    if (run.control.phase !== 'AWAITING_INPUT' || run.control.humanRequestId !== humanRequestId)
      return { accepted: false, reasonCode: 'HUMAN_REQUEST_NOT_PENDING' };
    const contentRef = await this.#deps.duties.storeUserInput(input);
    this.#deps.outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'HumanResolved',
      humanRequestId,
      resolution: 'ANSWERED',
    });
    this.#openTurn(
      run,
      input.inputId,
      contentRef,
      { origin: 'requested', humanRequestId },
      template,
    );
    return { accepted: true, control: run.control };
  }

  async closeRun(run: Run, closing: RunClosing): Promise<void> {
    const decision = beginConvergence(run.control);
    if (!decision.accepted || run.closing !== undefined) return;
    run.control = decision.control;
    run.closing = closing;
    run.runEpoch += 1;
    const closed = decision.effect?.closedTurnId;
    if (closed !== undefined) run.closingTurn = closed;
    this.#deps.outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      type: 'RunStateChanged',
      state: 'CONVERGING',
    });
    await run.work.beginClosing();
    await this.#finishIfDrained(run);
  }

  async #finishIfDrained(run: Run): Promise<void> {
    if (run.control.phase !== 'CONVERGING' || run.control.inFlightAttempts.size > 0) return;
    const closing = run.closing;
    if (closing === undefined) return;
    run.control = closeRun(run.control);
    run.work.finishClosing();
    if (run.closingTurn !== undefined) this.#closeTurn(run, run.closingTurn, 'RUN_CLOSED');
    const summary = await this.#deps.duties.writeRunSummary(run.workflowRunId, closing.closeReason);
    const ending = {
      unknownEffects: [],
      ...closing,
      ...(summary === undefined
        ? { finalizationError: 'RUN_SUMMARY_WRITE_FAILED' as const }
        : { runSummaryRef: summary }),
    };
    const { outbox } = this.#deps;
    outbox.runToWorkflow(this.#sessionId, run.workflowRunId, {
      ...ending,
      type: 'RunClosed',
    } as unknown as KernelToWorkflowEventV1);
    outbox.runToInteraction(this.#sessionId, run.workflowRunId, {
      ...ending,
      type: 'RunFinished',
    } as unknown as RunFinishedV1);
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
