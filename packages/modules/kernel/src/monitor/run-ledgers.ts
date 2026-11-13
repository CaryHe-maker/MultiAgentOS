import {
  agentMinShare,
  type BudgetState,
  type BudgetView,
  type InputUsage,
} from '@multiagentos/contracts';
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
  readonly inputTokenLimit: number;
}

export const finalReserve = (agent: AgentBudget): number =>
  agent.finalInputBudget + agent.finalMaxOutputTokens;
export const wrapUpMargin = (agent: AgentBudget): number =>
  agent.perCallInputLimit + agent.maxOutputTokens;
export const minShare = agentMinShare;

/** A ledger whose limit is below `minShare` can only wrap up, so it is at least in WRAP_UP. */
function stateOf(ledger: Monitor, limit: number, agent: AgentBudget): BudgetState {
  const state = ledger.budgetState();
  return state === 'NORMAL' && limit < minShare(agent) ? 'WRAP_UP' : state;
}

/** The startup checks that need no model or prompt (Kernel/Monitor 6). */
export function assertBudgetsConsistent(budget: RunBudget, main: AgentBudget): void {
  const values = [
    main.perCallInputLimit,
    main.maxOutputTokens,
    main.finalInputBudget,
    main.finalMaxOutputTokens,
    budget.runTokenLimit,
    budget.inputTokenLimit,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new MonitorInvariantError('Budget values must be positive safe integers');
  if (!Number.isSafeInteger(minShare(main)))
    throw new MonitorInvariantError('Budget values overflow');
  if (budget.inputTokenLimit < minShare(main))
    throw new MonitorInvariantError('inputTokenLimit is below minShare(main)');
  if (budget.runTokenLimit < budget.inputTokenLimit)
    throw new MonitorInvariantError('runTokenLimit is below inputTokenLimit');
}

/** What ledgers used: the one shape of every sum below. */
interface Usage {
  used: number;
  unknown: number;
  inputTokens: number;
  outputTokens: number;
}

const noUsage = (): Usage => ({ used: 0, unknown: 0, inputTokens: 0, outputTokens: 0 });

function addUsage(target: Usage, more: Usage): void {
  target.used += more.used;
  target.unknown += more.unknown;
  target.inputTokens += more.inputTokens;
  target.outputTokens += more.outputTokens;
}

interface InputLedger {
  readonly inputId: string;
  readonly limit: number;
  readonly ledger: Monitor;
  modelRequests: number;
  toolUnits: number;
  /** What the ledgers of the input's SubAgents used, for the input's usage. */
  readonly below: Usage;
}

/**
 * The ledger of a task that was funded by a delegation (M2Design 7.3): every segment of the task
 * spends from it, so sleeping does not raise what the task may spend (Orchestration 8.3).
 */
interface AgentLedger {
  readonly key: string;
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
 * One run's token budget: the run grants each input a share and takes back what is left. A share
 * too small to work with still opens, in WRAP_UP, because budget never stops a run on its own:
 * Workflow wraps up and ends it (M2Design 7.3).
 */
export class RunLedgers {
  readonly #budget: RunBudget;
  readonly #main: AgentBudget;
  readonly #toolUnits = new Map<string, number>();
  /**
   * Funded tasks below main, by ledger key (the task, or the AgentRun when it is a task of its
   * own); main (and any AgentRun without a share) uses the input's ledger.
   */
  readonly #agents = new Map<string, AgentLedger>();
  /** The ledger key each AgentRun spends from. */
  readonly #keyOf = new Map<string, string>();
  readonly #delegations = new Map<string, Delegation>();
  readonly #owners = new Map<string, Monitor>();
  readonly #overTime = new Set<string>();
  #remaining: number;
  #input: InputLedger | undefined;
  /** What the closed inputs used, for the RunSummary. */
  readonly #closed = noUsage();

  public constructor(budget: RunBudget, main: AgentBudget) {
    assertBudgetsConsistent(budget, main);
    this.#budget = budget;
    this.#main = main;
    this.#remaining = budget.runTokenLimit;
  }

  openInputLedger(inputId: string): { readonly state: BudgetState } {
    if (this.#input !== undefined)
      throw new MonitorInvariantError('An input ledger is already open');
    const limit = Math.min(this.#budget.inputTokenLimit, this.#remaining);
    this.#remaining -= limit;
    const ledger = new Monitor({ ...this.#main, tokenLimit: limit }, { allowShortLimit: true });
    this.#input = { inputId, limit, ledger, modelRequests: 0, toolUnits: 0, below: noUsage() };
    return { state: stateOf(ledger, limit, this.#main) };
  }

  #openInput(): InputLedger {
    if (this.#input === undefined) throw new MonitorInvariantError('No input ledger is open');
    return this.#input;
  }

  /** Unsettled reservations count as unknown, and what is left goes back to the run. */
  closeInputLedger(inputId: string): InputUsage {
    const input = this.#openInput();
    if (input.inputId !== inputId) throw new MonitorInvariantError('Another input ledger is open');
    // A task still open ends with the input: what it did not settle is unknown.
    for (const key of [...this.#agents.keys()]) this.#closeLedger(key);
    this.#keyOf.clear();
    this.#delegations.clear();
    const total = noUsage();
    addUsage(total, input.ledger.finalize());
    addUsage(total, input.below);
    this.#remaining += input.limit - total.used - total.unknown;
    addUsage(this.#closed, total);
    this.#input = undefined;
    return {
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      unknownTokens: total.unknown,
      modelRequests: input.modelRequests,
      toolUnits: input.toolUnits,
    };
  }

  /** An input ledger is open: main's calls are paid from it. */
  hasOpenInput(): boolean {
    return this.#input !== undefined;
  }

  /**
   * A ledger of its own for a compaction while no input is open (`/compact`; Kernel/Monitor 3.4).
   * The share is taken out of the run's balance, which must stay at least `minShare(main)`, and
   * what is not used goes back when it is closed. It can sit beside an input ledger, since an input
   * may open while the compaction is still going.
   */
  openCompactionLedger(estimatedTokens: number):
    | { readonly ok: false; readonly reasonCode: 'BUDGET_INSUFFICIENT' }
    | {
        readonly ok: true;
        reserve(cacheHitWeight: number): string | undefined;
        settle(reservationId: string, settlement: Settlement): SettlementResult;
        close(): void;
      } {
    const share = estimatedTokens + finalReserve(this.#main);
    if (!Number.isSafeInteger(share) || this.#remaining - share < minShare(this.#main))
      return { ok: false, reasonCode: 'BUDGET_INSUFFICIENT' };
    this.#remaining -= share;
    const ledger = new Monitor({ ...this.#main, tokenLimit: share }, { allowShortLimit: true });
    let closed = false;
    return {
      ok: true,
      reserve: (cacheHitWeight) => {
        const reserved = ledger.reserve({ estimatedTokens, final: false, cacheHitWeight });
        return reserved.ok ? reserved.reservationId : undefined;
      },
      settle: (reservationId, settlement) => ledger.settle(reservationId, settlement),
      close: () => {
        if (closed) return;
        closed = true;
        const total = noUsage();
        addUsage(total, ledger.finalize());
        this.#remaining += share - total.used - total.unknown;
        addUsage(this.#closed, total);
      },
    };
  }

  /** Reserves in the ledger of `agentRunId`; without it, in the input's (main's own). */
  reserve(
    request: {
      readonly estimatedTokens: number;
      readonly final: boolean;
      readonly cacheHitWeight?: number;
    },
    agentRunId?: string,
  ) {
    const input = this.#openInput();
    const ledger = this.#ledgerOf(agentRunId);
    const reserved = ledger.reserve(request);
    if (reserved.ok) {
      input.modelRequests += 1;
      this.#owners.set(reserved.reservationId, ledger);
    }
    return reserved;
  }

  settle(reservationId: string, settlement: Settlement): SettlementResult {
    this.#openInput();
    const owner = this.#owners.get(reservationId);
    if (owner === undefined) throw new MonitorInvariantError('Unknown reservation');
    return owner.settle(reservationId, settlement);
  }

  #ledgerOf(agentRunId: string | undefined): Monitor {
    const input = this.#openInput();
    if (agentRunId === undefined) return input.ledger;
    return this.#agents.get(this.#keyOf.get(agentRunId) ?? agentRunId)?.ledger ?? input.ledger;
  }

  /** The ledger key a parent's loans are owed to: its task's, or none for the input's. */
  #parentKey(agentRunId: string): string | undefined {
    const key = this.#keyOf.get(agentRunId) ?? agentRunId;
    return this.#agents.has(key) ? key : undefined;
  }

  #ledgerOfKey(key: string | undefined): Monitor {
    const input = this.#openInput();
    return key === undefined ? input.ledger : (this.#agents.get(key)?.ledger ?? input.ledger);
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
      parent: this.#parentKey(request.parentAgentRunId),
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

  /**
   * A task registers its first segment: its share becomes its own ledger (M2Design 7.3, rule 3),
   * kept under `ledgerKey` (the task) for its later segments; without one, under the AgentRun.
   */
  registerAgentRun(request: {
    readonly agentRunId: string;
    readonly delegationId: string;
    readonly taskName: string;
    readonly agent: AgentBudget;
    readonly ledgerKey?: string;
  }): { readonly state: BudgetState } {
    const delegation = this.#delegations.get(request.delegationId);
    const share = delegation?.shares.get(request.taskName);
    if (delegation === undefined || delegation.released || share === undefined)
      throw new MonitorInvariantError('No such share in the delegation');
    if (delegation.claimed.has(request.taskName))
      throw new MonitorInvariantError('The share is already claimed');
    const key = request.ledgerKey ?? request.agentRunId;
    if (this.#agents.has(key) || this.#keyOf.has(request.agentRunId))
      throw new MonitorInvariantError('The AgentRun has a ledger');
    delegation.claimed.add(request.taskName);
    const ledger = new Monitor({ ...request.agent, tokenLimit: share }, { allowShortLimit: true });
    this.#keyOf.set(request.agentRunId, key);
    this.#agents.set(key, {
      key,
      parent: delegation.parent,
      agent: request.agent,
      share,
      ledger,
    });
    return { state: stateOf(ledger, share, request.agent) };
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
    if (returned > 0) this.#ledgerOfKey(delegation.parent).settleLoan(returned, 0);
    return returned;
  }

  /** A later segment of a funded task spends from the task's ledger (Orchestration 8.3). */
  attachAgentRun(agentRunId: string, ledgerKey: string): void {
    if (this.#agents.has(ledgerKey)) this.#keyOf.set(agentRunId, ledgerKey);
  }

  /**
   * An AgentRun below main ends. When its task goes on (`continues`, it went to sleep) the task's
   * ledger stays as it is; otherwise the task has ended: the unused part of its share goes back at
   * once, and what it used, and what it could not settle, stays spent (M2Design 7.3, rule 4). Safe
   * to repeat.
   */
  endAgentRun(agentRunId: string, continues = false): void {
    const key = this.#keyOf.get(agentRunId) ?? agentRunId;
    this.#keyOf.delete(agentRunId);
    if (!continues) this.#closeLedger(key);
  }

  #closeLedger(key: string): void {
    const agent = this.#agents.get(key);
    if (agent === undefined) return;
    this.#agents.delete(key);
    for (const [agentRunId, each] of [...this.#keyOf])
      if (each === key) this.#keyOf.delete(agentRunId);
    const summary = agent.ledger.finalize();
    this.#ledgerOfKey(agent.parent).settleLoan(agent.share, summary.used + summary.unknown);
    if (this.#input !== undefined) addUsage(this.#input.below, summary);
  }

  /** What the run would hold if the current input ended now (Kernel/Monitor 3.1). */
  #runState(): BudgetState {
    const balance =
      this.#remaining + (this.#input === undefined ? 0 : this.#input.ledger.remaining());
    if (balance <= 0) return 'EXHAUSTED';
    return balance < minShare(this.#main) ? 'WRAP_UP' : 'NORMAL';
  }

  /** The state of the input's ledger; a share too small to work with opens in WRAP_UP. */
  #inputState(): BudgetState {
    const input = this.#input;
    return input === undefined ? 'NORMAL' : stateOf(input.ledger, input.limit, this.#main);
  }

  /**
   * The three ledgers an AgentRun draws on. An AgentRun of its own (a SubAgent) has its own state;
   * main spends from the input's ledger, so its state is the input's.
   */
  budgetView(agentRunId?: string): BudgetView {
    const input = this.#inputState();
    const own =
      agentRunId === undefined
        ? undefined
        : this.#agents.get(this.#keyOf.get(agentRunId) ?? agentRunId);
    const state = own === undefined ? input : stateOf(own.ledger, own.share, own.agent);
    return { agentRun: state, input, run: this.#runState() };
  }

  /** The run's consumption over its closed inputs; the RunSummary is written after the last one. */
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
    const input = this.#input;
    if (input !== undefined) input.toolUnits += 1;
    return { ok: true };
  }

  /** The timer lives in Core, which calls this when it fires. */
  wallClockExceeded(agentRunId: string): void {
    this.#overTime.add(agentRunId);
  }
}
