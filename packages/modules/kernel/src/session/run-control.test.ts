import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  admitWork,
  answerLocalQuestion,
  answerOpenInput,
  attemptEnded,
  attemptStarted,
  beginConvergence,
  beginInterrupt,
  closeRun,
  endAgentRun,
  initialRunControl,
  openInitialInput,
  pauseReached,
  pauseRun,
  readsProjectFile,
  registerAgentRun,
  requestLocalQuestion,
  requestOpenInput,
  resumeRun,
  steerRun,
  type Decision,
  type RunControl,
} from './run-control.js';

function accepted<T>(decision: Decision<T>): RunControl {
  if (!decision.accepted) throw new Error(`refused: ${decision.reasonCode}`);
  return decision.control;
}
const refused = (decision: Decision<unknown>): string | undefined =>
  decision.accepted ? undefined : decision.reasonCode;

const running = (): RunControl => accepted(openInitialInput(initialRunControl(), 'trn_1'));
const waiting = (): RunControl => accepted(requestOpenInput(running(), 'hrq_1'));
const converging = (): RunControl => accepted(beginConvergence(running()));
const closed = (): RunControl => closeRun(converging());

describe('the table of Kernel/Interaction 6.5', () => {
  it('admits work only in an open Turn', () => {
    expect(admitWork(running()).accepted).toBe(true);
    expect(refused(admitWork(initialRunControl()))).toBe('NO_OPEN_INPUT');
    expect(refused(admitWork(waiting()))).toBe('NO_OPEN_INPUT');
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
    expect(decision).toMatchObject({ accepted: true, effect: { settledInputId: 'trn_1' } });
    const control = accepted(decision);
    expect(control).toMatchObject({ phase: 'AWAITING_INPUT', humanRequestId: 'hrq_1' });
    expect(control.openInput).toBeUndefined();
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

  it('opens the work of an input only on the pending request', () => {
    expect(accepted(answerOpenInput(waiting(), 'hrq_1', 'trn_2'))).toMatchObject({
      phase: 'RUNNING',
      openInput: 'trn_2',
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
    expect(beginConvergence(running())).toMatchObject({ effect: { settledInputId: 'trn_1' } });
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
        return control.openInput === undefined ? control : attemptStarted(control, 'una_1');
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
              expect(control.openInput).toBeUndefined();
            }
          }
        },
      ),
    );
  });
});

