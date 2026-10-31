import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  admitWork,
  answerOpenInput,
  attemptEnded,
  attemptStarted,
  beginConvergence,
  closeRun,
  endAgentRun,
  initialRunControl,
  openInitialTurn,
  readsProjectFile,
  registerAgentRun,
  requestOpenInput,
  type Decision,
  type RunControl,
} from './run-control.js';

function accepted<T>(decision: Decision<T>): RunControl {
  if (!decision.accepted) throw new Error(`refused: ${decision.reasonCode}`);
  return decision.control;
}
const refused = (decision: Decision<unknown>): string | undefined =>
  decision.accepted ? undefined : decision.reasonCode;

const running = (): RunControl => accepted(openInitialTurn(initialRunControl(), 'trn_1'));
const waiting = (): RunControl => accepted(requestOpenInput(running(), 'hrq_1'));
const converging = (): RunControl => accepted(beginConvergence(running()));
const closed = (): RunControl => closeRun(converging());

describe('the table of Kernel/Interaction 6.5', () => {
  it('admits work only in an open Turn', () => {
    expect(admitWork(running()).accepted).toBe(true);
    expect(refused(admitWork(initialRunControl()))).toBe('NO_OPEN_TURN');
    expect(refused(admitWork(waiting()))).toBe('NO_OPEN_TURN');
    expect(refused(admitWork(converging()))).toBe('RUN_BLOCKED');
    expect(refused(admitWork(closed()))).toBe('RUN_BLOCKED');
  });

  it('takes endAgentRun in every state, with no effect once closing', () => {
    const active = accepted(registerAgentRun(running(), 'agr_1'));
    expect(accepted(endAgentRun(active, 'agr_1')).activeAgentRuns.size).toBe(0);
    expect(endAgentRun(waiting(), 'agr_1').accepted).toBe(true);
    const closing = accepted(beginConvergence(active));
    expect(accepted(endAgentRun(closing, 'agr_1')).activeAgentRuns.has('agr_1')).toBe(true);
  });

  it('asks for open input only at rest, and closes the Turn', () => {
    const decision = requestOpenInput(running(), 'hrq_1');
    expect(decision).toMatchObject({ accepted: true, effect: { closedTurnId: 'trn_1' } });
    const control = accepted(decision);
    expect(control).toMatchObject({ phase: 'AWAITING_INPUT', humanRequestId: 'hrq_1' });
    expect(control.turnId).toBeUndefined();
    expect(refused(requestOpenInput(accepted(registerAgentRun(running(), 'a')), 'h'))).toBe(
      'AGENT_RUN_ACTIVE',
    );
    expect(refused(requestOpenInput(attemptStarted(running(), 'u'), 'h'))).toBe('AGENT_RUN_ACTIVE');
    expect(refused(requestOpenInput(waiting(), 'h'))).toBe('REQUEST_CONFLICT');
    expect(refused(requestOpenInput(converging(), 'h'))).toBe('RUN_BLOCKED');
  });

  it('closes no Turn when a run asks first', () => {
    expect(requestOpenInput(initialRunControl(), 'hrq_1')).toMatchObject({
      accepted: true,
      effect: {},
    });
  });

  it('opens a Turn only on the pending request', () => {
    expect(accepted(answerOpenInput(waiting(), 'hrq_1', 'trn_2'))).toMatchObject({
      phase: 'RUNNING',
      turnId: 'trn_2',
    });
    expect(refused(answerOpenInput(waiting(), 'hrq_x', 't'))).toBe('HUMAN_REQUEST_NOT_PENDING');
    expect(refused(answerOpenInput(running(), 'hrq_1', 't'))).toBe('HUMAN_REQUEST_NOT_PENDING');
    expect(refused(answerOpenInput(closed(), 'hrq_1', 't'))).toBe('HUMAN_REQUEST_NOT_PENDING');
  });

  it('reads project files until the run is closing', () => {
    expect(readsProjectFile(running()).accepted).toBe(true);
    expect(readsProjectFile(waiting()).accepted).toBe(true);
    expect(refused(readsProjectFile(converging()))).toBe('RUN_BLOCKED');
  });

  it('closes an open Turn when the run converges, once', () => {
    expect(beginConvergence(running())).toMatchObject({ effect: { closedTurnId: 'trn_1' } });
    expect(beginConvergence(waiting())).toMatchObject({ effect: {} });
    expect(beginConvergence(converging())).toEqual({ accepted: true, control: converging() });
    expect(accepted(beginConvergence(waiting())).humanRequestId).toBeUndefined();
  });
});

describe('invariants 4 and 18', () => {
  type Step = 'register' | 'end' | 'start' | 'finish' | 'ask' | 'answer';
  const apply = (control: RunControl, step: Step): RunControl => {
    const keep = (decision: Decision<unknown>) => (decision.accepted ? decision.control : control);
    switch (step) {
      case 'register':
        return keep(registerAgentRun(control, 'agr_1'));
      case 'end':
        return keep(endAgentRun(control, 'agr_1'));
      case 'start':
        return control.turnId === undefined ? control : attemptStarted(control, 'una_1');
      case 'finish':
        return attemptEnded(control, 'una_1');
      case 'ask':
        return keep(requestOpenInput(control, 'hrq_1'));
      case 'answer':
        return keep(answerOpenInput(control, 'hrq_1', 'trn_2'));
    }
  };

  it('never waits for input with work active, and never has a Turn while waiting', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Step>('register', 'end', 'start', 'finish', 'ask', 'answer'), {
          maxLength: 40,
        }),
        (steps) => {
          let control = running();
          for (const step of steps) {
            control = apply(control, step);
            if (control.phase === 'AWAITING_INPUT') {
              expect(control.activeAgentRuns.size).toBe(0);
              expect(control.inFlightAttempts.size).toBe(0);
              expect(control.turnId).toBeUndefined();
            }
          }
        },
      ),
    );
  });
});
