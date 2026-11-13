import type { CoreRejectedCode, InterruptReason } from '@multiagentos/contracts';

/**
 * The run states and what each request may do in them (Kernel/Interaction 6.5, Kernel/Core 5e), as
 * a pure function. The work of an input opens only when open input is answered and settles only at
 * rest, so "nothing is active while waiting for input" holds by construction (invariants 4 and 18).
 */
export type RunPhase =
  'RUNNING' | 'PAUSING' | 'PAUSED' | 'INTERRUPTING' | 'AWAITING_INPUT' | 'CONVERGING' | 'CLOSED';

export interface LocalQuestion {
  readonly agentRunId: string;
  readonly nodeId: string;
  /** What the question asks, which the answer repeats to Workflow. */
  readonly kind: 'ask' | 'confirm' | 'review';
}

export interface RunControl {
  readonly phase: RunPhase;
  /** The checkpoint of the input whose work goes on (Orchestration 7.1); none while waiting. */
  readonly openInput?: string;
  readonly humanRequestId?: string;
  /** Why the run is INTERRUPTING; only there. */
  readonly interrupt?: InterruptReason;
  readonly activeAgentRuns: ReadonlySet<string>;
  readonly inFlightAttempts: ReadonlySet<string>;
  /** The local questions waiting for an answer: who asked, and the node that stands for it. */
  readonly questions: ReadonlyMap<string, LocalQuestion>;
}

export const initialRunControl = (): RunControl => ({
  phase: 'RUNNING',
  activeAgentRuns: new Set(),
  inFlightAttempts: new Set(),
  questions: new Map(),
});

export type Decision<T = undefined> =
  | { readonly accepted: true; readonly control: RunControl; readonly effect?: T }
  | { readonly accepted: false; readonly reasonCode: CoreRejectedCode | 'RUN_BLOCKED' };

const refuse = (reasonCode: CoreRejectedCode | 'RUN_BLOCKED'): Decision<never> => ({
  accepted: false,
  reasonCode,
});
const work = ({ activeAgentRuns, inFlightAttempts }: RunControl) => ({
  activeAgentRuns,
  inFlightAttempts,
  questions: new Map<string, LocalQuestion>(),
});
const isClosing = (control: RunControl): boolean =>
  control.phase === 'CONVERGING' || control.phase === 'CLOSED';
/** Work is held, not refused, while the run is paused or pausing (Kernel/Core 5e). */
const isHeld = (control: RunControl): boolean =>
  control.phase === 'PAUSING' || control.phase === 'PAUSED';
/** The work of an input goes on, whether it is paused or not. */
const isLive = (control: RunControl): boolean =>
  control.openInput !== undefined &&
  (control.phase === 'RUNNING' || control.phase === 'PAUSING' || control.phase === 'PAUSED');

/**
 * `registerAgentRun` and `submitUnit`: work belongs to the work of an input. An interrupted run still
 * admits a Unit here, so that its closing reply can be published; the rest is refused later.
 */
export function admitWork(control: RunControl): Decision {
  if (isClosing(control)) return refuse('RUN_BLOCKED');
  if (control.openInput === undefined) return refuse('NO_OPEN_INPUT');
  return { accepted: true, control };
}

export function registerAgentRun(control: RunControl, agentRunId: string): Decision {
  const admitted = admitWork(control);
  if (!admitted.accepted) return admitted;
  // An interrupted run starts no AgentRun; its Units are refused by Run work, which says why.
  if (control.phase === 'INTERRUPTING') return refuse('RUN_BLOCKED');
  return {
    accepted: true,
    control: { ...control, activeAgentRuns: new Set([...control.activeAgentRuns, agentRunId]) },
  };
}

/** Accepted without effect once the run is closing, as the table says. */
export function endAgentRun(
  control: RunControl,
  agentRunId: string,
  keepsQuestions = false,
): Decision {
  if (isClosing(control)) return { accepted: true, control };
  const activeAgentRuns = new Set(control.activeAgentRuns);
  activeAgentRuns.delete(agentRunId);
  // A question of an AgentRun that ended has no one to answer to, unless its task sleeps until the
  // answer (ask_user as a sleep): then the answer wakes the next segment.
  const questions = keepsQuestions
    ? control.questions
    : new Map([...control.questions].filter(([, asker]) => asker.agentRunId !== agentRunId));
  return { accepted: true, control: { ...control, activeAgentRuns, questions } };
}

export function attemptStarted(control: RunControl, unitAttemptId: string): RunControl {
  return {
    ...control,
    inFlightAttempts: new Set([...control.inFlightAttempts, unitAttemptId]),
  };
}

export function attemptEnded(control: RunControl, unitAttemptId: string): RunControl {
  const inFlightAttempts = new Set(control.inFlightAttempts);
  inFlightAttempts.delete(unitAttemptId);
  return { ...control, inFlightAttempts };
}

/** How the work of an input that an open-input request settles ended. */
export type InputEnd = 'COMPLETED' | 'ABORTED' | 'TIMEOUT';

const INPUT_END_OF: Readonly<Record<InterruptReason, InputEnd>> = {
  MEMORY_PRESSURE: 'ABORTED',
  USER_ABORT: 'ABORTED',
  PAUSE_TIMEOUT: 'ABORTED',
  INPUT_TIMEOUT: 'TIMEOUT',
};

/**
 * `requestHuman(prompt)`: the effect names the input whose work this settles, if one went on, and how
 * it ended (interrupted work ends ABORTED or TIMEOUT, M2Design 4.3).
 */
