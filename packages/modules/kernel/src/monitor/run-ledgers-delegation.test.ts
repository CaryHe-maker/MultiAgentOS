import { describe, expect, it } from 'vitest';
import { MonitorInvariantError } from './index.js';
import {
  RunLedgers,
  finalReserve,
  minShare,
  wrapUpMargin,
  type AgentBudget,
} from './run-ledgers.js';

/** Delegation to SubAgents (M2Design 7.3; Kernel/Monitor 3.2). */
const main: AgentBudget = {
  perCallInputLimit: 100,
  maxOutputTokens: 50,
  finalInputBudget: 40,
  finalMaxOutputTokens: 20,
};
const child: AgentBudget = {
  perCallInputLimit: 40,
  maxOutputTokens: 20,
  finalInputBudget: 30,
  finalMaxOutputTokens: 10,
};
const mainShare = minShare(main);
const childShare = minShare(child) * 2;
const used = (tokens: number) =>
  ({ type: 'ACTUAL', usage: { inputTokens: tokens, outputTokens: 0 } }) as const;

/** A run with a Turn that has plenty to lend. */
function open(): RunLedgers {
  const ledgers = new RunLedgers(
    { runTokenLimit: mainShare * 40, inputTokenLimit: mainShare * 20 },
    main,
  );
  ledgers.openInputLedger('trn_1');
  return ledgers;
}

const delegate = (
  ledgers: RunLedgers,
  names: readonly string[],
  tokens = childShare,
  delegationId = 'dlg_1',
  parentAgentRunId = 'agr_main',
) =>
  ledgers.reserveDelegation({
    delegationId,
    parentAgentRunId,
    shares: names.map((name) => ({ name, tokens })),
  });

const register = (
  ledgers: RunLedgers,
  name: string,
  agentRunId = `agr_${name}`,
  delegationId = 'dlg_1',
) => ledgers.registerAgentRun({ agentRunId, delegationId, taskName: name, agent: child });

function spendOn(ledgers: RunLedgers, agentRunId: string, tokens: number): void {
  const reserved = ledgers.reserve({ estimatedTokens: tokens, final: false }, agentRunId);
  if (!reserved.ok) throw new Error(reserved.reasonCode);
  ledgers.settle(reserved.reservationId, used(tokens));
}

