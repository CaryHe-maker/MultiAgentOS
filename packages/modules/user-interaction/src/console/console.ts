import {
  AnalysisReportSchema,
  EXIT_CODE_MEMORY_PRESSURE,
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
  type ModelStream,
  type RunFinished,
  type ShutdownSource,
} from '@multiagentos/contracts';
import { describeReason } from '../domain/interaction-messages.js';
import { renderReport } from '../domain/report-view.js';
import { ConsoleText as text, commandPreview, terminalText } from './console-text.js';
import { MAX_INPUT_BYTES, exceedsInputLimit, inputBytes } from './input-limit.js';
import type {
  ActivityLine,
  ConsoleView,
  LiveState,
  PendingItem,
  QuestionField,
  ThinkingView,
} from './console-view.js';
import { ThinkingLog, type ThinkingBlock } from './thinking-log.js';

export interface ConsoleDeps {
  readonly gateway: InteractionGatewayPort;
  readonly view: ConsoleView;
  readonly now?: () => Date;
}

type RunState =
  | 'NONE'
  | 'RUNNING'
  | 'PAUSING'
  | 'PAUSED'
  | 'INTERRUPTING'
  | 'AWAITING_INPUT'
  | 'CONVERGING'
  | 'CLOSED';

/** `@name` at the head of a message names the AgentRun it is for; the rest is the message. */
function addressed(input: string): { readonly name?: string; readonly text: string } {
  const match = /^@(\S+)\s*([\s\S]*)$/u.exec(input.trim());
  return match === null ? { text: input.trim() } : { name: match[1] ?? '', text: match[2] ?? '' };
}

const SKIP = Symbol('skip');
type FieldValue = string | boolean | readonly string[];

/** What a typed answer means for a field of a question; undefined when it does not fit. */
function fieldValue(field: QuestionField, input: string): FieldValue | typeof SKIP | undefined {
  const answer = input.trim();
  if (answer === '-' && field.required !== true) return SKIP;
  const options = field.options ?? [];
  const pick = (token: string): string | undefined =>
    options[Number(token) - 1] ?? options.find((option) => option === token);
  switch (field.type) {
    case 'text':
    case 'textarea':
      return answer.length > 0 ? answer : undefined;
    case 'confirm':
      if (/^(y|yes|是|好)$/iu.test(answer)) return true;
      return /^(n|no|否|不)$/iu.test(answer) ? false : undefined;
    case 'select':
      return pick(answer);
    case 'multiselect': {
      const picked = answer.split(/[,，]/u).map((token) => pick(token.trim()));
      return picked.length > 0 && picked.every((value) => value !== undefined)
        ? [...new Set(picked)]
        : undefined;
    }
  }
}

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
  INTERRUPTED: EXIT_CODE_MEMORY_PRESSURE,
};

const INTERRUPT_WINDOW_MS = 2000;

/** The answer a pending question gets from the user's input. */
function commandChoice(
  item: Extract<PendingItem, { kind: 'AUTHORIZATION' }>,
  input: string,
): 'ONCE' | 'COMMAND' | 'PREFIX' | 'DENY' | undefined {
  if (item.options === undefined) return undefined;
  const answer = input.trim().toLowerCase();
  if (/^(n|no|否|不)$/u.test(answer)) return 'DENY';
  if (/^(1|y|yes|是|好)$/u.test(answer)) return 'ONCE';
  if (/^(2|c)$/u.test(answer) && item.options.includes('COMMAND')) return 'COMMAND';
  if (/^(3|p)$/u.test(answer) && item.options.includes('PREFIX')) return 'PREFIX';
  return undefined;
}

/** The wider answer a question about the web takes, when the user gave it. */
function widerChoice(
  item: Extract<PendingItem, { kind: 'AUTHORIZATION' }>,
  input: string,
): 'ANY_HOST' | 'FOLDER' | undefined {
  const answer = input.trim().toLowerCase();
  if (item.wider === 'ANY_HOST' && /^(a|all|所有|全部)$/u.test(answer)) return 'ANY_HOST';
  if (item.wider === 'FOLDER' && /^(f|folder|文件夹)$/u.test(answer)) return 'FOLDER';
  return undefined;
}

function scopeOf(
  item: Extract<PendingItem, { kind: 'AUTHORIZATION' }>,
  yes: boolean,
  input = '',
): 'ALLOW' | 'ONCE' | 'COMMAND' | 'PREFIX' | 'DENY' | 'ANY_HOST' | 'FOLDER' {
  if (!yes) return 'DENY';
  return widerChoice(item, input) ?? commandChoice(item, input) ?? (item.once ? 'ONCE' : 'ALLOW');
}