describe('run control of Kernel/Core 5e', () => {
  const active = (): RunControl => accepted(registerAgentRun(running(), 'agr_1'));
  const question = (agentRunId: string) => ({
    agentRunId,
    nodeId: 'nod_q',
    kind: 'ask' as const,
  });

  it('pauses only a running Turn, and is paused once Execution has drained', () => {
    const pausing = accepted(pauseRun(running()));
    expect(pausing.phase).toBe('PAUSING');
    expect(pauseReached(pausing).phase).toBe('PAUSED');
    expect(pauseReached(running()).phase).toBe('RUNNING');
    expect(refused(pauseRun(pausing))).toBe('REQUEST_CONFLICT');
    expect(refused(pauseRun(initialRunControl()))).toBe('REQUEST_CONFLICT');
    expect(refused(pauseRun(waiting()))).toBe('REQUEST_CONFLICT');
  });

  it('resumes only a paused run', () => {
    const paused = pauseReached(accepted(pauseRun(running())));
    expect(accepted(resumeRun(paused)).phase).toBe('RUNNING');
    expect(refused(resumeRun(running()))).toBe('REQUEST_CONFLICT');
    expect(refused(resumeRun(accepted(pauseRun(attemptStarted(running(), 'u')))))).toBe(
      'REQUEST_CONFLICT',
    );
  });

  it('takes a steer only while running; a paused run takes it with the resume', () => {
    expect(steerRun(running()).accepted).toBe(true);
    const paused = pauseReached(accepted(pauseRun(running())));
    expect(refused(steerRun(paused))).toBe('REQUEST_CONFLICT');
    expect(refused(steerRun(waiting()))).toBe('REQUEST_CONFLICT');
  });

  it('holds work while paused instead of refusing it', () => {
    const paused = pauseReached(accepted(pauseRun(running())));
    expect(admitWork(paused).accepted).toBe(true);
    expect(registerAgentRun(paused, 'agr_2').accepted).toBe(true);
  });

  it('interrupts a live Turn at the user, and any state that is not closing for memory', () => {
    const interrupted = accepted(beginInterrupt(active(), 'USER_ABORT'));
    expect(interrupted).toMatchObject({ phase: 'INTERRUPTING', interrupt: 'USER_ABORT' });
    const paused = pauseReached(accepted(pauseRun(running())));
    expect(beginInterrupt(paused, 'PAUSE_TIMEOUT').accepted).toBe(true);
    expect(refused(beginInterrupt(waiting(), 'USER_ABORT'))).toBe('REQUEST_CONFLICT');
    expect(accepted(beginInterrupt(waiting(), 'MEMORY_PRESSURE')).phase).toBe('INTERRUPTING');
    expect(refused(beginInterrupt(converging(), 'MEMORY_PRESSURE'))).toBe('REQUEST_CONFLICT');
    // Asked again, nothing changes and nothing is done twice.
    expect(beginInterrupt(interrupted, 'INPUT_TIMEOUT')).toMatchObject({
      accepted: true,
      effect: { firstTime: false },
      control: { interrupt: 'USER_ABORT' },
    });
  });

  it('lets nothing new in while interrupting, but lets the AgentRuns end and ask for input', () => {
    const interrupted = accepted(beginInterrupt(active(), 'USER_ABORT'));
    expect(admitWork(interrupted).accepted).toBe(true);
    expect(refused(registerAgentRun(interrupted, 'agr_2'))).toBe('RUN_BLOCKED');
    const ended = accepted(endAgentRun(interrupted, 'agr_1'));
    expect(ended.activeAgentRuns.size).toBe(0);
    expect(refused(requestOpenInput(interrupted, 'hrq_1'))).toBe('AGENT_RUN_ACTIVE');
  });

  it('ends the interrupted Turn as aborted or timed out, and keeps the run open', () => {
    const asked = (reason: Parameters<typeof beginInterrupt>[1]) =>
      requestOpenInput(accepted(beginInterrupt(running(), reason)), 'hrq_1');
    expect(asked('USER_ABORT')).toMatchObject({
      accepted: true,
      effect: { settledInputId: 'trn_1', inputEnd: 'ABORTED' },
      control: { phase: 'AWAITING_INPUT' },
    });
    expect(asked('INPUT_TIMEOUT')).toMatchObject({ effect: { inputEnd: 'TIMEOUT' } });
    expect(asked('PAUSE_TIMEOUT')).toMatchObject({ effect: { inputEnd: 'ABORTED' } });
    expect(requestOpenInput(running(), 'hrq_1')).toMatchObject({
      effect: { inputEnd: 'COMPLETED' },
    });
    const control = accepted(asked('USER_ABORT'));
    expect(control.interrupt).toBeUndefined();
    expect(accepted(answerOpenInput(control, 'hrq_1', 'trn_2')).phase).toBe('RUNNING');
  });

  it('refuses open input while paused', () => {
    const paused = pauseReached(accepted(pauseRun(running())));
    expect(refused(requestOpenInput(paused, 'h'))).toBe('REQUEST_CONFLICT');
  });

  it('asks a local question for an active AgentRun, without needing stillness', () => {
    const asked = accepted(requestLocalQuestion(active(), 'hrq_q', question('agr_1')));
    expect(asked.phase).toBe('RUNNING');
    expect(asked.questions.get('hrq_q')).toEqual({
      agentRunId: 'agr_1',
      nodeId: 'nod_q',
      kind: 'ask',
    });
    expect(refused(requestLocalQuestion(active(), 'hrq_q', question('agr_x')))).toBe(
      'AGENT_RUN_NOT_FOUND',
    );
    expect(refused(requestLocalQuestion(asked, 'hrq_q', question('agr_1')))).toBe(
      'REQUEST_CONFLICT',
    );
    expect(refused(requestLocalQuestion(waiting(), 'hrq_q', question('agr_1')))).toBe(
      'NO_OPEN_INPUT',
    );
    expect(refused(requestLocalQuestion(converging(), 'hrq_q', question('agr_1')))).toBe(
      'RUN_BLOCKED',
    );
  });

  it('answers a local question once, also in a paused run, and drops it when its asker ends', () => {
    const asked = accepted(requestLocalQuestion(active(), 'hrq_q', question('agr_1')));
    const answered = accepted(answerLocalQuestion(asked, 'hrq_q'));
    expect(answered.questions.size).toBe(0);
    expect(refused(answerLocalQuestion(answered, 'hrq_q'))).toBe('HUMAN_REQUEST_NOT_PENDING');
    const paused = pauseReached(accepted(pauseRun(asked)));
    expect(answerLocalQuestion(paused, 'hrq_q').accepted).toBe(true);
    expect(accepted(endAgentRun(asked, 'agr_1')).questions.size).toBe(0);
  });

  it('keeps the question of an AgentRun whose task sleeps until the answer (ask_user as a sleep)', () => {
    const asked = accepted(requestLocalQuestion(active(), 'hrq_q', question('agr_1')));
    const slept = accepted(endAgentRun(asked, 'agr_1', true));
    expect(slept.activeAgentRuns.has('agr_1')).toBe(false);
    expect(slept.questions.has('hrq_q')).toBe(true);
    expect(accepted(answerLocalQuestion(slept, 'hrq_q')).questions.size).toBe(0);
  });

  it('asks no open input while a local question is out, since the AgentRun is still active', () => {
    const asked = accepted(requestLocalQuestion(active(), 'hrq_q', question('agr_1')));
    expect(refused(requestOpenInput(asked, 'hrq_1'))).toBe('AGENT_RUN_ACTIVE');
  });
});
