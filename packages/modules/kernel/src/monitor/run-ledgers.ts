import type { BudgetState, BudgetView, TurnUsage } from '@multiagentos/contracts';
import type { Settlement, SettlementResult } from '../interfaces/index.js';
import { Monitor, MonitorInvariantError } from './monitor.js';

/** The four budget parameters of an Agent definition (Kernel/Monitor 3.3). */
export interface AgentBudget {
  readonly perCallInputLimit: number;
  readonly maxOutputTokens: number;
  readonly finalInputBudget: number;
  readonly finalMaxOutputTokens: number;
}

export interface RunBudget {
  readonly runTokenLimit: number;
  readonly turnTokenLimit: number;
}

export const finalReserve = (agent: AgentBudget): number =>
  agent.finalInputBudget + agent.finalMaxOutputTokens;
export const wrapUpMargin = (agent: AgentBudget): number =>
  agent.perCallInputLimit + agent.maxOutputTokens;
export const minShare = (agent: AgentBudget): number =>
  finalReserve(agent) + 2 * wrapUpMargin(agent);

/** The startup checks that need no model or prompt (Kernel/Monitor 6). */
export function assertBudgetsConsistent(budget: RunBudget, main: AgentBudget): void {
  const values = [
    main.perCallInputLimit,
    main.maxOutputTokens,
    main.finalInputBudget,
    main.finalMaxOutputTokens,
    budget.runTokenLimit,
    budget.turnTokenLimit,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new MonitorInvariantError('Budget values must be positive safe integers');
  if (!Number.isSafeInteger(minShare(main)))
    throw new MonitorInvariantError('Budget values overflow');
  if (budget.turnTokenLimit < minShare(main))
    throw new MonitorInvariantError('turnTokenLimit is below minShare(main)');
  if (budget.runTokenLimit < budget.turnTokenLimit)
    throw new MonitorInvariantError('runTokenLimit is below turnTokenLimit');
}

interface TurnLedger {
  readonly turnId: string;
  readonly limit: number;
  readonly ledger: Monitor;
  modelRequests: number;
  toolUnits: number;
}

export type QuotaResult =
  { readonly ok: true } | { readonly ok: false; readonly quota: 'TOOL_UNITS' | 'WALL_CLOCK' };

/**
 * One run's token budget: the run grants each Turn a share and takes back what is left. A share
 * too small to work with still opens, in WRAP_UP, because budget never stops a run on its own:
 * Workflow wraps up and ends it (M2Design 7.3).
 */
export class RunLedgers {
  readonly #budget: RunBudget;
  readonly #main: AgentBudget;
  readonly #toolUnits = new Map<string, number>();
  readonly #overTime = new Set<string>();
  #remaining: number;
  #turn: TurnLedger | undefined;
  /** What the closed Turns used, for the RunSummary. */
  readonly #closed = { used: 0, unknown: 0, inputTokens: 0, outputTokens: 0 };

  public constructor(budget: RunBudget, main: AgentBudget) {
    assertBudgetsConsistent(budget, main);
    this.#budget = budget;
    this.#main = main;
    this.#remaining = budget.runTokenLimit;
  }

  openTurnLedger(turnId: string): { readonly state: BudgetState } {
    if (this.#turn !== undefined) throw new MonitorInvariantError('A Turn ledger is already open');
    const limit = Math.min(this.#budget.turnTokenLimit, this.#remaining);
    this.#remaining -= limit;
    const ledger = new Monitor({ ...this.#main, tokenLimit: limit }, { allowShortLimit: true });
    this.#turn = { turnId, limit, ledger, modelRequests: 0, toolUnits: 0 };
    return { state: limit < minShare(this.#main) ? 'WRAP_UP' : ledger.budgetState() };
  }

  #openTurn(): TurnLedger {
    if (this.#turn === undefined) throw new MonitorInvariantError('No Turn ledger is open');
    return this.#turn;
  }

  /** Unsettled reservations count as unknown, and what is left goes back to the run. */
  closeTurnLedger(turnId: string): TurnUsage {
    const turn = this.#openTurn();
    if (turn.turnId !== turnId) throw new MonitorInvariantError('Another Turn ledger is open');
    const summary = turn.ledger.finalize();
    this.#remaining += turn.limit - summary.used - summary.unknown;
    this.#closed.used += summary.used;
    this.#closed.unknown += summary.unknown;
    this.#closed.inputTokens += summary.inputTokens;
    this.#closed.outputTokens += summary.outputTokens;
    this.#turn = undefined;
    return {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      unknownTokens: summary.unknown,
      modelRequests: turn.modelRequests,
      toolUnits: turn.toolUnits,
    };
  }

  reserve(request: { readonly estimatedTokens: number; readonly final: boolean }) {
    const turn = this.#openTurn();
    const reserved = turn.ledger.reserve(request);
    if (reserved.ok) turn.modelRequests += 1;
    return reserved;
  }

  settle(reservationId: string, settlement: Settlement): SettlementResult {
    return this.#openTurn().ledger.settle(reservationId, settlement);
  }

  /** What the run would hold if the current Turn ended now (Kernel/Monitor 3.1). */
  #runState(): BudgetState {
    const balance =
      this.#remaining + (this.#turn === undefined ? 0 : this.#turn.ledger.remaining());
    if (balance <= 0) return 'EXHAUSTED';
    return balance < minShare(this.#main) ? 'WRAP_UP' : 'NORMAL';
  }

  /** In stage 1 an AgentRun has no ledger of its own, so `agentRun` equals `turn`. */
  budgetView(): BudgetView {
    const turn = this.#turn;
    const state: BudgetState =
      turn === undefined
        ? 'NORMAL'
        : turn.limit < minShare(this.#main) && turn.ledger.budgetState() === 'NORMAL'
          ? 'WRAP_UP'
          : turn.ledger.budgetState();
    return { agentRun: state, turn: state, run: this.#runState() };
  }

  /** The run's consumption over its closed Turns; the RunSummary is written after the last one. */
  usage(): {
    readonly limit: number;
    readonly used: number;
    readonly unknown: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly finalBudgetState: BudgetState;
  } {
    return {
      limit: this.#budget.runTokenLimit,
      ...this.#closed,
      finalBudgetState: this.#runState(),
    };
  }

  /** Counts an accepted tool Unit; the Unit that passes the limit is refused. */
  countToolUnit(agentRunId: string, maxToolUnits: number): QuotaResult {
    if (this.#overTime.has(agentRunId)) return { ok: false, quota: 'WALL_CLOCK' };
    const used = this.#toolUnits.get(agentRunId) ?? 0;
    if (used >= maxToolUnits) return { ok: false, quota: 'TOOL_UNITS' };
    this.#toolUnits.set(agentRunId, used + 1);
    const turn = this.#turn;
    if (turn !== undefined) turn.toolUnits += 1;
    return { ok: true };
  }

  /** The timer lives in Core, which calls this when it fires. */
  wallClockExceeded(agentRunId: string): void {
    this.#overTime.add(agentRunId);
  }
}
