import type { CoreRejectedCode } from '@multiagentos/contracts';

/**
 * The run states and what each request may do in them (Kernel/Interaction 6.5), as a pure
 * function. Turns open only when open input is answered and close only at rest, so "nothing is
 * active while waiting for input" holds by construction (invariants 4 and 18).
 */
export type RunPhase = 'RUNNING' | 'AWAITING_INPUT' | 'CONVERGING' | 'CLOSED';

export interface RunControl {
  readonly phase: RunPhase;
  readonly turnId?: string;
  readonly humanRequestId?: string;
  readonly activeAgentRuns: ReadonlySet<string>;
  readonly inFlightAttempts: ReadonlySet<string>;
}

export const initialRunControl = (): RunControl => ({
  phase: 'RUNNING',
  activeAgentRuns: new Set(),
  inFlightAttempts: new Set(),
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
});
const isClosing = (control: RunControl): boolean =>
  control.phase === 'CONVERGING' || control.phase === 'CLOSED';

/** `registerAgentRun` and `submitUnit`: work belongs to an open Turn. */
export function admitWork(control: RunControl): Decision {
  if (isClosing(control)) return refuse('RUN_BLOCKED');
  if (control.turnId === undefined) return refuse('NO_OPEN_TURN');
  return { accepted: true, control };
}

export function registerAgentRun(control: RunControl, agentRunId: string): Decision {
  const admitted = admitWork(control);
  if (!admitted.accepted) return admitted;
  return {
    accepted: true,
    control: { ...control, activeAgentRuns: new Set([...control.activeAgentRuns, agentRunId]) },
  };
}

/** Accepted without effect once the run is closing, as the table says. */
export function endAgentRun(control: RunControl, agentRunId: string): Decision {
  if (isClosing(control)) return { accepted: true, control };
  const activeAgentRuns = new Set(control.activeAgentRuns);
  activeAgentRuns.delete(agentRunId);
  return { accepted: true, control: { ...control, activeAgentRuns } };
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

/** `requestHuman(prompt)`: the effect names the Turn this closes, if one was open. */
export function requestOpenInput(
  control: RunControl,
  humanRequestId: string,
): Decision<{ readonly closedTurnId?: string }> {
  if (isClosing(control)) return refuse('RUN_BLOCKED');
  if (control.phase === 'AWAITING_INPUT') return refuse('REQUEST_CONFLICT');
  if (control.activeAgentRuns.size > 0 || control.inFlightAttempts.size > 0)
    return refuse('AGENT_RUN_ACTIVE');
  const { turnId, ...rest } = control;
  return {
    accepted: true,
    control: { ...rest, phase: 'AWAITING_INPUT', humanRequestId },
    effect: turnId === undefined ? {} : { closedTurnId: turnId },
  };
}

/** The first input of a run opens its Turn without a request before it. */
export function openInitialTurn(control: RunControl, turnId: string): Decision {
  if (control.phase !== 'RUNNING' || control.turnId !== undefined)
    return refuse('REQUEST_CONFLICT');
  return { accepted: true, control: { ...control, turnId } };
}

export function answerOpenInput(
  control: RunControl,
  humanRequestId: string,
  turnId: string,
): Decision {
  if (control.phase !== 'AWAITING_INPUT' || control.humanRequestId !== humanRequestId)
    return refuse('HUMAN_REQUEST_NOT_PENDING');
  return { accepted: true, control: { ...work(control), phase: 'RUNNING', turnId } };
}

export function readsProjectFile(control: RunControl): Decision {
  return isClosing(control) ? refuse('RUN_BLOCKED') : { accepted: true, control };
}

/** Any live state may start closing; a Turn still open ends just before RunClosed. */
export function beginConvergence(
  control: RunControl,
): Decision<{ readonly closedTurnId?: string }> {
  if (isClosing(control)) return { accepted: true, control };
  const { turnId } = control;
  return {
    accepted: true,
    control: { ...work(control), phase: 'CONVERGING' },
    effect: turnId === undefined ? {} : { closedTurnId: turnId },
  };
}

export function closeRun(control: RunControl): RunControl {
  return { ...control, phase: 'CLOSED' };
}