export function requestOpenInput(
  control: RunControl,
  humanRequestId: string,
): Decision<{ readonly settledInputId?: string; readonly inputEnd: InputEnd }> {
  if (isClosing(control)) return refuse('RUN_BLOCKED');
  if (isHeld(control) || control.phase === 'AWAITING_INPUT') return refuse('REQUEST_CONFLICT');
  if (control.activeAgentRuns.size > 0 || control.inFlightAttempts.size > 0)
    return refuse('AGENT_RUN_ACTIVE');
  const { openInput, interrupt, ...rest } = control;
  return {
    accepted: true,
    control: { ...rest, phase: 'AWAITING_INPUT', humanRequestId, questions: new Map() },
    effect: {
      inputEnd: interrupt === undefined ? 'COMPLETED' : INPUT_END_OF[interrupt],
      ...(openInput === undefined ? {} : { settledInputId: openInput }),
    },
  };
}

/** The first input of a run opens its work without a request before it. */
export function openInitialInput(control: RunControl, openInput: string): Decision {
  if (control.phase !== 'RUNNING' || control.openInput !== undefined)
    return refuse('REQUEST_CONFLICT');
  return { accepted: true, control: { ...control, openInput } };
}

export function answerOpenInput(
  control: RunControl,
  humanRequestId: string,
  openInput: string,
): Decision {
  if (control.phase !== 'AWAITING_INPUT' || control.humanRequestId !== humanRequestId)
    return refuse('HUMAN_REQUEST_NOT_PENDING');
  return { accepted: true, control: { ...work(control), phase: 'RUNNING', openInput } };
}

export function readsProjectFile(control: RunControl): Decision {
  return isClosing(control) ? refuse('RUN_BLOCKED') : { accepted: true, control };
}

/** Any live state may start closing; work of an input still going on settles just before RunClosed. */
export function beginConvergence(
  control: RunControl,
): Decision<{ readonly settledInputId?: string }> {
  if (isClosing(control)) return { accepted: true, control };
  const { openInput } = control;
  return {
    accepted: true,
    control: { ...work(control), phase: 'CONVERGING' },
    effect: openInput === undefined ? {} : { settledInputId: openInput },
  };
}

export function closeRun(control: RunControl): RunControl {
  return { ...control, phase: 'CLOSED' };
}

/** `pauseRun`: only while the work of an input runs. */
export function pauseRun(control: RunControl): Decision {
  if (control.phase !== 'RUNNING' || control.openInput === undefined)
    return refuse('REQUEST_CONFLICT');
  return { accepted: true, control: { ...control, phase: 'PAUSING' } };
}

/**
 * Execution has nothing executing any more (queued and parked attempts are held, not in flight in
 * this sense, Kernel/Execution 4e): the pausing run is paused now.
 */
export function pauseReached(control: RunControl): RunControl {
  return control.phase === 'PAUSING' ? { ...control, phase: 'PAUSED' } : control;
}

export function resumeRun(control: RunControl): Decision {
  if (control.phase !== 'PAUSED') return refuse('REQUEST_CONFLICT');
  return { accepted: true, control: { ...control, phase: 'RUNNING' } };
}

/**
 * `steerRun`: a note slipped in while the run goes on. Paused runs take theirs with `resumeRun`,
 * so the note and the continuation cannot come apart.
 */
export function steerRun(control: RunControl): Decision {
  return control.phase === 'RUNNING' && control.openInput !== undefined
    ? { accepted: true, control }
    : refuse('REQUEST_CONFLICT');
}

/**
 * The one entry of every interrupt (Kernel/Core 5e): the user's abort needs live work, the two
 * timeouts come from Core itself while one is live, and memory pressure takes any state that is
 * not yet closing. An interrupted run asked again changes nothing.
 */
export function beginInterrupt(
  control: RunControl,
  reason: InterruptReason,
): Decision<{ readonly firstTime: boolean }> {
  if (control.phase === 'INTERRUPTING')
    return { accepted: true, control, effect: { firstTime: false } };
  if (isClosing(control)) return refuse('REQUEST_CONFLICT');
  const live = isLive(control);
  if (reason !== 'MEMORY_PRESSURE' && !live) return refuse('REQUEST_CONFLICT');
  return {
    accepted: true,
    control: { ...control, phase: 'INTERRUPTING', interrupt: reason },
    effect: { firstTime: true },
  };
}

/** A local question (`ask`, `confirm`, `review`): it blocks only the AgentRun that asked. */
export function requestLocalQuestion(
  control: RunControl,
  humanRequestId: string,
  asked: LocalQuestion,
): Decision {
  if (!isLive(control)) return refuse(isClosing(control) ? 'RUN_BLOCKED' : 'NO_OPEN_INPUT');
  if (!control.activeAgentRuns.has(asked.agentRunId)) return refuse('AGENT_RUN_NOT_FOUND');
  if (control.questions.has(humanRequestId)) return refuse('REQUEST_CONFLICT');
  return {
    accepted: true,
    control: { ...control, questions: new Map([...control.questions, [humanRequestId, asked]]) },
  };
}

/** The answer to a local question, in a run that is paused too: it is delivered, and held there. */
export function answerLocalQuestion(control: RunControl, humanRequestId: string): Decision {
  if (!isLive(control) || !control.questions.has(humanRequestId))
    return refuse('HUMAN_REQUEST_NOT_PENDING');
  const questions = new Map(control.questions);
  questions.delete(humanRequestId);
  return { accepted: true, control: { ...control, questions } };
}