describe('delegation to SubAgents', () => {
  it('keeps a third of what it opened with when it lends, and at least two ordinary calls', () => {
    const ledgers = open();
    const limit = mainShare * 20;
    const before = ledgers.delegable('agr_main');
    expect(before).toBe(
      limit - Math.max(Math.ceil(limit / 3), finalReserve(main) + 2 * wrapUpMargin(main)),
    );
    expect(delegate(ledgers, ['a', 'b'])).toEqual({ ok: true });
    expect(ledgers.delegable('agr_main')).toBe(before - 2 * childShare);
    // The parent can go on and wrap up afterwards: its own state is untouched.
    expect(ledgers.budgetView('agr_main').agentRun).toBe('NORMAL');
  });

  it('leaves the lender a whole call above its WRAP_UP line after it lent all it could', () => {
    // Before, what could be lent ended exactly on the line of WRAP_UP: the next token the lender
    // spent wrapped it up, and every task with it (the findex run of 2026-11-14).
    const ledgers = open();
    const all = ledgers.delegable('agr_main');
    expect(
      ledgers.reserveDelegation({
        delegationId: 'dlg_1',
        parentAgentRunId: 'agr_main',
        shares: [{ name: 'a', tokens: all }],
      }),
    ).toEqual({ ok: true });
    ledgers.registerAgentRun({
      agentRunId: 'agr_a',
      delegationId: 'dlg_1',
      taskName: 'a',
      agent: child,
    });
    spendOn(ledgers, 'agr_main', wrapUpMargin(main));
    expect(ledgers.budgetView('agr_main')).toEqual({
      agentRun: 'NORMAL',
      input: 'NORMAL',
      run: 'NORMAL',
    });
    expect(ledgers.budgetView('agr_a')).toEqual({
      agentRun: 'NORMAL',
      input: 'NORMAL',
      run: 'NORMAL',
    });
  });

  it('is back in NORMAL when what it lent comes back', () => {
    const ledgers = new RunLedgers({ runTokenLimit: mainShare, inputTokenLimit: mainShare }, main);
    ledgers.openInputLedger('trn_1');
    // A ledger that is low: it spends down to its line.
    spendOn(ledgers, 'agr_main', wrapUpMargin(main));
    spendOn(ledgers, 'agr_main', 1);
    expect(ledgers.budgetView('agr_main').agentRun).toBe('WRAP_UP');
    const plenty = open();
    const all = plenty.delegable('agr_main');
    plenty.reserveDelegation({
      delegationId: 'dlg_1',
      parentAgentRunId: 'agr_main',
      shares: [{ name: 'a', tokens: all }],
    });
    plenty.registerAgentRun({
      agentRunId: 'agr_a',
      delegationId: 'dlg_1',
      taskName: 'a',
      agent: child,
    });
    // The lender spends until it is low while its task holds the rest ...
    while (plenty.budgetView('agr_main').agentRun === 'NORMAL')
      spendOn(plenty, 'agr_main', wrapUpMargin(main));
    expect(plenty.budgetView('agr_main').agentRun).toBe('WRAP_UP');
    // ... and the task ends having used almost nothing: the lender has tokens again.
    plenty.endAgentRun('agr_a');
    expect(plenty.budgetView('agr_main').agentRun).toBe('NORMAL');
  });

  it('counts what the tasks hold unspent as part of what the run has left', () => {
    const ledgers = new RunLedgers(
      { runTokenLimit: mainShare * 20, inputTokenLimit: mainShare * 20 },
      main,
    );
    ledgers.openInputLedger('trn_1');
    const all = ledgers.delegable('agr_main');
    ledgers.reserveDelegation({
      delegationId: 'dlg_1',
      parentAgentRunId: 'agr_main',
      shares: [{ name: 'a', tokens: all }],
    });
    ledgers.registerAgentRun({
      agentRunId: 'agr_a',
      delegationId: 'dlg_1',
      taskName: 'a',
      agent: child,
    });
    // The run has nothing outside this input and the root keeps only a third: the run is not
    // short for that, the rest is with the task.
    expect(ledgers.budgetView('agr_a').run).toBe('NORMAL');
  });

  it('refuses all of it when the shares are more than can be lent, and tells the balance (B2)', () => {
    const ledgers = open();
    const delegable = ledgers.delegable('agr_main');
    const result = ledgers.reserveDelegation({
      delegationId: 'dlg_1',
      parentAgentRunId: 'agr_main',
      shares: [
        { name: 'a', tokens: delegable },
        { name: 'b', tokens: 1 },
      ],
    });
    expect(result).toEqual({ ok: false, reasonCode: 'BUDGET_INSUFFICIENT', delegable });
    // All or none: nothing was taken out.
    expect(ledgers.delegable('agr_main')).toBe(delegable);
  });

  it('gives every SubAgent a ledger of its own: one that spends does not push another into WRAP_UP (B1)', () => {
    const ledgers = open();
    delegate(ledgers, ['a', 'b', 'c']);
    for (const name of ['a', 'b', 'c']) register(ledgers, name);
    // a has a call in flight, b spends nearly all it may; c is untouched.
    expect(ledgers.reserve({ estimatedTokens: 10, final: false }, 'agr_a').ok).toBe(true);
    spendOn(ledgers, 'agr_b', childShare - finalReserve(child) - wrapUpMargin(child) - 1);
    expect(ledgers.budgetView('agr_c').agentRun).toBe('NORMAL');
    expect(ledgers.budgetView('agr_a').agentRun).toBe('NORMAL');
    expect(ledgers.budgetView('agr_main').agentRun).toBe('NORMAL');
  });

  it('refuses a call past a SubAgent share without touching the others', () => {
    const ledgers = open();
    delegate(ledgers, ['a', 'b']);
    register(ledgers, 'a');
    register(ledgers, 'b');
    const refused = ledgers.reserve({ estimatedTokens: childShare, final: false }, 'agr_a');
    expect(refused).toMatchObject({ ok: false, reasonCode: 'BUDGET_WRAP_UP' });
    expect(ledgers.reserve({ estimatedTokens: 10, final: false }, 'agr_b').ok).toBe(true);
  });

  it('opens a SubAgent whose share is below its minimum in WRAP_UP', () => {
    const ledgers = open();
    delegate(ledgers, ['a'], minShare(child) - 1);
    expect(register(ledgers, 'a').state).toBe('WRAP_UP');
    expect(ledgers.budgetView('agr_a').agentRun).toBe('WRAP_UP');
  });

  it('gives back what a SubAgent did not use when it ends, and keeps what it used (B3)', () => {
    const ledgers = open();
    delegate(ledgers, ['a']);
    register(ledgers, 'a');
    const before = ledgers.delegable('agr_main');
    spendOn(ledgers, 'agr_a', 25);
    ledgers.endAgentRun('agr_a');
    expect(ledgers.delegable('agr_main')).toBe(before + childShare - 25);
    // Ending it again changes nothing.
    ledgers.endAgentRun('agr_a');
    expect(ledgers.delegable('agr_main')).toBe(before + childShare - 25);
  });

  it('does not give back what it could not settle: that counts as unknown', () => {
    const ledgers = open();
    delegate(ledgers, ['a']);
    register(ledgers, 'a');
    const before = ledgers.delegable('agr_main');
    expect(ledgers.reserve({ estimatedTokens: 30, final: false }, 'agr_a').ok).toBe(true);
    ledgers.endAgentRun('agr_a');
    expect(ledgers.delegable('agr_main')).toBe(before + childShare - 30);
  });

  it('takes back the shares of tasks that never registered', () => {
    const ledgers = open();
    const before = ledgers.delegable('agr_main');
    delegate(ledgers, ['a', 'b', 'c']);
    register(ledgers, 'a');
    expect(ledgers.releaseDelegation('dlg_1')).toBe(2 * childShare);
    expect(ledgers.delegable('agr_main')).toBe(before - childShare);
    // The claimed share comes back with its AgentRun, once.
    ledgers.endAgentRun('agr_a');
    expect(ledgers.delegable('agr_main')).toBe(before);
    expect(ledgers.releaseDelegation('dlg_1')).toBe(0);
  });

  it('refuses a share that is not in the delegation, or that is taken twice', () => {
    const ledgers = open();
    delegate(ledgers, ['a']);
    expect(() => register(ledgers, 'x')).toThrow(MonitorInvariantError);
    register(ledgers, 'a');
    expect(() => register(ledgers, 'a', 'agr_again')).toThrow(MonitorInvariantError);
  });

  it('refuses a second delegation under the same id', () => {
    const ledgers = open();
    delegate(ledgers, ['a']);
    expect(() => delegate(ledgers, ['b'])).toThrow(MonitorInvariantError);
  });

  it('lets a SubAgent delegate in turn, from its own ledger', () => {
    const ledgers = open();
    delegate(ledgers, ['a'], childShare * 6);
    register(ledgers, 'a');
    const before = ledgers.delegable('agr_a');
    expect(delegate(ledgers, ['g'], minShare(child), 'dlg_2', 'agr_a')).toEqual({ ok: true });
    expect(ledgers.delegable('agr_a')).toBe(before - minShare(child));
    register(ledgers, 'g', 'agr_g', 'dlg_2');
    ledgers.endAgentRun('agr_g');
    expect(ledgers.delegable('agr_a')).toBe(before);
  });

  it('counts the SubAgents in the Turn and in the run when the Turn closes', () => {
    const ledgers = open();
    delegate(ledgers, ['a', 'b']);
    register(ledgers, 'a');
    register(ledgers, 'b');
    spendOn(ledgers, 'agr_main', 100);
    spendOn(ledgers, 'agr_a', 40);
    spendOn(ledgers, 'agr_b', 60);
    ledgers.endAgentRun('agr_a');
    // b is still open when the Turn ends.
    const usage = ledgers.closeInputLedger('trn_1');
    expect(usage.inputTokens).toBe(200);
    expect(ledgers.usage().used).toBe(200);
    // What none of them used went back to the run.
    expect(ledgers.usage().limit - ledgers.usage().used).toBe(mainShare * 40 - 200);
  });
});

