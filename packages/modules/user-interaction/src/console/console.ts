import {
  AnalysisReportSchema,
  newId,
  validate,
  type AnalysisReport,
  type ArtifactRef,
  type BoundaryContext,
  type CloseReason,
  type InteractionGatewayPort,
  type InteractionInboxEvent,
  type InteractionSessionEvent,
  type InteractionSystemEvent,
  type KernelToInteractionEvent,
  type RunFinished,
} from '@multiagentos/contracts';
import { describeReason } from '../domain/interaction-messages.js';
import { renderReport } from '../domain/report-view.js';
import { ConsoleText as text, terminalText } from './console-text.js';
import type { ActivityLine, ConsoleView, LiveState, PendingItem } from './console-view.js';

export interface ConsoleDeps {
  readonly gateway: InteractionGatewayPort;
  readonly view: ConsoleView;
  readonly now?: () => Date;
}

type RunState = 'NONE' | 'RUNNING' | 'AWAITING_INPUT' | 'CONVERGING' | 'CLOSED';

/** `mas run` exits with the run's outcome (Module/UserInteraction 7). */
export const RUN_EXIT_CODES: Readonly<Record<CloseReason, number>> = {
  COMPLETED: 0,
  BUDGET: 0,
  FAILED: 1,
  TIMEOUT: 2,
  VIOLATION: 3,
  CANCELLED: 130,
  SHUTDOWN: 130,
  ENDED_BY_USER: 130,
};

const INTERRUPT_WINDOW_MS = 2000;

function secondsBetween(from: string, to: string): string {
  return `${(Math.max(0, Date.parse(to) - Date.parse(from)) / 1000).toFixed(1)}s`;
}

/**
 * The interactive console (Module/UserInteraction 5): it turns Kernel events into what the view
 * shows and the user's input into requests. It keeps no Session information: titles, lists and
 * counts all come from events and are gone when the process ends.
 */
export class Console {
  readonly #deps: ConsoleDeps;
  readonly #now: () => Date;
  readonly #pending: PendingItem[] = [];
  readonly #queued: string[] = [];
  readonly #activity = new Map<string, ActivityLine>();
  readonly #listed: string[] = [];
  /** When each running tool Unit started, for the duration on its folded line. */
  readonly #unitStarted = new Map<string, string>();
  /** Full outputs of truncated tool results, numbered for `/output` in arrival order. */
  readonly #fullOutputs: ArtifactRef[] = [];
  #sessionId: string | undefined;
  /** Set by /fork until the draft's first prompt. */
  #forkFrom: string | undefined;
  #workflowRunId: string | undefined;
  #runState: RunState = 'NONE';
  #budget = 'NORMAL';
  #openRequest: string | undefined;
  #hint: string | undefined;
  #interruptedAt: number | undefined;
  #finished: ((code: number) => void) | undefined;
  #exit: (() => void) | undefined;

  public constructor(deps: ConsoleDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  #context(): BoundaryContext {
    return {
      correlationId: newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#workflowRunId === undefined ? {} : { workflowRunId: this.#workflowRunId }),
    };
  }

