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
  it('can lend what is left less the final reserve and one ordinary call', () => {
    const ledgers = open();
    const before = ledgers.delegable('agr_main');
    expect(before).toBe(mainShare * 20 - finalReserve(main) - wrapUpMargin(main));
    expect(delegate(ledgers, ['a', 'b'])).toEqual({ ok: true });
    expect(ledgers.delegable('agr_main')).toBe(before - 2 * childShare);
    // The parent can go on and wrap up afterwards: its own state is untouched.
    expect(ledgers.budgetView('agr_main').agentRun).toBe('NORMAL');
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
});
