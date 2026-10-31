import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MonitorInvariantError } from './index.js';
import {
  RunLedgers,
  assertBudgetsConsistent,
  finalReserve,
  minShare,
  wrapUpMargin,
  type AgentBudget,
} from './run-ledgers.js';

const main: AgentBudget = {
  perCallInputLimit: 100,
  maxOutputTokens: 50,
  finalInputBudget: 40,
  finalMaxOutputTokens: 20,
};
const share = minShare(main);
const budget = { runTokenLimit: share * 3, turnTokenLimit: share * 2 };
const used = (tokens: number) =>
  ({ type: 'ACTUAL', usage: { inputTokens: tokens, outputTokens: 0 } }) as const;

function spend(ledgers: RunLedgers, tokens: number): void {
  const reserved = ledgers.reserve({ estimatedTokens: tokens, final: false });
  if (!reserved.ok) throw new Error(reserved.reasonCode);
  ledgers.settle(reserved.reservationId, used(tokens));
}

describe('derived values', () => {
  it('follows Kernel/Monitor 3.3', () => {
    expect(finalReserve(main)).toBe(60);
    expect(wrapUpMargin(main)).toBe(150);
    expect(share).toBe(360);
  });
});

describe('startup checks', () => {
  it.each([
    ['a Turn below minShare', { runTokenLimit: 1000, turnTokenLimit: share - 1 }],
    ['a run below its Turn', { runTokenLimit: share, turnTokenLimit: share + 1 }],
    ['a zero limit', { runTokenLimit: 0, turnTokenLimit: share }],
  ])('refuses %s', (_name, limits) => {
    expect(() => {
      assertBudgetsConsistent(limits, main);
    }).toThrow(MonitorInvariantError);
  });
});

describe('Turn ledgers', () => {
  it('grants a share and takes the rest back', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openTurnLedger('t1');
    spend(ledgers, 100);
    expect(ledgers.closeTurnLedger('t1')).toEqual({
      inputTokens: 100,
      outputTokens: 0,
      unknownTokens: 0,
      modelRequests: 1,
      toolUnits: 0,
    });
    ledgers.openTurnLedger('t2');
    spend(ledgers, budget.turnTokenLimit - finalReserve(main) - 1);
  });

  it('counts an unsettled reservation as unknown', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openTurnLedger('t1');
    ledgers.reserve({ estimatedTokens: 70, final: false });
    expect(ledgers.closeTurnLedger('t1')).toMatchObject({ unknownTokens: 70 });
  });

  it('opens a share too small to work with, in WRAP_UP', () => {
    const ledgers = new RunLedgers({ runTokenLimit: share * 2, turnTokenLimit: share * 2 }, main);
    ledgers.openTurnLedger('t1');
    spend(ledgers, share * 2 - finalReserve(main) - 10);
    ledgers.closeTurnLedger('t1');
    expect(ledgers.openTurnLedger('t2').state).toBe('WRAP_UP');
    expect(ledgers.budgetView().turn).toBe('WRAP_UP');
  });

  it('allows one open Turn at a time', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openTurnLedger('t1');
    expect(() => ledgers.openTurnLedger('t2')).toThrow('already open');
    expect(() => ledgers.closeTurnLedger('t2')).toThrow('Another Turn');
  });
});

describe('budgetView', () => {
  it('judges the run by what would remain if the Turn ended now', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openTurnLedger('t1');
    expect(ledgers.budgetView()).toEqual({ agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' });
    spend(ledgers, budget.turnTokenLimit - finalReserve(main) - 1);
    const view = ledgers.budgetView();
    expect(view.turn).not.toBe('NORMAL');
    expect(view.run).toBe('NORMAL');
    expect(view.agentRun).toBe(view.turn);
  });

  it('turns to WRAP_UP when the run could not fund another Turn', () => {
    const ledgers = new RunLedgers({ runTokenLimit: share * 2, turnTokenLimit: share * 2 }, main);
    ledgers.openTurnLedger('t1');
    spend(ledgers, share * 2 - share - 10);
    expect(ledgers.budgetView().run).toBe('NORMAL');
    spend(ledgers, 20);
    expect(ledgers.budgetView().run).toBe('WRAP_UP');
  });
});

describe('quotas', () => {
  it('refuses the Unit past the limit, per AgentRun', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openTurnLedger('t1');
    expect(ledgers.countToolUnit('a', 2)).toEqual({ ok: true });
    expect(ledgers.countToolUnit('a', 2)).toEqual({ ok: true });
    expect(ledgers.countToolUnit('a', 2)).toEqual({ ok: false, quota: 'TOOL_UNITS' });
    expect(ledgers.countToolUnit('b', 2)).toEqual({ ok: true });
    expect(ledgers.closeTurnLedger('t1').toolUnits).toBe(3);
  });

  it('refuses work once the wall clock ran out', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.wallClockExceeded('a');
    expect(ledgers.countToolUnit('a', 10)).toEqual({ ok: false, quota: 'WALL_CLOCK' });
  });
});

describe('the final call always fits (invariant 6)', () => {
  it('holds after any sequence of ordinary spending', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(200), { maxLength: 40 }), (estimates) => {
        const ledgers = new RunLedgers(budget, main);
        ledgers.openTurnLedger('t1');
        for (const estimate of estimates) {
          const reserved = ledgers.reserve({ estimatedTokens: estimate, final: false });
          if (reserved.ok) ledgers.settle(reserved.reservationId, used(estimate));
        }
        const final = ledgers.reserve({ estimatedTokens: finalReserve(main), final: true });
        expect(final.ok).toBe(true);
      }),
    );
  });
});