  #refresh(): void {
    const live: LiveState = {
      status: text.runState[this.#runState] ?? this.#runState,
      activity: [...this.#activity.values()],
      ...(this.#pending[0] === undefined ? {} : { pending: this.#pending[0] }),
      waiting: Math.max(0, this.#pending.length - 1),
      queued: [...this.#queued],
      ...(this.#hint === undefined ? {} : { hint: this.#hint }),
    };
    this.#deps.view.update(live);
  }

  #notice(message: string): void {
    if (message.length > 0) this.#deps.view.print({ kind: 'NOTICE', text: message });
  }

  /** Interactive start: the list of this repository's Sessions, then a draft. */
  async start(): Promise<void> {
    this.#notice(text.welcome);
    await this.#deps.gateway.listSessions({ requestId: newId('req') }, this.#context());
    this.#refresh();
  }

  /** `mas run`: one run in a new Session; resolves with the exit code once it finished. */
  async run(
    template: { readonly id: string; readonly version: string },
    goal: string,
  ): Promise<number> {
    const finished = new Promise<number>((resolve) => {
      this.#finished = resolve;
    });
    this.#deps.view.print({ kind: 'USER', text: terminalText(goal) });
    const accepted = await this.#deps.gateway.startRun(
      { requestId: newId('req'), template, goal: { inputId: newId('inp'), text: goal } },
      this.#context(),
    );
    if (accepted.outcome === 'REJECTED') return 1;
    this.#sessionId = accepted.sessionId;
    return finished;
  }

  /** Resolves when the user asked to leave; the composition root then shuts down. */
  exited(): Promise<void> {
    return new Promise((resolve) => {
      this.#exit = resolve;
    });
  }

  // --- User input ------------------------------------------------------------------------------

  async submit(line: string): Promise<void> {
    const input = line.trim();
    if (input.length === 0) return;
    this.#hint = undefined;
    const pending = this.#pending[0];
    if (pending !== undefined) {
      await this.#answer(pending, input);
      return;
    }
    if (input.startsWith('/')) {
      await this.#command(input);
      return;
    }
    if (this.#sessionId === undefined) {
      this.#deps.view.print({ kind: 'USER', text: terminalText(input) });
      const prompt = { inputId: newId('inp'), text: input };
      const from = this.#forkFrom;
      this.#forkFrom = undefined;
      const accepted = await this.#deps.gateway.startSession(
        from === undefined
          ? { requestId: newId('req'), mode: 'NEW', prompt }
          : { requestId: newId('req'), mode: 'FORK', prompt, fromSessionId: from },
        this.#context(),
      );
      if (accepted.outcome === 'ACCEPTED') this.#sessionId = accepted.sessionId;
      this.#refresh();
      return;
    }
    if (this.#openRequest !== undefined) {
      await this.#answerHuman(input);
      return;
    }
    // Nothing waits for input: the message waits in the console, Kernel never sees it (5.2).
    this.#queued.push(input);
    this.#refresh();
  }

  /** Esc while something is queued takes back the last message. */
  withdrawLast(): string | undefined {
    const last = this.#queued.pop();
    this.#refresh();
    return last;
  }

  async interrupt(): Promise<void> {
    const now = this.#now().getTime();
    if (this.#interruptedAt !== undefined && now - this.#interruptedAt <= INTERRUPT_WINDOW_MS) {
      await this.shutdown();
      return;
    }
    this.#interruptedAt = now;
    this.#hint = text.pressAgain;
    this.#refresh();
  }

  /** Asks the Kernel to close the Session and stop the system; `exited()` then resolves. */
  async shutdown(): Promise<void> {
    await this.#deps.gateway.shutdown({ requestId: newId('req') }, this.#context());
    this.#exit?.();
  }

  async #answerHuman(input: string): Promise<void> {
    const humanRequestId = this.#openRequest;
    const workflowRunId = this.#workflowRunId;
    const sessionId = this.#sessionId;
    if (humanRequestId === undefined || workflowRunId === undefined || sessionId === undefined)
      return;
    this.#openRequest = undefined;
    this.#deps.view.print({ kind: 'USER', text: terminalText(input) });
    await this.#deps.gateway.answerHuman(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        humanRequestId,
        input: { inputId: newId('inp'), text: input },
      },
      this.#context(),
    );
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get workflowRunId(): string | undefined {
    return this.#workflowRunId;
  }

