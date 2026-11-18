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
const budget = { runTokenLimit: share * 3, inputTokenLimit: share * 2 };
const used = (tokens: number) =>
  ({ type: 'ACTUAL', usage: { inputTokens: tokens, outputTokens: 0 } }) as const;

function spend(ledgers: RunLedgers, tokens: number): void {
  const reserved = ledgers.reserve({ estimatedTokens: tokens, final: false });
  if (!reserved.ok) throw new Error(reserved.reasonCode);
  ledgers.settle(reserved.reservationId, used(tokens));
}

describe('price of cached input', () => {
  it('reaches the settlement from the reservation', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openInputLedger('trn_1');
    const reserved = ledgers.reserve({ estimatedTokens: 100, final: false, cacheHitWeight: 0.02 });
    if (!reserved.ok) throw new Error(reserved.reasonCode);
    ledgers.settle(reserved.reservationId, {
      type: 'ACTUAL',
      usage: { inputTokens: 100, inputCacheHitTokens: 50, outputTokens: 10 },
    });
    // 50 uncached + 50 × 0.02 + 10 output, but the usage stays what the provider counted.
    expect(ledgers.closeInputLedger('trn_1')).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(ledgers.usage().used).toBe(61);
  });
});

describe('derived values', () => {
  it('follows Kernel/Monitor 3.3', () => {
    expect(finalReserve(main)).toBe(60);
    expect(wrapUpMargin(main)).toBe(150);
    expect(share).toBe(360);
  });
});

describe('startup checks', () => {
  it.each([
    ['a Turn below minShare', { runTokenLimit: 1000, inputTokenLimit: share - 1 }],
    ['a run below its Turn', { runTokenLimit: share, inputTokenLimit: share + 1 }],
    ['a zero limit', { runTokenLimit: 0, inputTokenLimit: share }],
  ])('refuses %s', (_name, limits) => {
    expect(() => {
      assertBudgetsConsistent(limits, main);
    }).toThrow(MonitorInvariantError);
  });
});

describe('Turn ledgers', () => {
  it('grants a share and takes the rest back', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openInputLedger('t1');
    spend(ledgers, 100);
    expect(ledgers.closeInputLedger('t1')).toEqual({
      inputTokens: 100,
      outputTokens: 0,
      unknownTokens: 0,
      modelRequests: 1,
      toolUnits: 0,
    });
    ledgers.openInputLedger('t2');
    spend(ledgers, budget.inputTokenLimit - finalReserve(main) - 1);
  });

  it('counts an unsettled reservation as unknown', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openInputLedger('t1');
    ledgers.reserve({ estimatedTokens: 70, final: false });
    expect(ledgers.closeInputLedger('t1')).toMatchObject({ unknownTokens: 70 });
  });

  it('opens a share too small to work with, in WRAP_UP', () => {
    const ledgers = new RunLedgers({ runTokenLimit: share * 2, inputTokenLimit: share * 2 }, main);
    ledgers.openInputLedger('t1');
    spend(ledgers, share * 2 - finalReserve(main) - 10);
    ledgers.closeInputLedger('t1');
    expect(ledgers.openInputLedger('t2').state).toBe('WRAP_UP');
    expect(ledgers.budgetView().input).toBe('WRAP_UP');
  });

  it('allows the work of one input at a time', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openInputLedger('t1');
    expect(() => ledgers.openInputLedger('t2')).toThrow('already open');
    expect(() => ledgers.closeInputLedger('t2')).toThrow('Another input');
  });
});

describe('budgetView', () => {
  it('judges the run by what would remain if the work of the input settled now', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openInputLedger('t1');
    expect(ledgers.budgetView()).toEqual({ agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' });
    spend(ledgers, budget.inputTokenLimit - finalReserve(main) - 1);
    const view = ledgers.budgetView();
    expect(view.input).not.toBe('NORMAL');
    expect(view.run).toBe('NORMAL');
    expect(view.agentRun).toBe(view.input);
  });

  it('turns to WRAP_UP when the run could not fund another Turn', () => {
    const ledgers = new RunLedgers({ runTokenLimit: share * 2, inputTokenLimit: share * 2 }, main);
    ledgers.openInputLedger('t1');
    spend(ledgers, share * 2 - share - 10);
    expect(ledgers.budgetView().run).toBe('NORMAL');
    spend(ledgers, 20);
    expect(ledgers.budgetView().run).toBe('WRAP_UP');
  });
});

describe('quotas', () => {
  it('refuses the Unit past the limit, per AgentRun', () => {
    const ledgers = new RunLedgers(budget, main);
    ledgers.openInputLedger('t1');
    expect(ledgers.countToolUnit('a', 2)).toEqual({ ok: true });
    expect(ledgers.countToolUnit('a', 2)).toEqual({ ok: true });
    expect(ledgers.countToolUnit('a', 2)).toEqual({ ok: false, quota: 'TOOL_UNITS' });
    expect(ledgers.countToolUnit('b', 2)).toEqual({ ok: true });
    expect(ledgers.closeInputLedger('t1').toolUnits).toBe(3);
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
        ledgers.openInputLedger('t1');
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

describe('the ledger of a compaction with no Turn open (Kernel/Monitor 3.4)', () => {
  it('takes its share from the run, pays for what was used, and gives back the rest', () => {
    const ledgers = new RunLedgers({ runTokenLimit: share * 10, inputTokenLimit: share * 2 }, main);
    const before = ledgers.usage();
    const ledger = ledgers.openCompactionLedger(300);
    if (!ledger.ok) throw new Error('refused');
    const reservation = ledger.reserve(1);
    expect(reservation).toBeDefined();
    if (reservation === undefined) return;
    ledger.settle(reservation, used(120));
    ledger.close();
    ledger.close();
    const after = ledgers.usage();
    expect(after.inputTokens - before.inputTokens).toBe(120);
    // Only what was used is gone: the Turn that follows gets its full share.
    ledgers.openInputLedger('trn_aaaaaaaa');
    expect(ledgers.budgetView().input).toBe('NORMAL');
  });

  it('is refused when the run would be left below the share of main', () => {
    const ledgers = new RunLedgers({ runTokenLimit: share * 2, inputTokenLimit: share * 2 }, main);
    expect(ledgers.openCompactionLedger(share)).toEqual({
      ok: false,
      reasonCode: 'BUDGET_INSUFFICIENT',
    });
  });

  it('can be open while a Turn is, and the two do not take from each other', () => {
    const ledgers = new RunLedgers({ runTokenLimit: share * 10, inputTokenLimit: share * 2 }, main);
    const ledger = ledgers.openCompactionLedger(200);
    if (!ledger.ok) throw new Error('refused');
    expect(ledgers.hasOpenInput()).toBe(false);
    ledgers.openInputLedger('trn_bbbbbbbb');
    expect(ledgers.hasOpenInput()).toBe(true);
    expect(ledger.reserve(1)).toBeDefined();
    ledger.close();
    expect(ledgers.closeInputLedger('trn_bbbbbbbb').modelRequests).toBe(0);
  });
});
