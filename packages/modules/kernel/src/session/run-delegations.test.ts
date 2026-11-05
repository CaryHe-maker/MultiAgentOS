import { describe, expect, it } from 'vitest';
import { RunDelegations, type OccupancyHolder } from './run-delegations.js';

const tasks = [
  { name: 'a', roots: ['src/a'], tokens: 100 },
  { name: 'b', roots: ['src/b'], tokens: 100 },
];

describe('a delegation', () => {
  it('offers a task to the parent that delegated it, once', () => {
    const delegations = new RunDelegations();
    delegations.create('dlg_1', 'agr_main', tasks);
    expect(delegations.openTask('dlg_1', 'agr_main', 'a')?.roots).toEqual(['src/a']);
    expect(delegations.openTask('dlg_1', 'agr_other', 'a')).toBeUndefined();
    expect(delegations.openTask('dlg_1', 'agr_main', 'z')).toBeUndefined();
    expect(delegations.openTask('dlg_9', 'agr_main', 'a')).toBeUndefined();
    delegations.claim('dlg_1', 'a', 'agr_a');
    expect(delegations.openTask('dlg_1', 'agr_main', 'a')).toBeUndefined();
    expect(delegations.openTask('dlg_1', 'agr_main', 'b')).toBeDefined();
  });

  it('holds the parent delegated while a task may still register or runs (P6)', () => {
    const delegations = new RunDelegations();
    delegations.create('dlg_1', 'agr_main', tasks);
    expect(delegations.isDelegated('agr_main')).toBe(true);
    delegations.claim('dlg_1', 'a', 'agr_a');
    delegations.claim('dlg_1', 'b', 'agr_b');
    // Both registered: it lasts as long as one of them runs.
    expect(delegations.isDelegated('agr_main')).toBe(true);
    delegations.childEnded('agr_a');
    expect(delegations.isDelegated('agr_main')).toBe(true);
    delegations.childEnded('agr_b');
    expect(delegations.isDelegated('agr_main')).toBe(false);
  });

  it('is over when the tasks that never registered are given up and the others have ended', () => {
    const delegations = new RunDelegations();
    delegations.create('dlg_1', 'agr_main', tasks);
    delegations.claim('dlg_1', 'a', 'agr_a');
    delegations.childEnded('agr_a');
    // b has not registered and was not given up: the parent still waits for it.
    expect(delegations.isDelegated('agr_main')).toBe(true);
    expect(delegations.release('dlg_1')).toBe(true);
    expect(delegations.isDelegated('agr_main')).toBe(false);
    expect(delegations.release('dlg_1')).toBe(false);
    expect(delegations.openTask('dlg_1', 'agr_main', 'b')).toBeUndefined();
  });

  it('only delegates the parent that asked, and a second delegation keeps it delegated', () => {
    const delegations = new RunDelegations();
    delegations.create('dlg_1', 'agr_main', tasks);
    delegations.create('dlg_2', 'agr_main', [{ name: 'c', roots: ['src/c'], tokens: 1 }]);
    expect(delegations.isDelegated('agr_a')).toBe(false);
    delegations.release('dlg_1');
    expect(delegations.isDelegated('agr_main')).toBe(true);
    delegations.release('dlg_2');
    expect(delegations.isDelegated('agr_main')).toBe(false);
  });
});

describe('the conflict of write roots (P5)', () => {
  const holder = (
    agentRunId: string,
    roots: string[],
    over: Partial<OccupancyHolder> = {},
  ): OccupancyHolder => ({ agentRunId, running: true, roots, ...over });

  it('is none for roots that are apart, and for an AgentRun that writes nothing', () => {
    const delegations = new RunDelegations();
    const holders = [holder('agr_a', ['src/a'])];
    expect(delegations.conflict(holders, undefined, ['src/b'])).toBeUndefined();
    expect(delegations.conflict(holders, undefined, [])).toBeUndefined();
    // Roots that share only the letters of a prefix are apart.
    expect(delegations.conflict(holders, undefined, ['src/ab'])).toBeUndefined();
  });

  it('names the running AgentRun whose roots would be touched, either way round', () => {
    const delegations = new RunDelegations();
    const holders = [holder('agr_a', ['src/a']), holder('agr_b', ['docs'])];
    expect(delegations.conflict(holders, undefined, ['src'])).toBe('agr_a');
    expect(delegations.conflict(holders, undefined, ['docs/x'])).toBe('agr_b');
    expect(delegations.conflict(holders, undefined, ['.'])).toBe('agr_a');
  });

  it('does not count an ancestor, one that has ended, or a parent that delegated away', () => {
    const delegations = new RunDelegations();
    delegations.create('dlg_1', 'agr_main', tasks);
    const holders = [
      holder('agr_main', ['.']),
      holder('agr_done', ['src/a'], { running: false }),
      holder('agr_lead', ['src/c']),
    ];
    // The ancestor holds everything, but its roots are the child's.
    expect(delegations.conflict(holders, 'agr_main', ['src/a'])).toBeUndefined();
    // A delegated parent is not in the way of anyone else either.
    expect(delegations.conflict(holders, undefined, ['src/a'])).toBeUndefined();
  });

  it('knows the ancestors of a SubAgent that is itself a parent', () => {
    const delegations = new RunDelegations();
    delegations.create('dlg_1', 'agr_main', [{ name: 'a', roots: ['src'], tokens: 1 }]);
    delegations.claim('dlg_1', 'a', 'agr_a');
    const holders = [holder('agr_main', ['.']), holder('agr_a', ['src'])];
    // A child of agr_a may use what agr_a and agr_main hold, because they are above it.
    expect(delegations.conflict(holders, 'agr_a', ['src/x'])).toBeUndefined();
    // A stranger meets agr_a, which holds src; agr_main delegated its roots away.
    expect(delegations.conflict(holders, undefined, ['src/y'])).toBe('agr_a');
    expect(delegations.conflict(holders, undefined, ['docs'])).toBeUndefined();
  });
});
