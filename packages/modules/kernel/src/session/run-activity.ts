import type {
  ActivityEvent,
  ExecutionKind,
  MessagePublished,
  UnitReport,
} from '@multiagentos/contracts';
import type { AttemptSpec } from './run-attempts.js';

export type ActivityOutput = ActivityEvent | MessagePublished;

export interface RunActivityDeps {
  readonly emit: (event: ActivityOutput) => void;
  readonly now: () => Date;
}

/** Units the activity area names as tool calls; the rest have a phase of their own or none. */
const NOT_TOOLS: ReadonlySet<ExecutionKind> = new Set([
  'CONTEXT_ASSEMBLE',
  'MODEL',
  'MESSAGE_PUBLISH',
  'REPORT_PUBLISH',
]);

type Phase = ActivityEvent['phase'];
type UnitLine = NonNullable<ActivityEvent['unit']>;

/**
 * The activity area's events, from AgentRun registration and the UnitAttempt states (M2Design
 * 7.5): only for the interface, so nothing here decides anything. A published message goes out
 * as `MessagePublished` once its report is delivered.
 */
export class RunActivity {
  readonly #deps: RunActivityDeps;
  readonly #labels = new Map<string, string>();
  readonly #parents = new Map<string, string>();
  readonly #todos = new Map<string, NonNullable<ActivityEvent['todos']>>();

  public constructor(deps: RunActivityDeps) {
    this.#deps = deps;
  }

  todos(agentRunId: string, todos: NonNullable<ActivityEvent['todos']>): void {
    this.#todos.set(agentRunId, todos);
    this.#emit(agentRunId, 'THINKING');
  }

  registered(agentRunId: string, label: string, parentAgentRunId?: string): void {
    this.#labels.set(agentRunId, label);
    if (parentAgentRunId !== undefined) this.#parents.set(agentRunId, parentAgentRunId);
  }

  /** The AgentRun started tasks and waits for them. */
  waitingForSubtasks(agentRunId: string): void {
    this.#emit(agentRunId, 'WAITING_SUBTASKS');
  }

  #emit(agentRunId: string, phase: Exclude<Phase, 'RETRYING'>, unit?: UnitLine): void {
    const label = this.#labels.get(agentRunId);
    if (label === undefined) return;
    const todos = this.#todos.get(agentRunId);
    const parent = this.#parents.get(agentRunId);
    this.#deps.emit({
      type: 'ActivityEvent',
      agentRunId,
      ...(parent === undefined ? {} : { parentAgentRunId: parent }),
      label,
      phase,
      ...(unit === undefined ? {} : { unit }),
      ...(todos === undefined ? {} : { todos }),
      at: this.#deps.now().toISOString(),
    });
  }

  #unit(spec: AttemptSpec, unitAttemptId: string, state: UnitLine['state']): UnitLine {
    return { unitAttemptId, ...spec.display, state };
  }

  /** Execution took the attempt and queues it behind the one in flight. */
  queued(spec: AttemptSpec, unitAttemptId: string): void {
    if (NOT_TOOLS.has(spec.unit.executionKind)) return;
    this.#emit(spec.agentRunId, 'QUEUED', this.#unit(spec, unitAttemptId, 'QUEUED'));
  }

  /** The attempt was dispatched for the first time; `final` is a wrap-up call. */
  running(spec: AttemptSpec, unitAttemptId: string, final: boolean): void {
    switch (spec.unit.executionKind) {
      case 'CONTEXT_ASSEMBLE':
        this.#emit(spec.agentRunId, 'ASSEMBLING');
        return;
      case 'MODEL':
        this.#emit(spec.agentRunId, final ? 'WRAPPING_UP' : 'THINKING');
        return;
      case 'MESSAGE_PUBLISH':
      case 'REPORT_PUBLISH':
        return;
      default:
        this.#emit(spec.agentRunId, 'CALLING_TOOL', this.#unit(spec, unitAttemptId, 'RUNNING'));
    }
  }

  /** Execution waits before the next try (Kernel/Execution 4a). */
  retrying(spec: AttemptSpec, unitAttemptId: string, attempt: number, retryAt: string): void {
    const label = this.#labels.get(spec.agentRunId);
    if (label === undefined) return;
    const parent = this.#parents.get(spec.agentRunId);
    this.#deps.emit({
      type: 'ActivityEvent',
      agentRunId: spec.agentRunId,
      ...(parent === undefined ? {} : { parentAgentRunId: parent }),
      label,
      phase: 'RETRYING',
      ...(NOT_TOOLS.has(spec.unit.executionKind)
        ? {}
        : { unit: this.#unit(spec, unitAttemptId, 'RUNNING') }),
      retry: { attempt, retryAt },
      at: this.#deps.now().toISOString(),
    });
  }

  /** The AgentRun asked the user a question with `ask_user` and waits for the answer. */
  awaitingAnswer(agentRunId: string): void {
    this.#emit(agentRunId, 'AWAITING_ANSWER');
  }

  /** The run is paused: nothing of this AgentRun runs until it is continued. */
  paused(agentRunId: string): void {
    this.#emit(agentRunId, 'PAUSED');
  }

  /** A Unit of this AgentRun waits on a question to the user. */
  awaitingAuthorization(agentRunId: string): void {
    this.#emit(agentRunId, 'AWAITING_AUTHORIZATION');
  }

  /** A delivered report: a finished tool folds into a line, a published message is shown. */
  reported(spec: AttemptSpec | undefined, report: UnitReport): void {
    if (report.status !== 'OK' || !('unitAttemptId' in report)) return;
    const label = this.#labels.get(report.agentRunId);
    if (report.executionKind === 'MESSAGE_PUBLISH') {
      const { kind, wrapUpReason } = report.output as Partial<
        Pick<MessagePublished, 'kind' | 'wrapUpReason'>
      >;
      if (label === undefined || kind === undefined || report.outputRef === undefined) return;
      this.#deps.emit({
        type: 'MessagePublished',
        messageRef: report.outputRef,
        agentLabel: label,
        kind,
        ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
      });
      return;
    }
    if (spec === undefined || NOT_TOOLS.has(report.executionKind)) return;
    this.#emit(report.agentRunId, 'CALLING_TOOL', {
      ...this.#unit(spec, report.unitAttemptId, 'DONE'),
      ...(report.fullRef === undefined ? {} : { fullRef: report.fullRef }),
    });
  }

  ended(agentRunId: string): void {
    this.#emit(agentRunId, 'ENDED');
    this.#labels.delete(agentRunId);
    this.#parents.delete(agentRunId);
  }
}