  async #answer(item: PendingItem, input: string): Promise<void> {
    const yes = /^(y|yes|是|好)$/iu.test(input);
    const no = /^(n|no|否|不)$/iu.test(input);
    if (!yes && !no) return;
    this.#pending.shift();
    if (item.kind === 'CONTINUE') {
      if (yes && this.#sessionId !== undefined)
        await this.#deps.gateway.openSession(
          { requestId: newId('req'), sessionId: this.#sessionId },
          this.#context(),
        );
      this.#refresh();
      return;
    }
    const sessionId = this.#sessionId;
    const workflowRunId = this.#workflowRunId;
    if (sessionId === undefined || workflowRunId === undefined) return;
    if (item.kind === 'UNDO') {
      await this.#deps.gateway.confirmUndo(
        {
          requestId: newId('req'),
          sessionId,
          workflowRunId,
          undoId: item.undoId,
          decision: yes ? 'FORCE' : 'CANCEL',
        },
        this.#context(),
      );
      this.#refresh();
      return;
    }
    this.#notice(yes ? text.granted : text.declined);
    await this.#deps.gateway.answerAuthorization(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        questionId: item.questionId,
        answer: { scope: !yes ? 'DENY' : item.once ? 'ONCE' : 'ALLOW' },
      },
      this.#context(),
    );
    this.#refresh();
  }

  async #command(input: string): Promise<void> {
    const [name = '', argument] = input.split(/\s+/u);
    const listed = (value: string | undefined) => {
      const index = Number(value) - 1;
      return this.#listed[index] ?? value;
    };
    switch (name) {
      case '/help':
        this.#notice(text.help);
        break;
      case '/exit':
        await this.shutdown();
        break;
      case '/status':
        this.#notice(text.status(text.runState[this.#runState] ?? this.#runState, this.#budget));
        break;
      case '/sessions':
        await this.#deps.gateway.listSessions({ requestId: newId('req') }, this.#context());
        break;
      case '/fork':
        // Like /new, nothing is created until the first prompt; the open Session stays open.
        if (this.#sessionId === undefined) {
          this.#notice(text.notNow);
          break;
        }
        this.#putBack();
        this.#forkFrom = this.#sessionId;
        this.#sessionId = undefined;
        this.#workflowRunId = undefined;
        this.#runState = 'NONE';
        this.#notice(text.forkDraft);
        break;
      case '/new':
        // The new Session is created only when its first prompt is sent.
        this.#forkFrom = undefined;
        this.#putBack();
        this.#sessionId = undefined;
        this.#workflowRunId = undefined;
        this.#runState = 'NONE';
        this.#notice(text.welcome);
        break;
      case '/resume': {
        const sessionId = listed(argument);
        if (sessionId === undefined) this.#notice(text.notNow);
        else {
          this.#putBack();
          const opened = await this.#deps.gateway.openSession(
            { requestId: newId('req'), sessionId },
            this.#context(),
          );
          if (opened.outcome === 'ACCEPTED') this.#sessionId = opened.sessionId;
        }
        break;
      }
      case '/delete': {
        const sessionId = listed(argument);
        if (sessionId === undefined) this.#notice(text.notNow);
        else
          await this.#deps.gateway.deleteSession(
            { requestId: newId('req'), sessionId },
            this.#context(),
          );
        break;
      }
      case '/undo': {
        const sessionId = this.#sessionId;
        const workflowRunId = this.#workflowRunId;
        if (sessionId === undefined || workflowRunId === undefined) {
          this.#notice(text.notNow);
          break;
        }
        const undone = await this.#deps.gateway.undoTurns(
          {
            requestId: newId('req'),
            sessionId,
            workflowRunId,
            scope: argument === 'all' ? 'ALL' : 'LAST',
          },
          this.#context(),
        );
        if (undone.outcome === 'REJECTED') this.#notice(describeReason(undone.reasonCode));
        break;
      }
      case '/diff':
        await this.#showDiff(argument === undefined ? 1 : Number(argument));
        break;
      case '/output': {
        const ref = this.#fullOutputs[Number(argument) - 1];
        if (ref === undefined) this.#notice(text.notNow);
        else await this.#showFullOutput(ref);
        break;
      }
      default:
        this.#notice(text.unknownCommand(name));
    }
    this.#refresh();
  }

  async #showDiff(n: number): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined || !Number.isSafeInteger(n) || n < 1) {
      this.#notice(text.notNow);
      return;
    }
    const diff = await this.#deps.gateway.diffTurns(
      { requestId: newId('req'), sessionId, n },
      this.#context(),
    );
    if (diff.outcome === 'REJECTED') {
      this.#notice(text.noDiff);
      return;
    }
    const body = await this.#read(diff.diffRef);
    this.#notice(diff.files.length === 0 ? text.noDiff : terminalText(body ?? ''));
  }

  /** Switching, a new Session or a run that ended: queued messages go back to the input box. */
  #putBack(): void {
    if (this.#queued.length === 0) return;
    this.#deps.view.restoreInput(this.#queued.splice(0));
  }

  // --- Kernel events ---------------------------------------------------------------------------

  async handleSystemEvent(envelope: InteractionSystemEvent): Promise<void> {
    const { event } = envelope;
    if (event.type === 'SessionDeleted')
      this.#notice(text.sessionDeleted(event.outcome === 'DELETED'));
    else {
      this.#listed.splice(
        0,
        this.#listed.length,
        ...event.sessions.map((session) => session.sessionId),
      );
      if (event.sessions.length === 0) this.#notice(text.noSessions);
      else
        this.#notice(
          [
            text.recentSessions,
            ...event.sessions
              .slice(0, 10)
              .map((session, index) =>
                text.sessionLine(
                  index + 1,
                  terminalText(session.title ?? text.untitled),
                  session.turnCount,
                ),
              ),
          ].join('\n'),
        );
    }
    this.#refresh();
    return Promise.resolve();
  }

  handleSessionEvent(envelope: InteractionSessionEvent): Promise<void> {
    const { event } = envelope;
    switch (event.type) {
      case 'SessionOpened':
        this.#sessionId = envelope.sessionId;
        this.#notice(
          text.sessionOpened(terminalText(event.title ?? text.untitled), event.turnCount),
        );
        if (event.divergedFiles !== undefined)
          this.#notice(text.diverged(event.divergedFiles.length));
        break;
      case 'SessionFailed':
        if (this.#sessionId === envelope.sessionId) this.#sessionId = undefined;
        this.#deps.view.print({ kind: 'ERROR', text: text.sessionFailed[event.code] });
        break;
      case 'SessionClosed':
        if (this.#sessionId === envelope.sessionId) this.#sessionId = undefined;
        break;
    }
    this.#refresh();
    return Promise.resolve();
  }

  async handleRunEvent(envelope: InteractionInboxEvent): Promise<void> {
    const { event } = envelope;
    this.#workflowRunId = envelope.workflowRunId;
    switch (event.type) {
      case 'RunStateChanged':
        this.#runState = event.state;
        if (event.state !== 'RUNNING') this.#activity.clear();
        break;
      case 'HumanRequest': {
        this.#openRequest = event.humanRequestId;
        const next = this.#queued.shift();
        if (next !== undefined) await this.#answerHuman(next);
        break;
      }
      case 'HumanResolved':
        if (this.#openRequest === event.humanRequestId) this.#openRequest = undefined;
        break;
      case 'AuthorizationRequest':
        this.#pending.push({
          kind: 'AUTHORIZATION',
          questionId: event.questionId,
          once: event.capability === 'workspace.write' && event.critical,
          text: await this.#questionText(event),
        });
        break;
      case 'UndoConfirmationRequested':
        this.#pending.push({
          kind: 'UNDO',
          undoId: event.undoId,
          text: text.undoConfirm(event.files.map((file) => terminalText(file.path))),
        });
        break;
      case 'UndoCancelled': {
        const index = this.#pending.findIndex(
          (item) => item.kind === 'UNDO' && item.undoId === event.undoId,
        );
        if (index >= 0) this.#pending.splice(index, 1);
        this.#notice(text.undoCancelled[event.reason]);
        break;
      }
      case 'WorkspaceReverted':
        this.#notice(text.undone(event.revertedTurnIds.length));
        break;
      case 'AuthorizationResolved': {
        const index = this.#pending.findIndex(
          (item) => item.kind === 'AUTHORIZATION' && item.questionId === event.questionId,
        );
        if (index >= 0) this.#pending.splice(index, 1);
        break;
      }
      case 'ActivityEvent': {
        const { unit } = event;
        const tool =
          unit === undefined
            ? undefined
            : terminalText(`${unit.toolName} ${unit.argsSummary}`.trim());
        const { todos } = event;
        const progress =
          todos === undefined
            ? undefined
            : terminalText(
                `${String(todos.done)}/${String(todos.total)}${todos.current === undefined ? '' : ` · ${todos.current}`}`,
              );
        const shown = tool ?? progress;
        this.#activity.set(event.agentRunId, {
          agentRunId: event.agentRunId,
          label: terminalText(event.label),
          phase: text.phase[event.phase],
          since: event.at,
          ...(shown === undefined ? {} : { tool: shown }),
          ...('retry' in event ? { retry: event.retry } : {}),
        });
        if (unit?.state === 'RUNNING') this.#unitStarted.set(unit.unitAttemptId, event.at);
        if (unit?.state === 'DONE' && tool !== undefined) {
          const started = this.#unitStarted.get(unit.unitAttemptId);
          this.#unitStarted.delete(unit.unitAttemptId);
          const line =
            started === undefined ? `✓ ${tool}` : `✓ ${tool} ${secondsBetween(started, event.at)}`;
          if (unit.fullRef !== undefined) this.#fullOutputs.push(unit.fullRef);
          this.#deps.view.print({
            kind: 'STEP',
            text:
              unit.fullRef === undefined
                ? line
                : `${line} · ${text.truncated(this.#fullOutputs.length)}`,
          });
        }
        if (event.phase === 'ENDED') this.#activity.delete(event.agentRunId);
        break;
      }
      case 'MessagePublished':
        await this.#published(event.kind, event.agentLabel, event.messageRef);
        break;
      case 'RunFinished':
        await this.#runFinished(event);
        break;
    }
    this.#refresh();
  }

  async #questionText(
    event: Extract<KernelToInteractionEvent, { type: 'AuthorizationRequest' }>,
  ): Promise<string> {
    if (event.capability === 'repo.read')
      return text.repoRead(
        terminalText(event.repositoryPath),
        event.provider,
        event.exclusions.length,
      );
    if (event.capability === 'project.instructions')
      return text.instructions(
        event.path,
        event.truncated,
        terminalText((await this.#read(event.contentRef)) ?? ''),
      );
    if (event.critical)
      return text.writeCritical(
        terminalText(event.path),
        terminalText((await this.#read(event.contentRef)) ?? ''),
      );
    return text.writeRoot(terminalText(event.writeRoot));
  }

  async #read(ref: ArtifactRef): Promise<string | undefined> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) return undefined;
    const content = await this.#deps.gateway.readArtifact(
      { requestId: newId('req'), sessionId, ref },
      this.#context(),
    );
    return content.outcome === 'ACCEPTED' ? content.text : undefined;
  }

  /** A full output is kept 7 days; after that only the preview the model saw remains. */
  async #showFullOutput(ref: ArtifactRef): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) return;
    const content = await this.#deps.gateway.readArtifact(
      { requestId: newId('req'), sessionId, ref },
      this.#context(),
    );
    if (content.outcome === 'ACCEPTED')
      this.#deps.view.print({ kind: 'REPORT', text: terminalText(content.text) });
    else
      this.#deps.view.print({
        kind: 'ERROR',
        text: content.reasonCode === 'ARTIFACT_EXPIRED' ? text.fullOutputExpired : text.notNow,
      });
  }

  async #published(
    kind: 'REPLY' | 'DEGRADED_REPLY' | 'RUN_RESULT',
    agentLabel: string,
    ref: ArtifactRef,
  ) {
    const body = await this.#read(ref);
    if (kind === 'DEGRADED_REPLY') {
      let reason: string | undefined;
      try {
        reason = (JSON.parse(body ?? '{}') as { reason?: string }).reason;
      } catch {
        reason = undefined;
      }
      this.#deps.view.print({
        kind: 'ERROR',
        text: (reason === undefined ? undefined : text.degraded[reason]) ?? text.degradedOther,
      });
      return;
    }
    this.#deps.view.print({ kind: 'REPLY', agentLabel, text: terminalText(body ?? '') });
  }

  async #runFinished(event: RunFinished): Promise<void> {
    this.#runState = 'CLOSED';
    this.#activity.clear();
    this.#openRequest = undefined;
    this.#pending.splice(0);
    if (event.resultRef !== undefined) {
      const body = await this.#read(event.resultRef);
      let report: AnalysisReport | undefined;
      try {
        const parsed = validate<AnalysisReport>(AnalysisReportSchema, JSON.parse(body ?? 'null'));
        report = parsed.ok ? parsed.value : undefined;
      } catch {
        report = undefined;
      }
      if (report !== undefined)
        this.#deps.view.print({ kind: 'REPORT', text: renderReport(report) });
    }
    this.#notice(text.finished[event.closeReason]);
    this.#putBack();
    if (this.#finished !== undefined) {
      this.#finished(RUN_EXIT_CODES[event.closeReason]);
      return;
    }
    if (event.closeReason === 'BUDGET')
      this.#pending.push({ kind: 'CONTINUE', text: text.continueAfterBudget });
  }
}
