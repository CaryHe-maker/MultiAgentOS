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
  /** What the ledgers of the Turn's SubAgents used, for the Turn's usage. */
  readonly below: { used: number; unknown: number; inputTokens: number; outputTokens: number };
}

/** The ledger of an AgentRun that was funded by a delegation (M2Design 7.3). */
interface AgentLedger {
  readonly agentRunId: string;
  readonly parent: string | undefined;
  readonly agent: AgentBudget;
  readonly share: number;
  readonly ledger: Monitor;
}

interface Delegation {
  readonly delegationId: string;
  readonly parent: string | undefined;
  /** The share of each task by name; claimed when the task registers. */
  readonly shares: Map<string, number>;
  readonly claimed: Set<string>;
  released: boolean;
}

export type DelegationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: 'BUDGET_INSUFFICIENT'; readonly delegable: number };

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
  /** AgentRuns below main, by id; main (and any AgentRun without a parent) uses the Turn's ledger. */
  readonly #agents = new Map<string, AgentLedger>();
  /** The AgentRuns that spend from the Turn's ledger, with their definitions' budget. */
  readonly #topLevel = new Map<string, AgentBudget>();
  readonly #delegations = new Map<string, Delegation>();
  readonly #owners = new Map<string, Monitor>();
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
    this.#turn = {
      turnId,
      limit,
      ledger,
      modelRequests: 0,
      toolUnits: 0,
      below: { used: 0, unknown: 0, inputTokens: 0, outputTokens: 0 },
    };
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
    // An AgentRun still open ends with the Turn: what it did not settle is unknown.
    for (const id of [...this.#agents.keys()]) this.endAgentRun(id);
    this.#delegations.clear();
    this.#topLevel.clear();
    const summary = turn.ledger.finalize();
    const { below } = turn;
    this.#remaining += turn.limit - summary.used - summary.unknown - below.used - below.unknown;
    this.#closed.used += summary.used + below.used;
    this.#closed.unknown += summary.unknown + below.unknown;
    this.#closed.inputTokens += summary.inputTokens + below.inputTokens;
    this.#closed.outputTokens += summary.outputTokens + below.outputTokens;
    this.#turn = undefined;
    return {
      inputTokens: summary.inputTokens + below.inputTokens,
      outputTokens: summary.outputTokens + below.outputTokens,
      unknownTokens: summary.unknown + below.unknown,
      modelRequests: turn.modelRequests,
      toolUnits: turn.toolUnits,
    };
  }

  /** Reserves in the ledger of `agentRunId`; without it, in the Turn's (main's own). */
  reserve(
    request: {
      readonly estimatedTokens: number;
      readonly final: boolean;
      readonly cacheHitWeight?: number;
    },
    agentRunId?: string,
  ) {
    const turn = this.#openTurn();
    const ledger = this.#ledgerOf(agentRunId);
    const reserved = ledger.reserve(request);
    if (reserved.ok) {
      turn.modelRequests += 1;
      this.#owners.set(reserved.reservationId, ledger);
    }
    return reserved;
  }

  settle(reservationId: string, settlement: Settlement): SettlementResult {
    this.#openTurn();
    const owner = this.#owners.get(reservationId);
    if (owner === undefined) throw new MonitorInvariantError('Unknown reservation');
    return owner.settle(reservationId, settlement);
  }

  #ledgerOf(agentRunId: string | undefined): Monitor {
    const turn = this.#openTurn();
    if (agentRunId === undefined) return turn.ledger;
    return this.#agents.get(agentRunId)?.ledger ?? turn.ledger;
  }

  /** An AgentRun that spends from the Turn's ledger, such as main, with its Agent's budget. */
  registerTopLevel(agentRunId: string, agent: AgentBudget): void {
    this.#topLevel.set(agentRunId, agent);
  }

  #budgetOf(agentRunId: string | undefined): AgentBudget {
    if (agentRunId === undefined) return this.#main;
    return this.#agents.get(agentRunId)?.agent ?? this.#topLevel.get(agentRunId) ?? this.#main;
  }

  /**
   * Takes the shares of a `run_subagents` call out of the parent's ledger, all or none (M2Design 7.3,
   * rule 2). The parent keeps its final reserve and one ordinary call, so it can go on afterwards.
   */
  reserveDelegation(request: {
    readonly delegationId: string;
    readonly parentAgentRunId: string;
    readonly shares: readonly { readonly name: string; readonly tokens: number }[];
  }): DelegationResult {
    const parent = this.#ledgerOf(request.parentAgentRunId);
    if (this.#delegations.has(request.delegationId))
      throw new MonitorInvariantError('Delegation exists');
    const total = request.shares.reduce((sum, share) => sum + share.tokens, 0);
    if (request.shares.some((share) => !Number.isSafeInteger(share.tokens) || share.tokens <= 0))
      throw new MonitorInvariantError('A share must be a positive integer');
    if (total > parent.delegable())
      return { ok: false, reasonCode: 'BUDGET_INSUFFICIENT', delegable: parent.delegable() };
    parent.lend(total);
    this.#delegations.set(request.delegationId, {
      delegationId: request.delegationId,
      parent: this.#agents.has(request.parentAgentRunId) ? request.parentAgentRunId : undefined,
      shares: new Map(request.shares.map((share) => [share.name, share.tokens])),
      claimed: new Set(),
      released: false,
    });
    return { ok: true };
  }

  /** The balance a parent could delegate now: the number a refusal tells (M2Design 3.6). */
  delegable(parentAgentRunId: string): number {
    return this.#ledgerOf(parentAgentRunId).delegable();
  }

  /** A task registers: its share becomes its own ledger (M2Design 7.3, rule 3). */
  registerAgentRun(request: {
    readonly agentRunId: string;
    readonly delegationId: string;
    readonly taskName: string;
    readonly agent: AgentBudget;
  }): { readonly state: BudgetState } {
    const delegation = this.#delegations.get(request.delegationId);
    const share = delegation?.shares.get(request.taskName);
    if (delegation === undefined || delegation.released || share === undefined)
      throw new MonitorInvariantError('No such share in the delegation');
    if (delegation.claimed.has(request.taskName))
      throw new MonitorInvariantError('The share is already claimed');
    if (this.#agents.has(request.agentRunId))
      throw new MonitorInvariantError('The AgentRun has a ledger');
    delegation.claimed.add(request.taskName);
    const ledger = new Monitor({ ...request.agent, tokenLimit: share }, { allowShortLimit: true });
    this.#agents.set(request.agentRunId, {
      agentRunId: request.agentRunId,
      parent: delegation.parent,
      agent: request.agent,
      share,
      ledger,
    });
    // A share below minShare opens in WRAP_UP: it can only wrap up, and Workflow does so.
    return { state: share < minShare(request.agent) ? 'WRAP_UP' : ledger.budgetState() };
  }

  /**
   * The shares of a delegation nobody claimed go back to the parent: the tasks that were skipped or
   * refused (M2Design 7.3, rule 3). The claimed ones come back when their AgentRuns end.
   */
  releaseDelegation(delegationId: string): number {
    const delegation = this.#delegations.get(delegationId);
    if (delegation === undefined || delegation.released) return 0;
    delegation.released = true;
    let returned = 0;
    for (const [name, tokens] of delegation.shares)
      if (!delegation.claimed.has(name)) returned += tokens;
    if (returned > 0) this.#ledgerOf(delegation.parent).settleLoan(returned, 0);
    return returned;
  }

  /**
   * An AgentRun below main ends: the unused part of its share goes back at once; what it used, and
   * what it could not settle, stays spent (M2Design 7.3, rule 4). Safe to repeat.
   */
  endAgentRun(agentRunId: string): void {
    const agent = this.#agents.get(agentRunId);
    if (agent === undefined) return;
    this.#agents.delete(agentRunId);
    const summary = agent.ledger.finalize();
    this.#ledgerOf(agent.parent).settleLoan(agent.share, summary.used + summary.unknown);
    const turn = this.#turn;
    if (turn !== undefined) {
      turn.below.used += summary.used;
      turn.below.unknown += summary.unknown;
      turn.below.inputTokens += summary.inputTokens;
      turn.below.outputTokens += summary.outputTokens;
    }
  }

  /** What the run would hold if the current Turn ended now (Kernel/Monitor 3.1). */
  #runState(): BudgetState {
    const balance =
      this.#remaining + (this.#turn === undefined ? 0 : this.#turn.ledger.remaining());
    if (balance <= 0) return 'EXHAUSTED';
    return balance < minShare(this.#main) ? 'WRAP_UP' : 'NORMAL';
  }

  /** The state of the Turn's ledger; a share too small to work with opens in WRAP_UP. */
  #turnState(): BudgetState {
    const turn = this.#turn;
    if (turn === undefined) return 'NORMAL';
    return turn.limit < minShare(this.#main) && turn.ledger.budgetState() === 'NORMAL'
      ? 'WRAP_UP'
      : turn.ledger.budgetState();
  }

  /**
   * The three ledgers an AgentRun draws on. An AgentRun of its own (a SubAgent) has its own state;
   * main spends from the Turn's ledger, so its state is the Turn's.
   */
  budgetView(agentRunId?: string): BudgetView {
    const turn = this.#turnState();
    const own = agentRunId === undefined ? undefined : this.#agents.get(agentRunId);
    const state: BudgetState =
      own === undefined
        ? turn
        : own.share < minShare(own.agent) && own.ledger.budgetState() === 'NORMAL'
          ? 'WRAP_UP'
          : own.ledger.budgetState();
    return { agentRun: state, turn, run: this.#runState() };
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