/** One AgentRun of the current run, for `/timeline`. */
interface TimelineEntry {
  readonly agentRunId: string;
  readonly parentAgentRunId?: string;
  readonly label: string;
  readonly from: string;
  to?: string;
}

/** The activity line of a compaction the user asked for: no AgentRun stands behind it. */
const COMPACTION_LINE = 'compaction';

/** Items in the order a tree is drawn: children under the parent that started them. */
function inTree<
  T extends { readonly agentRunId: string; readonly parentAgentRunId?: string | undefined },
>(items: readonly T[]): { readonly item: T; readonly depth: number; readonly branch: string }[] {
  const known = new Set(items.map((item) => item.agentRunId));
  const ordered: { item: T; depth: number; branch: string }[] = [];
  const visit = (parent: string | undefined, depth: number, indent: string): void => {
    const siblings = items.filter((item) =>
      parent === undefined
        ? item.parentAgentRunId === undefined || !known.has(item.parentAgentRunId)
        : item.parentAgentRunId === parent,
    );
    for (const [index, item] of siblings.entries()) {
      const last = index === siblings.length - 1;
      ordered.push({ item, depth, branch: depth === 0 ? '' : `${indent}${last ? '└─ ' : '├─ '}` });
      visit(item.agentRunId, depth + 1, depth === 0 ? '  ' : `${indent}${last ? '   ' : '│  '}`);
    }
  };
  visit(undefined, 0, '');
  return ordered;
}

