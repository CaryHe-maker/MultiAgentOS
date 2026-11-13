import type { ActivityEvent } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { RunActivity, type ActivityOutput } from './run-activity.js';

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
