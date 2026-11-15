import type { ActivityEvent, BackgroundJobs, UnitReport } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { RunActivity, type ActivityOutput } from './run-activity.js';
import type { AttemptSpec } from './run-attempts.js';

const setup = () => {
  const events: ActivityOutput[] = [];
  const activity = new RunActivity({
    emit: (event) => void events.push(event),
    now: () => new Date(0),
  });
  const lines = () =>
    events
      .filter((event): event is ActivityEvent => event.type === 'ActivityEvent')
      .map((event) => [event.agentRunId, event.missionId, event.parentMissionId, event.phase]);
  return { activity, lines };
};

describe('the activity of tasks (Orchestration 3.2, 4)', () => {
  it('says which task a segment belongs to, and its parent task', () => {
    const { activity, lines } = setup();
    activity.registered('agr_a', 'worker api', 'agr_m', {
      missionId: 'msc_a',
      parentMissionId: 'msc_m',
    });
    activity.waitingForSubtasks('agr_a');
    expect(lines()).toEqual([['agr_a', 'msc_a', 'msc_m', 'WAITING_SUBTASKS']]);
  });

  it('keeps a sleeping task until it is closed, and a new segment takes it up', () => {
    const { activity, lines } = setup();
    activity.registered('agr_a1', 'lead api', undefined, { missionId: 'msc_a' });
    activity.sleeping('agr_a1');
    activity.missionClosed('msc_a');
    expect(lines()).toEqual([
      ['agr_a1', 'msc_a', undefined, 'SLEEPING'],
      ['agr_a1', 'msc_a', undefined, 'ENDED'],
    ]);
    // Closed once is closed: nothing more is said of it.
    activity.missionClosed('msc_a');
    expect(lines()).toHaveLength(2);
  });

  it('forgets the sleeping line of a task that wakes, so closing it later says nothing twice', () => {
    const { activity, lines } = setup();
    activity.registered('agr_a1', 'lead api', undefined, { missionId: 'msc_a' });
    activity.sleeping('agr_a1');
    activity.registered('agr_a2', 'lead api', undefined, { missionId: 'msc_a' });
    activity.ended('agr_a2');
    activity.missionClosed('msc_a');
    expect(lines()).toEqual([
      ['agr_a1', 'msc_a', undefined, 'SLEEPING'],
      ['agr_a2', 'msc_a', undefined, 'ENDED'],
    ]);
  });

  it('ends a segment without a task as before', () => {
    const { activity, lines } = setup();
    activity.registered('agr_x', 'main');
    activity.sleeping('agr_x');
    expect(lines()).toEqual([['agr_x', undefined, undefined, 'ENDED']]);
  });
});

describe('the background commands of a task (Orchestration 6.1)', () => {
  let clock = 0;
  const setupJobs = () => {
    const events: ActivityOutput[] = [];
    const activity = new RunActivity({
      emit: (event) => void events.push(event),
      now: () => new Date(clock),
    });
    const jobs = () =>
      events
        .filter((event): event is BackgroundJobs => event.type === 'BackgroundJobs')
        .map(({ agentRunId, missionId, startedAt }) => [agentRunId, missionId, startedAt]);
    return { activity, jobs };
  };
  const spec = (agentRunId: string) =>
    ({
      agentRunId,
      unit: { executionKind: 'COMMAND' },
      display: { toolName: 'run_command', argsSummary: 'sh diff.sh' },
    }) as unknown as AttemptSpec;
  const report = (agentRunId: string, unitAttemptId: string, job?: object) =>
    ({
      status: 'OK',
      agentRunId,
      unitAttemptId,
      executionKind: 'COMMAND',
      output: { exitCode: null, ...(job === undefined ? {} : { job }) },
    }) as unknown as UnitReport;

  it('counts a command moved to the background from when it started, until it ends', () => {
    const { activity, jobs } = setupJobs();
    activity.registered('agr_g', 'worker grep', 'agr_m', { missionId: 'msc_g' });
    clock = 1000;
    activity.running(spec('agr_g'), 'una_1', false);
    clock = 600_000;
    activity.reported(spec('agr_g'), report('agr_g', 'una_1', { jobKey: 'exe_1', promoted: true }));
    clock = 700_000;
    activity.running(spec('agr_g'), 'una_2', false);
    activity.reported(
      spec('agr_g'),
      report('agr_g', 'una_2', { jobKey: 'exe_2', promoted: false }),
    );
    activity.jobEnded('exe_1');
    activity.jobEnded('exe_2');
    activity.jobEnded('exe_2');
    expect(jobs()).toEqual([
      ['agr_g', 'msc_g', [new Date(1000).toISOString()]],
      ['agr_g', 'msc_g', [new Date(1000).toISOString(), new Date(700_000).toISOString()]],
      ['agr_g', 'msc_g', [new Date(700_000).toISOString()]],
      ['agr_g', 'msc_g', []],
    ]);
  });

  it('says nothing of a command that ended in the foreground', () => {
    const { activity, jobs } = setupJobs();
    activity.registered('agr_x', 'main');
    activity.running(spec('agr_x'), 'una_1', false);
    activity.reported(spec('agr_x'), report('agr_x', 'una_1'));
    expect(jobs()).toEqual([]);
  });
});
