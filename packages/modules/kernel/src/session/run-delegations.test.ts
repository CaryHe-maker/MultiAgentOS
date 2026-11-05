import { describe, expect, it } from 'vitest';
import {
  RunDelegations,
  rootsOverlap,
  rootsWithin,
  type OccupancyHolder,
} from './run-delegations.js';

const tasks = [
  { name: 'a', roots: ['src/a'], tokens: 100 },
  { name: 'b', roots: ['src/b'], tokens: 100 },
];

describe('write roots', () => {
  it('overlap when one covers the other, and not when they only share a prefix of letters', () => {
    expect(rootsOverlap(['src'], ['src/a'])).toBe(true);
    expect(rootsOverlap(['src/a'], ['src'])).toBe(true);
    expect(rootsOverlap(['.'], ['docs'])).toBe(true);
    expect(rootsOverlap(['src/a'], ['src/ab'])).toBe(false);
    expect(rootsOverlap(['src/a'], ['src/b'])).toBe(false);
    expect(rootsOverlap([], ['src'])).toBe(false);
  });

  it('are within when every one lies under a root of the container', () => {
    expect(rootsWithin(['src/a', 'src/b'], ['src'])).toBe(true);
    expect(rootsWithin(['src/a', 'docs'], ['src'])).toBe(false);
    expect(rootsWithin(['src'], ['src/a'])).toBe(false);
  });
});

describe('a delegation', () => {
  it('lets each task be claimed once, by the AgentRun that delegated, and says why not', () => {
    const delegations = new RunDelegations();
    delegations.create('dlg_1', 'agr_main', tasks);
    expect(delegations.claim('dlg_1', 'agr_main', 'a', 'agr_a')).toMatchObject({ ok: true });
    expect(delegations.claim('dlg_1', 'agr_main', 'a', 'agr_x')).toEqual({
      ok: false,
      reason: 'TAKEN',
    });
    expect(delegations.claim('dlg_1', 'agr_other', 'b', 'agr_b')).toEqual({
      ok: false,
      reason: 'WRONG_PARENT',
    });
    expect(delegations.claim('dlg_1', 'agr_main', 'z', 'agr_z')).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
    expect(delegations.claim('dlg_9', 'agr_main', 'a', 'agr_a')).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });

  it('holds the parent delegated while a task may still register or runs (P6)', () => {
    const delegations = new RunDelegations();
    delegations.create('dlg_1', 'agr_main', tasks);
    expect(delegations.isDelegated('agr_main')).toBe(true);
    delegations.claim('dlg_1', 'agr_main', 'a', 'agr_a');
    delegations.claim('dlg_1', 'agr_main', 'b', 'agr_b');
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
    delegations.claim('dlg_1', 'agr_main', 'a', 'agr_a');
    delegations.childEnded('agr_a');
    // b has not registered and was not given up: the parent still waits for it.
    expect(delegations.isDelegated('agr_main')).toBe(true);
    expect(delegations.release('dlg_1')).toBe(true);
    expect(delegations.isDelegated('agr_main')).toBe(false);
    expect(delegations.release('dlg_1')).toBe(false);
    expect(delegations.claim('dlg_1', 'agr_main', 'b', 'agr_b')).toEqual({
      ok: false,
      reason: 'RELEASED',
    });
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
  ): OccupancyHolder => ({ agentRunId, parent: undefined, running: true, roots, ...over });

  it('is none for roots that are apart, and for an AgentRun that writes nothing', () => {
    const delegations = new RunDelegations();
    const holders = [holder('agr_a', ['src/a'])];
    expect(delegations.conflict(holders, { ancestors: [], roots: ['src/b'] })).toBeUndefined();
    expect(delegations.conflict(holders, { ancestors: [], roots: [] })).toBeUndefined();
  });

  it('names the running AgentRun whose roots would be touched', () => {
    const delegations = new RunDelegations();
    const holders = [holder('agr_a', ['src/a']), holder('agr_b', ['docs'])];
    expect(delegations.conflict(holders, { ancestors: [], roots: ['src'] })).toBe('agr_a');
    expect(delegations.conflict(holders, { ancestors: [], roots: ['docs/x'] })).toBe('agr_b');
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
    expect(
      delegations.conflict(holders, { ancestors: ['agr_main'], roots: ['src/a'] }),
    ).toBeUndefined();
    // A delegated parent is not in the way of anyone else either.
    expect(delegations.conflict(holders, { ancestors: [], roots: ['src/a'] })).toBeUndefined();
  });
});

describe('ancestors', () => {
  it('walks up through the parents, nearest first, and stops at a cycle', () => {
    const delegations = new RunDelegations();
    const parents = new Map([
      ['agr_g', 'agr_a'],
      ['agr_a', 'agr_main'],
    ]);
    expect(delegations.ancestorsOf('agr_a', (id) => parents.get(id))).toEqual([
      'agr_a',
      'agr_main',
    ]);
    const loop = new Map([
      ['agr_x', 'agr_y'],
      ['agr_y', 'agr_x'],
    ]);
    expect(delegations.ancestorsOf('agr_x', (id) => loop.get(id))).toEqual(['agr_x', 'agr_y']);
    expect(delegations.ancestorsOf(undefined, () => undefined)).toEqual([]);
  });
});