/** The phases in which the run waits for the user, not for a machine. */
const WAITS_FOR_USER: ReadonlySet<string> = new Set([
  'AWAITING_AUTHORIZATION',
  'AWAITING_ANSWER',
  'PAUSED',
]);

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
  /** The run ended from outside (INTERRUPTED): the next message opens the next run (5.2). */
  #continueOnInput = false;
  readonly #activity = new Map<string, ActivityLine>();
  /** Every AgentRun of the current run, in the order it appeared (`/timeline`). */
  readonly #timeline: TimelineEntry[] = [];
  #timelineRun: string | undefined;
  readonly #listed: string[] = [];
  /** When each running tool Unit started, for the duration on its folded line. */
  readonly #unitStarted = new Map<string, string>();
  /** Full outputs of truncated tool results, numbered for `/output` in arrival order. */
  readonly #fullOutputs: ArtifactRef[] = [];
  #sessionId: string | undefined;
  /** What the model thinks while it runs, for the eye only (docs/M2/Phase1Console.md 4). */
  readonly #thinking = new ThinkingLog();
  /** The answers agents are writing for the user, by the call that writes them; only that they are. */
  readonly #answering = new Map<string, { agentRunId: string; startedAt: string }>();
  /** The tool calls agents are writing, by the call that writes them: which tool, on which file. */
  readonly #generating = new Map<
    string,
    { agentRunId: string; startedAt: string; name: string; target?: string }
  >();
  /** The share of its limit the context took at the last assembly, and the Session it is of. */
  #contextShare: { readonly sessionId: string; readonly percent: number } | undefined;
  /** The Session the thinking belongs to. */
  #thinkingSession: string | undefined;
  /** Set by /fork until the draft's first prompt. */
  #forkFrom: string | undefined;
  #workflowRunId: string | undefined;
  #runState: RunState = 'NONE';
  #budget = 'NORMAL';
  #openRequest: string | undefined;
  #hint: string | undefined;
  #interruptedAt: number | undefined;
  /** The run is being aborted: the open input that comes next is not given the queued messages. */
  #aborting = false;
  #finished: ((code: number) => void) | undefined;
  #exit: (() => void) | undefined;
  #exitCode = 0;

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
      // A run belongs to a Session: without one, the run that was last seen is not named.
      ...(this.#sessionId === undefined || this.#workflowRunId === undefined
        ? {}
        : { workflowRunId: this.#workflowRunId }),
    };
  }

  #refresh(): void {
    const live: LiveState = {
      status: text.runState[this.#runState] ?? this.#runState,
      activity: this.#activityTree(),
      ...(this.#pending[0] === undefined ? {} : { pending: this.#pending[0] }),
      waiting: Math.max(0, this.#pending.length - 1),
      queued: [...this.#queued],
      ...(this.#hint === undefined ? {} : { hint: this.#hint }),
      thinking: this.#thinkingInView(),
      ...(this.#contextShare !== undefined && this.#contextShare.sessionId === this.#sessionId
        ? { context: this.#contextShare.percent }
        : {}),
    };
    this.#deps.view.update(live);
  }

  /**
   * Every block the log still has, oldest first. Which of them are shown open, and where among the
   * records they stand, is for the view to decide: it knows the screen.
   */
  #thinkingInView(): ThinkingView[] {
    return this.#thinking.blocks().map((block) => ({
      id: block.callId,
      number: block.number,
      label: block.label,
      state: block.state,
      startedAt: block.startedAt,
      ...(block.endedAt === undefined ? {} : { endedAt: block.endedAt }),
      text: block.text,
    }));
  }

  #thinkingSeconds(block: ThinkingBlock): string {
    const end = block.endedAt ?? this.#now().toISOString();
    return `${(Math.max(0, Date.parse(end) - Date.parse(block.startedAt)) / 1000).toFixed(1)}s`;
  }

  /** A different Session starts a different story: nothing of the old one is kept. */
  #streamBelongsTo(sessionId: string | undefined): void {
    if (this.#thinkingSession === sessionId) return;
    this.#thinkingSession = sessionId;
    this.#thinking.clear();
    this.#answering.clear();
    this.#generating.clear();
  }

  /**
   * The thinking of a model call, as it comes (docs/M2/Phase1Console.md 4). It is not an event of
   * the run: it changes nothing but what is drawn, and a piece that does not fit a Session in
   * view is dropped.
   */
  handleModelStream(stream: ModelStream): void {
    if (this.#sessionId === undefined || stream.sessionId !== this.#sessionId) return;
    this.#streamBelongsTo(stream.sessionId);
    const label = this.#activity.get(stream.agentRunId)?.label ?? 'main';
    if (stream.kind === 'END') {
      this.#thinking.end(stream.callId, stream.at);
      // The call is written: what comes next is told by the activity of the tool itself.
      this.#generating.delete(stream.callId);
    } else if (stream.kind === 'CONTEXT') {
      this.#contextShare = {
        sessionId: stream.sessionId,
        percent: Math.min(100, Math.round((stream.used / stream.limit) * 100)),
      };
    } else if (stream.kind === 'TOOL') {
      this.#thinking.end(stream.callId, stream.at);
      const earlier = this.#generating.get(stream.callId);
      if (earlier === undefined)
        // The next call of an agent replaces what it wrote before.
        for (const [id, other] of this.#generating)
          if (other.agentRunId === stream.agentRunId) this.#generating.delete(id);
      this.#generating.set(stream.callId, {
        agentRunId: stream.agentRunId,
        startedAt: earlier?.startedAt ?? stream.at,
        name: terminalText(stream.name),
        ...(stream.target === undefined ? {} : { target: terminalText(stream.target) }),
      });
    } else if (stream.kind === 'ANSWER') {
      // The thinking is over when the answer begins: one clock runs, not two.
      this.#thinking.end(stream.callId, stream.at);
      if (!this.#answering.has(stream.callId)) {
        // The next call of an agent replaces what it wrote before.
        for (const [id, earlier] of this.#answering)
          if (earlier.agentRunId === stream.agentRunId) this.#answering.delete(id);
        this.#answering.set(stream.callId, {
          agentRunId: stream.agentRunId,
          startedAt: stream.at,
        });
      }
    } else
      this.#thinking.append(
        {
          callId: stream.callId,
          agentRunId: stream.agentRunId,
          label,
        },
        terminalText(stream.delta),
        stream.at,
      );
    this.#refresh();
  }

  /** `/think`: the blocks there are, or the whole of one. */
  #showThinking(argument: string | undefined): void {
    const blocks = this.#thinking.blocks();
    if (argument === undefined) {
      if (blocks.length === 0) {
        this.#notice(text.thinkingNone);
        return;
      }
      this.#notice(
        [
          text.thinkingList,
          ...blocks.map((block) =>
            text.thinkingBlockLine(block.number, block.label, this.#thinkingSeconds(block)),
          ),
        ].join('\n'),
      );
      return;
    }
    const block = this.#thinking.byNumber(Number(argument));
    if (block === undefined) {
      const all = this.#thinking.blocks();
      this.#notice(text.thinkingMissing(Number(argument), all[0]?.number, all.at(-1)?.number));
      return;
    }
    this.#deps.view.print({
      kind: 'THINKING',
      text: [
        text.thinkingHeader(block.label, this.#thinkingSeconds(block), block.state),
        block.text,
        ...(block.cut ? [text.thinkingCut] : []),
      ].join('\n'),
    });
  }

  /** SubAgents under the AgentRun that started them, drawn as a tree (M2Design 11.1). */
  #activityTree(): ActivityLine[] {
    // An AgentRun that is writing its answer for the user says so on its own line, with its own
    // time: that is what it does now, and a second line would run a second clock.
    const answering = new Map(
      [...this.#answering.values()].map((answer) => [answer.agentRunId, answer.startedAt]),
    );
    const generating = new Map(
      [...this.#generating.values()].map((call) => [call.agentRunId, call]),
    );
    return inTree(
      [...this.#activity.values()].map((line) => {
        if (line.waitsForUser === true) return line;
        const startedAt = answering.get(line.agentRunId);
        if (startedAt !== undefined)
          return { ...line, phase: text.answeringPhase, since: startedAt };
        const call = generating.get(line.agentRunId);
        return call === undefined
          ? line
          : {
              ...line,
              phase: text.generating(call.name, call.target),
              since: call.startedAt,
            };
      }),
    ).map(({ item, branch }) => ({ ...item, branch }));
  }

  /** `/timeline`: when each AgentRun of this run started and ended, children below parents. */
  #showTimeline(): void {
    if (this.#timeline.length === 0) {
      this.#notice(text.timelineEmpty);
      return;
    }
    const now = this.#now().toISOString();
    const lines = inTree(this.#timeline).map(({ item, depth }) =>
      text.timelineLine(
        '  '.repeat(depth),
        item.label,
        item.from,
        item.to,
        secondsBetween(item.from, item.to ?? now),
      ),
    );
    this.#notice(lines.join('\n'));
  }

  #notice(message: string): void {
    if (message.length > 0) this.#deps.view.print({ kind: 'NOTICE', text: message });
  }

  /** Memory ran short (Kernel/Monitor 4a): the user is told at once, whatever the Console is doing. */
  notifyMemory(notice: {
    source: 'PROCESS' | 'SYSTEM';
    level: 'WARNING' | 'DANGER';
    ratio: number;
  }): void {
    this.#notice(text.memory(notice.source, notice.level, notice.ratio));
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

  /** 0, or the code of an interrupt that ended the session (75: out of memory, resume later). */
  get exitCode(): number {
    return this.#exitCode;
  }

  /**
   * Leaves with this code, as when the user asks to: the system stops in the normal way. Used
   * when the system must end for a reason outside the conversation and no run can say so.
   */
  exitWith(code: number): void {
    this.#exitCode = code;
    void this.shutdown('EXIT_CODE').catch(() => undefined);
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
    if (exceedsInputLimit(input)) {
      this.#notice(text.inputTooLarge(inputBytes(input), MAX_INPUT_BYTES));
      return;
    }
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
    // A paused run goes on with what the user writes: the message is the note that comes with it.
    if (this.#runState === 'PAUSED') {
      await this.#resume(input);
      return;
    }
    // Nothing waits for input: the message waits in the console, Kernel never sees it (5.2).
    this.#queued.push(input);
    // After an interrupt there is no run to wait for: this message opens the next one, and the
    // new run's first request for input takes it. Refused while the old run is still closing; the
    // flag stays, and the next message tries again.
    if (this.#continueOnInput && this.#sessionId !== undefined) {
      for (let attempt = 0; attempt < 5 && this.#sessionId !== undefined; attempt += 1) {
        const opened = await this.#deps.gateway.openSession(
          { requestId: newId('req'), sessionId: this.#sessionId },
          this.#context(),
        );
        if (opened.outcome === 'ACCEPTED') {
          this.#continueOnInput = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    this.#refresh();
  }

  /** Esc while something is queued takes back the last message. */
  withdrawLast(): string | undefined {
    const last = this.#queued.pop();
    this.#refresh();
    return last;
  }

  /**
   * Ctrl+C (Module/UserInteraction 5.4): pauses a running run, aborts a paused one, and leaves the
   * rest as before: twice within two seconds leaves the program.
   */
  async interrupt(): Promise<void> {
    const sessionId = this.#sessionId;
    const workflowRunId = this.#workflowRunId;
    if (sessionId !== undefined && workflowRunId !== undefined) {
      const request = { requestId: newId('req'), sessionId, workflowRunId };
      if (this.#runState === 'RUNNING') {
        await this.#deps.gateway.pauseRun(request, this.#context());
        return;
      }
      if (this.#runState === 'PAUSING' || this.#runState === 'PAUSED') {
        this.#notice(text.aborting);
        await this.#deps.gateway.interruptRun(request, this.#context());
        return;
      }
      if (this.#runState === 'INTERRUPTING') return;
    }
    const now = this.#now().getTime();
    if (this.#interruptedAt !== undefined && now - this.#interruptedAt <= INTERRUPT_WINDOW_MS) {
      await this.shutdown('INTERRUPT_TWICE');
      return;
    }
    this.#interruptedAt = now;
    this.#hint = text.pressAgain;
    this.#refresh();
  }

  /** Asks the Kernel to close the Session and stop the system; `exited()` then resolves. */
  async shutdown(source: ShutdownSource): Promise<void> {
    await this.#deps.gateway.shutdown({ requestId: newId('req'), source }, this.#context());
    this.#exit?.();
  }

  /** The AgentRun a `@name` stands for, by what the activity area shows. */
  #target(name: string | undefined): { readonly agentRunId?: string; readonly error?: string } {
    if (name === undefined) return {};
    const lines = [...this.#activity.values()].filter(
      (line) => line.label === name || line.label.endsWith(` ${name}`),
    );
    const [only] = lines;
    if (lines.length === 1 && only !== undefined) return { agentRunId: only.agentRunId };
    return { error: lines.length === 0 ? text.noSuchTask(name) : text.ambiguousTask(name) };
  }

  /** A note slipped into a run that goes on (Alt+Enter, `/steer`): nothing stops (M2Design 4.5). */
  async steer(raw: string): Promise<void> {
    const sessionId = this.#sessionId;
    const workflowRunId = this.#workflowRunId;
    const { name, text: note } = addressed(raw);
    if (exceedsInputLimit(note)) {
      this.#notice(text.inputTooLarge(inputBytes(note), MAX_INPUT_BYTES));
      return;
    }
    if (
      this.#runState !== 'RUNNING' ||
      sessionId === undefined ||
      workflowRunId === undefined ||
      note.length === 0
    ) {
      this.#notice(text.steerNotNow);
      return;
    }
    const target = this.#target(name);
    if (target.error !== undefined) {
      this.#notice(target.error);
      return;
    }
    const response = await this.#deps.gateway.steerRun(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        input: { inputId: newId('inp'), text: note },
        ...(target.agentRunId === undefined ? {} : { targetAgentRunId: target.agentRunId }),
      },
      this.#context(),
    );
    if (response.outcome === 'REJECTED') {
      this.#notice(describeReason(response.reasonCode));
      return;
    }
    this.#deps.view.print({ kind: 'USER', text: terminalText(note) });
    const line =
      target.agentRunId === undefined
        ? [...this.#activity.values()].find((each) => each.parentAgentRunId === undefined)
        : this.#activity.get(target.agentRunId);
    this.#notice(
      text.steered(
        line?.phase === text.phase.WAITING_SUBTASKS || line?.phase === text.phase.AWAITING_ANSWER,
      ),
    );
    this.#refresh();
  }

  /** `/continue`, or a plain message while paused: the run goes on, with a note if there is one. */
  async #resume(raw: string): Promise<void> {
    const sessionId = this.#sessionId;
    const workflowRunId = this.#workflowRunId;
    if (this.#runState !== 'PAUSED' || sessionId === undefined || workflowRunId === undefined) {
      this.#notice(text.continueNotNow);
      return;
    }
    const { name, text: note } = addressed(raw);
    const target = this.#target(name);
    if (target.error !== undefined) {
      this.#notice(target.error);
      return;
    }
    const response = await this.#deps.gateway.resumeRun(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        ...(note.length === 0
          ? {}
          : {
              steer: {
                input: { inputId: newId('inp'), text: note },
                ...(target.agentRunId === undefined ? {} : { targetAgentRunId: target.agentRunId }),
              },
            }),
      },
      this.#context(),
    );
    if (response.outcome === 'REJECTED') {
      this.#notice(describeReason(response.reasonCode));
      return;
    }
    if (note.length > 0) this.#deps.view.print({ kind: 'USER', text: terminalText(note) });
    this.#notice(text.resumed);
  }

  /** A question of `ask_user`: shown with who asked it, answered field by field (M2Design 4.2). */
  async #askQuestion(
    event: Extract<KernelToInteractionEvent, { type: 'HumanRequest' }> & {
      readonly kind: 'ask' | 'confirm' | 'review';
    },
  ): Promise<void> {
    const agent = this.#activity.get(event.attachedAgentRunId)?.label ?? 'Agent';
    const lines = [text.question.from(terminalText(agent)), terminalText(event.question)];
    if (event.kind === 'review' && event.reviewRef !== undefined)
      lines.push(text.question.review, terminalText((await this.#read(event.reviewRef)) ?? ''));
    const item: Extract<PendingItem, { kind: 'QUESTION' }> = {
      kind: 'QUESTION',
      humanRequestId: event.humanRequestId,
      question: event.kind,
      fields: event.fields ?? [],
      next: 0,
      values: {},
      body: lines.join('\n'),
      text: '',
    };
    this.#pending.push({ ...item, text: this.#questionPrompt(item) });
  }

  /** What the user is asked now: the question, and the field in turn when there are fields. */
  #questionPrompt(item: Extract<PendingItem, { kind: 'QUESTION' }>): string {
    const field = item.fields[item.next];
    if (field === undefined)
      return `${item.body}\n${item.question === 'confirm' ? text.question.confirmMenu : item.question === 'review' ? text.question.review_note : ''}`.trimEnd();
    const extra =
      field.type === 'select' || field.type === 'multiselect'
        ? [
            text.question.options(field.options ?? []),
            ...(field.type === 'multiselect' ? [text.question.multi] : []),
          ]
        : field.type === 'confirm'
          ? [text.question.confirmMenu]
          : [];
    return [
      item.body,
      text.question.field(terminalText(field.label), item.next, item.fields.length),
      ...extra.map(terminalText),
      ...(field.required === true ? [] : [text.question.skip]),
    ].join('\n');
  }

  async #answerQuestion(
    item: Extract<PendingItem, { kind: 'QUESTION' }>,
    input: string,
  ): Promise<void> {
    const field = item.fields[item.next];
    if (field === undefined) {
      const answer = input.trim();
      let said = answer;
      if (item.question === 'confirm') {
        if (/^(y|yes|是|好)$/iu.test(answer)) said = 'yes';
        else if (/^(n|no|否|不)$/iu.test(answer)) said = 'no';
        else {
          this.#hint = text.question.invalid;
          return;
        }
      }
      this.#pending.shift();
      this.#deps.view.print({ kind: 'USER', text: terminalText(said) });
      await this.#sendAnswer(item.humanRequestId, said);
      return;
    }
    const value = fieldValue(field, input);
    if (value === undefined) {
      this.#hint = text.question.invalid;
      this.#refresh();
      return;
    }
    const values = value === SKIP ? item.values : { ...item.values, [field.name]: value };
    const next = item.next + 1;
    if (next < item.fields.length) {
      const advanced = { ...item, next, values };
      this.#pending[0] = { ...advanced, text: this.#questionPrompt(advanced) };
      this.#refresh();
      return;
    }
    this.#pending.shift();
    await this.#sendAnswer(item.humanRequestId, JSON.stringify(values));
  }

  async #sendAnswer(humanRequestId: string, answer: string): Promise<void> {
    const sessionId = this.#sessionId;
    const workflowRunId = this.#workflowRunId;
    if (sessionId === undefined || workflowRunId === undefined) return;
    await this.#deps.gateway.answerHuman(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        humanRequestId,
        input: { inputId: newId('inp'), text: answer },
      },
      this.#context(),
    );
    this.#refresh();
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
    if (item.kind === 'QUESTION') {
      await this.#answerQuestion(item, input);
      return;
    }
    if (
      item.kind === 'AUTHORIZATION' &&
      item.detail !== undefined &&
      /^(v|view|查看)$/iu.test(input.trim())
    ) {
      // Looking is not answering: the question stays where it is.
      this.#notice(item.detail);
      return;
    }
    const choice = item.kind === 'AUTHORIZATION' ? commandChoice(item, input) : undefined;
    const wider = item.kind === 'AUTHORIZATION' ? widerChoice(item, input) : undefined;
    const yes =
      wider !== undefined ||
      (choice !== undefined ? choice !== 'DENY' : /^(y|yes|是|好)$/iu.test(input));
    const no = choice !== undefined ? choice === 'DENY' : /^(n|no|否|不)$/iu.test(input);
    if (!yes && !no) {
      // An undo has no timer: the next message simply goes on, and the Kernel cancels it.
      if (item.kind !== 'UNDO') return;
      this.#pending.shift();
      await this.submit(input);
      return;
    }
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
        answer: { scope: scopeOf(item, yes, input) },
      },
      this.#context(),
    );
    this.#refresh();
  }

  async #command(input: string): Promise<void> {
    const [name = '', argument] = input.split(/\s+/u);
    const rest = input.slice(name.length).trim();
    const listed = (value: string | undefined) => {
      const index = Number(value) - 1;
      return this.#listed[index] ?? value;
    };
    switch (name) {
      case '/help':
        this.#notice(text.help);
        break;
      case '/exit':
        await this.shutdown('EXIT_COMMAND');
        break;
      case '/timeline':
        this.#showTimeline();
        break;
      case '/think':
        this.#showThinking(argument);
        break;
      case '/continue':
        await this.#resume(rest);
        break;
      case '/steer':
        await this.steer(rest);
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
        if (
          sessionId === undefined ||
          workflowRunId === undefined ||
          (argument !== undefined && argument !== 'all')
        ) {
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
      case '/compact': {
        const sessionId = this.#sessionId;
        const workflowRunId = this.#workflowRunId;
        if (sessionId === undefined || workflowRunId === undefined || argument !== undefined) {
          this.#notice(text.notNow);
          break;
        }
        const asked = await this.#deps.gateway.compactContext(
          { requestId: newId('req'), sessionId, workflowRunId },
          this.#context(),
        );
        if (asked.outcome === 'REJECTED')
          this.#notice(
            asked.reasonCode === 'REQUEST_CONFLICT'
              ? text.compactNotNow
              : describeReason(asked.reasonCode),
          );
        else {
          // From now on the screen says that the system works, and for how long, like for any tool.
          this.#contextShare = undefined;
          this.#activity.set(COMPACTION_LINE, {
            agentRunId: COMPACTION_LINE,
            label: text.system,
            phase: text.phase.COMPACTING,
            since: this.#now().toISOString(),
          });
          this.#refresh();
        }
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
      else {
        this.#notice(text.recentSessions);
        this.#deps.view.print({
          kind: 'LIST',
          text: event.sessions
            .slice(0, 10)
            .map((session, index) =>
              text.sessionLine(
                index + 1,
                terminalText(session.title ?? text.untitled),
                session.turnCount,
              ),
            )
            .join('\n'),
        });
      }
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
        if (this.#sessionId === envelope.sessionId) {
          this.#sessionId = undefined;
          this.#workflowRunId = undefined;
        }
        this.#deps.view.print({ kind: 'ERROR', text: text.sessionFailed[event.code] });
        break;
      case 'SessionClosed':
        if (this.#sessionId === envelope.sessionId) {
          this.#sessionId = undefined;
          this.#workflowRunId = undefined;
          this.#continueOnInput = false;
        }
        break;
    }
    this.#refresh();
    return Promise.resolve();
  }

  async handleRunEvent(envelope: InteractionInboxEvent): Promise<void> {
    const { event } = envelope;
    this.#workflowRunId = envelope.workflowRunId;
    if (this.#timelineRun !== envelope.workflowRunId) {
      this.#timelineRun = envelope.workflowRunId;
      this.#timeline.length = 0;
    }
    switch (event.type) {
      case 'RunStateChanged': {
        this.#streamBelongsTo(this.#sessionId);
        // Nothing streams once the run waits for the user or is over: no block stays open.
        if (event.state !== 'RUNNING' && event.state !== 'PAUSING' && event.state !== 'PAUSED') {
          this.#answering.clear();
          this.#generating.clear();
        }
        const at = this.#now().toISOString();
        if (['AWAITING_INPUT', 'CONVERGING', 'CLOSED'].includes(event.state))
          this.#thinking.closeAll(at, 'DONE');
        else if (event.state === 'INTERRUPTING') this.#thinking.closeAll(at, 'ABORTED');
        this.#runState = event.state;
        // A requested compaction ends with its own event or with a change of the run's state (a
        // fork that cancels it); the run does not change state while it is compacting.
        this.#activity.delete(COMPACTION_LINE);
        if (event.state === 'INTERRUPTING') this.#aborting = true;
        // The tree stays while the run is held, so that a note can still name its task.
        if (event.state === 'AWAITING_INPUT' || event.state === 'CONVERGING')
          this.#activity.clear();
        if (event.state === 'PAUSED') this.#hint = text.paused;
        else if (event.state === 'RUNNING') this.#hint = undefined;
        break;
      }
      case 'HumanRequest': {
        if (event.kind !== 'prompt') {
          await this.#askQuestion(event);
          break;
        }
        this.#openRequest = event.humanRequestId;
        // After an abort what was queued goes back to the input box, to be sent or dropped.
        if (this.#aborting) {
          this.#aborting = false;
          this.#putBack();
          break;
        }
        const next = this.#queued.shift();
        if (next !== undefined) await this.#answerHuman(next);
        break;
      }
      case 'HumanResolved': {
        if (this.#openRequest === event.humanRequestId) this.#openRequest = undefined;
        const index = this.#pending.findIndex(
          (item) => item.kind === 'QUESTION' && item.humanRequestId === event.humanRequestId,
        );
        if (index >= 0) {
          this.#pending.splice(index, 1);
          if (event.resolution === 'CANCELLED') this.#notice(text.questionCancelled);
        }
        break;
      }
      case 'AuthorizationRequest':
        this.#pending.push({
          kind: 'AUTHORIZATION',
          questionId: event.questionId,
          once: event.capability === 'workspace.write' && event.critical,
          ...(event.capability === 'command.exec' ? { options: event.options } : {}),
          ...(event.capability === 'web.fetch'
            ? { wider: 'ANY_HOST' as const }
            : event.capability === 'web.search'
              ? { wider: 'FOLDER' as const }
              : {}),
          // A long command is shown by its head; the whole of it is one key away.
          ...(event.capability === 'command.exec' && commandPreview(event.command).cut
            ? { detail: terminalText(event.command) }
            : {}),
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
      case 'ContextCompacted':
        this.#activity.delete(COMPACTION_LINE);
        this.#deps.view.print({
          kind: 'STEP',
          text: text.compacted(
            event.compactedTurns,
            event.prunedResults,
            event.summaryRef !== undefined,
          ),
        });
        break;
      case 'CompactionFailed':
        this.#activity.delete(COMPACTION_LINE);
        this.#notice(text.compactionFailed[event.reason]);
        break;
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
        // A compaction that begins (the run's own, before a call) hides the share: it is about to change.
        if (event.phase === 'COMPACTING') this.#contextShare = undefined;
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
                `${String(todos.completed)}/${String(todos.total)}${todos.current === undefined ? '' : ` · ${todos.current}`}`,
              );
        const shown = tool ?? progress;
        const entry = this.#timeline.find((each) => each.agentRunId === event.agentRunId);
        if (entry === undefined)
          this.#timeline.push({
            agentRunId: event.agentRunId,
            ...(event.parentAgentRunId === undefined
              ? {}
              : { parentAgentRunId: event.parentAgentRunId }),
            label: terminalText(event.label),
            from: event.at,
          });
        if (event.phase === 'ENDED' && entry !== undefined) entry.to = event.at;
        this.#activity.set(event.agentRunId, {
          agentRunId: event.agentRunId,
          ...(event.parentAgentRunId === undefined
            ? {}
            : { parentAgentRunId: event.parentAgentRunId }),
          label: terminalText(event.label),
          phase: text.phase[event.phase],
          // Waiting for the user is not work that is taking long: no seconds are counted for it.
          ...(WAITS_FOR_USER.has(event.phase) ? { waitsForUser: true } : {}),
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
        // What was being written is now the message itself.
        this.#answering.clear();
        await this.#published(event.kind, event.agentLabel, event.messageRef);
        if (event.wrapUpReason !== undefined)
          this.#deps.view.print({
            kind: 'NOTICE',
            text: text.earlyEnd[event.wrapUpReason] ?? event.wrapUpReason,
          });
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
    if (event.capability === 'command.exec') return text.command(event);
    if (event.capability === 'web.search')
      return text.webSearch(event.queries.map(terminalText), terminalText(event.provider));
    if (event.capability === 'web.fetch')
      return text.webFetch(terminalText(event.host), terminalText(event.url));
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
    this.#aborting = false;
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
    // An interrupted conversation stays open: the log is complete, and the next message starts
    // a new Turn (refused with the reason while memory is still short). Only a one-shot command
    // leaves, with code 75, through the exit code of its close reason below.
    if (event.closeReason === 'INTERRUPTED' && this.#finished === undefined)
      this.#continueOnInput = true;
    if (this.#finished !== undefined) {
      this.#finished(RUN_EXIT_CODES[event.closeReason]);
      return;
    }
    if (event.closeReason === 'BUDGET')
      this.#pending.push({ kind: 'CONTINUE', text: text.continueAfterBudget });
  }
}