describe('the ledger of a task that sleeps (Orchestration 8.3)', () => {
  it('closes the ledger of a sleeping task, and funds it again when a rewind opens it (7.5)', () => {
    const ledgers = open();
    const before = ledgers.delegable('agr_main');
    delegate(ledgers, ['a']);
    ledgers.registerAgentRun({
      agentRunId: 'agr_a1',
      delegationId: 'dlg_1',
      taskName: 'a',
      agent: child,
      ledgerKey: 'msc_a00000',
    });
    spendOn(ledgers, 'agr_a1', 10);
    ledgers.endAgentRun('agr_a1', true);
    // Stopped while it sleeps: what it did not use goes back at once.
    ledgers.closeTask('msc_a00000');
    expect(ledgers.delegable('agr_main')).toBe(before - 10);
    // A rewind opens it again: its share comes from the parent again, what it spent stays spent.
    ledgers.restoreTask({
      key: 'msc_a00000',
      parentKey: undefined,
      tokens: childShare,
      agent: child,
    });
    expect(ledgers.delegable('agr_main')).toBe(before - 10 - childShare);
    ledgers.attachAgentRun('agr_a2', 'msc_a00000');
    expect(ledgers.budgetView('agr_a2').agentRun).toBe('NORMAL');
    ledgers.endAgentRun('agr_a2');
    expect(ledgers.delegable('agr_main')).toBe(before - 10);
  });

  it('keeps the share of a task across its segments and gives back the rest when it ends', () => {
    const ledgers = open();
    const before = ledgers.delegable('agr_main');
    delegate(ledgers, ['a']);
    ledgers.registerAgentRun({
      agentRunId: 'agr_a1',
      delegationId: 'dlg_1',
      taskName: 'a',
      agent: child,
      ledgerKey: 'msc_a00000',
    });
    spendOn(ledgers, 'agr_a1', 10);
    // The first segment goes to sleep: nothing goes back to the parent yet.
    ledgers.endAgentRun('agr_a1', true);
    expect(ledgers.delegable('agr_main')).toBe(before - childShare);
    // The next segment spends from the same share.
    ledgers.attachAgentRun('agr_a2', 'msc_a00000');
    spendOn(ledgers, 'agr_a2', 15);
    expect(ledgers.budgetView('agr_a2').agentRun).toBe('NORMAL');
    // The task ends: what it did not use goes back; what both segments used stays spent.
    ledgers.endAgentRun('agr_a2');
    expect(ledgers.delegable('agr_main')).toBe(before - 25);
  });

  it('pays the loan of a task that slept back to its parent task, not to the Turn', () => {
    const ledgers = open();
    delegate(ledgers, ['lead']);
    ledgers.registerAgentRun({
      agentRunId: 'agr_lead1',
      delegationId: 'dlg_1',
      taskName: 'lead',
      agent: child,
      ledgerKey: 'msc_lead00',
    });
    const leadBefore = ledgers.delegable('agr_lead1');
    expect(
      ledgers.reserveDelegation({
        delegationId: 'dlg_2',
        parentAgentRunId: 'agr_lead1',
        shares: [{ name: 'w', tokens: minShare(child) }],
      }),
    ).toEqual({ ok: true });
    // The lead's segment sleeps; its worker registers and ends after it.
    ledgers.endAgentRun('agr_lead1', true);
    ledgers.registerAgentRun({
      agentRunId: 'agr_w',
      delegationId: 'dlg_2',
      taskName: 'w',
      agent: child,
      ledgerKey: 'msc_w00000',
    });
    ledgers.endAgentRun('agr_w');
    ledgers.attachAgentRun('agr_lead2', 'msc_lead00');
    expect(ledgers.delegable('agr_lead2')).toBe(leadBefore);
  });

  describe('topping a task up from the ledger above (M2Design 7.3, rule 5)', () => {
    const least = minShare(child);
    const line = finalReserve(child) + wrapUpMargin(child);
    const start = (ceiling: number, parentAgentRunId = 'agr_main', delegationId = 'dlg_1') => {
      const ledgers = open();
      ledgers.reserveDelegation({
        delegationId,
        parentAgentRunId,
        shares: [{ name: 'a', tokens: least, ceiling }],
      });
      register(ledgers, 'a', 'agr_a', delegationId);
      return ledgers;
    };

    it('gives a task more before a call would bring it to its line, and the task stays NORMAL', () => {
      const ledgers = start(4 * least);
      const before = ledgers.delegable('agr_main');
      // More than the share it opened with allows above its line.
      for (let call = 0; call < 6; call += 1) spendOn(ledgers, 'agr_a', wrapUpMargin(child));
      expect(ledgers.budgetView('agr_a')).toEqual({
        agentRun: 'NORMAL',
        input: 'NORMAL',
        run: 'NORMAL',
      });
      // It came out of the parent, in pieces of what the task opened with.
      const taken = before - ledgers.delegable('agr_main');
      expect(taken).toBeGreaterThan(0);
      expect(taken % least).toBe(0);
    });

    it('stops at the ceiling: a task that goes on and on is wrapped up in the end', () => {
      const ledgers = start(2 * least);
      let calls = 0;
      while (ledgers.budgetView('agr_a').agentRun === 'NORMAL' && calls < 100) {
        const reserved = ledgers.reserve(
          { estimatedTokens: wrapUpMargin(child), final: false },
          'agr_a',
        );
        if (!reserved.ok) break;
        ledgers.settle(reserved.reservationId, used(wrapUpMargin(child)));
        calls += 1;
      }
      expect(calls).toBeLessThan(100);
      // It was given its ceiling and no more.
      ledgers.endAgentRun('agr_a');
      const spent = calls * wrapUpMargin(child);
      expect(spent).toBeLessThanOrEqual(2 * least - line + wrapUpMargin(child));
      expect(spent).toBeGreaterThan(least - line);
    });

    it('tops a task up when a call cost more than was estimated', () => {
      const ledgers = start(4 * least);
      const reserved = ledgers.reserve({ estimatedTokens: 1, final: false }, 'agr_a');
      if (!reserved.ok) throw new Error(reserved.reasonCode);
      const settled = ledgers.settle(reserved.reservationId, used(least - line + 5));
      expect(settled.budgetState).toBe('NORMAL');
      expect(ledgers.budgetView('agr_a').agentRun).toBe('NORMAL');
    });

    it('lets a task with nothing to lend start tasks of its own: the ledgers above pay', () => {
      // A lead opens with the least it can work with, all of which it keeps for itself.
      const ledgers = start(4 * least);
      expect(ledgers.delegable('agr_a')).toBe(0);
      const before = ledgers.delegable('agr_main');
      expect(
        ledgers.reserveDelegation({
          delegationId: 'dlg_2',
          parentAgentRunId: 'agr_a',
          shares: [
            { name: 'x', tokens: least },
            { name: 'y', tokens: least },
          ],
        }),
      ).toEqual({ ok: true });
      expect(ledgers.delegable('agr_main')).toBe(before - 2 * least);
      // What it took to lend on does not count against what it may spend itself.
      for (let call = 0; call < 6; call += 1) spendOn(ledgers, 'agr_a', wrapUpMargin(child));
      expect(ledgers.budgetView('agr_a').agentRun).toBe('NORMAL');
    });

    it('covers what a lender already spent of what it keeps, when it lends on', () => {
      // A lead that opened with the least and made a call: it has less than it keeps, and the
      // ledgers above bring both that and the shares it lends (three levels, 2026-11-14).
      const ledgers = start(4 * least);
      spendOn(ledgers, 'agr_a', 7);
      expect(
        ledgers.reserveDelegation({
          delegationId: 'dlg_2',
          parentAgentRunId: 'agr_a',
          shares: [{ name: 'x', tokens: least }],
        }),
      ).toEqual({ ok: true });
      expect(ledgers.budgetView('agr_a').agentRun).toBe('NORMAL');
    });

    it('wraps the task up as before when the ledgers above have nothing left to lend', () => {
      const ledgers = new RunLedgers(
        { runTokenLimit: mainShare * 2, inputTokenLimit: mainShare * 2 },
        main,
      );
      ledgers.openInputLedger('trn_1');
      const all = ledgers.delegable('agr_main');
      // Everything that can be lent goes to one task, with a ceiling it will never reach.
      ledgers.reserveDelegation({
        delegationId: 'dlg_1',
        parentAgentRunId: 'agr_main',
        shares: [{ name: 'a', tokens: all, ceiling: all * 10 }],
      });
      register(ledgers, 'a');
      let calls = 0;
      while (ledgers.budgetView('agr_a').agentRun === 'NORMAL' && calls < 1000) {
        const reserved = ledgers.reserve(
          { estimatedTokens: wrapUpMargin(child), final: false },
          'agr_a',
        );
        if (!reserved.ok) break;
        ledgers.settle(reserved.reservationId, used(wrapUpMargin(child)));
        calls += 1;
      }
      expect(calls).toBeLessThan(1000);
      // The lender kept its own: it is not wrapped up by the task's hunger.
      expect(ledgers.budgetView('agr_main').agentRun).toBe('NORMAL');
    });
  });

  describe('more for the work of an input, out of what the run has left (rule 6)', () => {
    const low = () => {
      const ledgers = new RunLedgers(
        { runTokenLimit: mainShare * 4, inputTokenLimit: mainShare },
        main,
      );
      ledgers.openInputLedger('trn_1');
      return ledgers;
    };

    it('wants more when the root is within one call of its line, and not before', () => {
      const ledgers = low();
      expect(ledgers.inputWants('agr_main')).toBeUndefined();
      spendOn(ledgers, 'agr_main', 1);
      expect(ledgers.inputWants('agr_main')).toEqual({
        used: 1,
        limit: mainShare,
        add: Math.ceil(mainShare / 2),
      });
    });

    it('adds to the input out of the run, and the root is not wrapped up', () => {
      const ledgers = low();
      spendOn(ledgers, 'agr_main', wrapUpMargin(main));
      spendOn(ledgers, 'agr_main', 1);
      expect(ledgers.budgetView('agr_main').agentRun).toBe('WRAP_UP');
      const wants = ledgers.inputWants('agr_main');
      expect(ledgers.extendInput(wants?.add ?? 0)).toBe(Math.ceil(mainShare / 2));
      expect(ledgers.budgetView('agr_main').agentRun).toBe('NORMAL');
      // What is not used goes back to the run when the input closes.
      const usage = ledgers.closeInputLedger('trn_1');
      expect(usage.inputTokens).toBe(wrapUpMargin(main) + 1);
      expect(ledgers.openInputLedger('trn_2').state).toBe('NORMAL');
    });

    it('wants nothing when the run has nothing left to add', () => {
      const ledgers = new RunLedgers(
        { runTokenLimit: mainShare, inputTokenLimit: mainShare },
        main,
      );
      ledgers.openInputLedger('trn_1');
      spendOn(ledgers, 'agr_main', 1);
      expect(ledgers.inputWants('agr_main')).toBeUndefined();
      expect(ledgers.extendInput(100)).toBe(0);
    });

    it('wants more for a task whose top-up fell short because the input had no more to lend', () => {
      const ledgers = new RunLedgers(
        { runTokenLimit: mainShare * 8, inputTokenLimit: mainShare * 2 },
        main,
      );
      ledgers.openInputLedger('trn_1');
      const all = ledgers.delegable('agr_main');
      ledgers.reserveDelegation({
        delegationId: 'dlg_1',
        parentAgentRunId: 'agr_main',
        shares: [{ name: 'a', tokens: all, ceiling: all * 10 }],
      });
      register(ledgers, 'a');
      expect(ledgers.inputWants('agr_a')).toBeUndefined();
      let calls = 0;
      while (ledgers.inputWants('agr_a') === undefined && calls < 1000) {
        spendOn(ledgers, 'agr_a', wrapUpMargin(child));
        calls += 1;
      }
      expect(calls).toBeLessThan(1000);
      // With more in the input's ledger the task is topped up again and goes on.
      ledgers.extendInput(ledgers.inputWants('agr_a')?.add ?? 0);
      expect(ledgers.inputWants('agr_a')).toBeUndefined();
      for (let call = 0; call < 4; call += 1) spendOn(ledgers, 'agr_a', wrapUpMargin(child));
      expect(ledgers.budgetView('agr_a').agentRun).toBe('NORMAL');
    });
  });
});
