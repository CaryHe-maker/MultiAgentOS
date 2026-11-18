import { ulid, type BudgetState, type TokenUsage } from '@multiagentos/contracts';
import type {
  BudgetSummary,
  MonitorDuties,
  Settlement,
  SettlementAnomaly,
  SettlementResult,
} from '../interfaces/index.js';

/** What one ledger needs: its limit and the per-call budget of its Agent (Kernel/Monitor 6). */
export interface LedgerConfig {
  readonly tokenLimit: number;
  readonly perCallInputLimit: number;
  readonly maxOutputTokens: number;
  readonly finalInputBudget: number;
  readonly finalMaxOutputTokens: number;
}

interface Charge {
  readonly type: Settlement['type'];
  readonly amount: number;
  readonly usage?: TokenUsage;
}

interface Reservation {
  readonly estimatedTokens: number;
  readonly cacheHitWeight: number;
  charge?: Charge;
}

/** A broken caller or reservation identity, rather than a recoverable settlement anomaly. */
export class MonitorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonitorInvariantError';
  }
}

/** One run's ledger. Core is the only caller and owns the audit of reported anomalies. */
export class Monitor implements MonitorDuties {
  readonly #config: LedgerConfig;
  readonly #reservations = new Map<string, Reservation>();
  readonly #finalReserve: number;
  readonly #wrapUpMargin: number;
  #used = 0;
  #unknown = 0;
  #reserved = 0;
  /** Lent to ledgers below and not yet paid back (Kernel/Monitor 3.2, M2Design 7.3). */
  #lent = 0;
  /** What the ledgers below spent of what they were lent: gone for good. */
  #lentSpent = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #state: BudgetState = 'NORMAL';
  #finalized = false;
  /** What was added to the limit after the ledger opened (a top-up, M2Design 7.3 rule 5). */
  #extended = 0;
  /**
   * A reservation that did not fit: the state it forced, whatever the balance says, until the
   * ledger has more (a top-up, or a loan that comes back).
   */
  #refused: BudgetState | undefined;

  /** `allowShortLimit`: the share of an input's work may be smaller than the reserves; it opens wrapped up. */
  constructor(config: LedgerConfig, options: { readonly allowShortLimit?: boolean } = {}) {
    this.#config = config;
    this.#finalReserve = config.finalInputBudget + config.finalMaxOutputTokens;
    this.#wrapUpMargin = config.perCallInputLimit + config.maxOutputTokens;
    const { tokenLimit, ...parameters } = config;
    if (
      Object.values(parameters).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      !Number.isSafeInteger(tokenLimit) ||
      tokenLimit < (options.allowShortLimit === true ? 0 : 1) ||
      !Number.isSafeInteger(this.#finalReserve + this.#wrapUpMargin)
    )
      throw new MonitorInvariantError('Invalid token budget configuration');
    if (config.tokenLimit < this.#finalReserve + this.#wrapUpMargin) {
      if (options.allowShortLimit !== true)
        throw new MonitorInvariantError(
          'Token limit cannot cover the final reserve and wrap-up margin',
        );
      this.#recalculateState();
    }
  }

  reserve({
    estimatedTokens,
    final,
    cacheHitWeight = 1,
  }: {
    readonly estimatedTokens: number;
    readonly final: boolean;
    /** What a cached input token costs against an uncached one, from the model's pricing. */
    readonly cacheHitWeight?: number;
  }) {
    if (this.#finalized) throw new MonitorInvariantError('Cannot reserve after finalization');
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0)
      throw new MonitorInvariantError('Invalid token estimate');
    if (!Number.isFinite(cacheHitWeight) || cacheHitWeight < 0 || cacheHitWeight > 1)
      throw new MonitorInvariantError('Invalid cache hit weight');
    if (this.#state === 'EXHAUSTED')
      return { ok: false as const, reasonCode: 'BUDGET_EXHAUSTED' as const };
    const available = this.#limit() - (final ? 0 : this.#finalReserve);
    if (estimatedTokens > available - this.#used - this.#unknown - this.#reserved) {
      this.#refused = final ? 'EXHAUSTED' : 'WRAP_UP';
      this.#recalculateState();
      return {
        ok: false as const,
        reasonCode: final ? ('BUDGET_EXHAUSTED' as const) : ('BUDGET_WRAP_UP' as const),
      };
    }
    const reservationId = `rsv_${ulid()}`;
    this.#reservations.set(reservationId, { estimatedTokens, cacheHitWeight });
    this.#reserved += estimatedTokens;
    return { ok: true as const, reservationId };
  }

  settle(reservationId: string, settlement: Settlement): SettlementResult {
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined) throw new MonitorInvariantError('Unknown reservation');
    if (this.#finalized) throw new MonitorInvariantError('Cannot settle after finalization');
    const charge = this.#charge(reservation, settlement);
    const anomalies: SettlementAnomaly[] = [];
    const previous = reservation.charge;
    let applied = false;
    if (previous === undefined) {
      this.#replaceCharge(undefined, charge);
      this.#reserved -= reservation.estimatedTokens;
      reservation.charge = charge;
      applied = true;
    } else if (!this.#sameCharge(previous, charge)) {
      anomalies.push({
        type: 'CONFLICTING_SETTLEMENT',
        reservationId,
        previousTokens: previous.amount,
        offeredTokens: charge.amount,
      });
      // The larger observed charge wins. At equal value, prefer measured usage to uncertainty.
      if (
        charge.amount > previous.amount ||
        (charge.amount === previous.amount &&
          charge.type === 'ACTUAL' &&
          previous.type !== 'ACTUAL')
      ) {
        this.#replaceCharge(previous, charge);
        reservation.charge = charge;
        applied = true;
      }
    }
    if (applied && settlement.type === 'ACTUAL' && charge.amount > reservation.estimatedTokens) {
      anomalies.push({
        type: 'ACTUAL_EXCEEDED_ESTIMATE',
        reservationId,
        estimatedTokens: reservation.estimatedTokens,
        actualTokens: charge.amount,
      });
    }
    this.#recalculateState();
    return { budgetState: this.#state, anomalies };
  }

  budgetState(): BudgetState {
    return this.#state;
  }

  /** The balance if nothing reserved were spent is not what counts: reservations are spent. */
  remaining(): number {
    return this.#limit() - this.#used - this.#unknown - this.#reserved;
  }

  /** What the limit is once the loans are taken out. */
  #limit(): number {
    return this.#config.tokenLimit + this.#extended - this.#lent - this.#lentSpent;
  }

  /**
   * What the ledger keeps for itself when it lends (M2Design 7.3, rule 1): a third of what it
   * opened with, and at least the final reserve and two ordinary calls. The line of WRAP_UP is
   * the final reserve and one call, so a ledger that has lent all it may is still a whole call
   * away from wrapping up, and goes on coordinating while the ledgers below work.
   */
  #kept(): number {
    return Math.max(
      Math.ceil(this.#config.tokenLimit / 3),
      this.#finalReserve + 2 * this.#wrapUpMargin,
    );
  }

  /** What may be lent: the balance less what the ledger keeps for itself. */
  delegable(): number {
    return Math.max(0, this.remaining() - this.#kept());
  }

  /**
   * How much the ledger lacks to lend `amount` and still keep what it keeps for itself: what a
   * top-up must bring before it can (rule 5). A ledger that has spent into what it keeps lacks
   * that too, which `delegable` (never below 0) does not show.
   */
  lendShort(amount: number): number {
    return Math.max(0, amount + this.#kept() - this.remaining());
  }

  /**
   * How much the ledger lacks to take a call of `estimatedTokens` and still be in NORMAL after
   * it: what a top-up must bring (rule 5). 0 when it has enough.
   */
  shortBy(estimatedTokens: number): number {
    return Math.max(
      0,
      estimatedTokens + this.#finalReserve + this.#wrapUpMargin - this.remaining(),
    );
  }

  /** The limit grows by `amount`: a top-up from the ledger above, or from the user (rule 5). */
  extend(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new MonitorInvariantError('Invalid extension');
    if (this.#finalized) throw new MonitorInvariantError('Cannot extend after finalization');
    this.#extended += amount;
    this.#refused = undefined;
    this.#recalculateState();
  }

  /** Takes `amount` out of the limit for a ledger below. */
  lend(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.delegable())
      throw new MonitorInvariantError('Cannot lend more than is delegable');
    this.#lent += amount;
    this.#recalculateState();
  }

  /** A loan of `amount` ends; the ledger below spent `spent` of it, and the rest comes back. */
  settleLoan(amount: number, spent: number): void {
    if (amount > this.#lent || spent > amount || spent < 0)
      throw new MonitorInvariantError('Unknown loan');
    this.#lent -= amount;
    this.#lentSpent += spent;
    // What came back may lift the ledger out of WRAP_UP: its state follows its balance.
    if (amount > spent) this.#refused = undefined;
    this.#recalculateState();
  }

  finalize(): BudgetSummary {
    if (!this.#finalized) {
      for (const reservation of this.#reservations.values()) {
        if (reservation.charge !== undefined) continue;
        const charge: Charge = { type: 'UNKNOWN', amount: reservation.estimatedTokens };
        this.#replaceCharge(undefined, charge);
        this.#reserved -= reservation.estimatedTokens;
        reservation.charge = charge;
      }
      this.#recalculateState();
      this.#finalized = true;
    }
    return {
      limit: this.#config.tokenLimit,
      used: this.#used,
      unknown: this.#unknown,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      finalBudgetState: this.#state,
    };
  }

  #charge(reservation: Reservation, settlement: Settlement): Charge {
    if (settlement.type === 'NOT_SENT') return { type: 'NOT_SENT', amount: 0 };
    if (settlement.type === 'UNKNOWN')
      return { type: 'UNKNOWN', amount: reservation.estimatedTokens };
    const { inputTokens, outputTokens } = settlement.usage;
    if (
      !Number.isSafeInteger(inputTokens) ||
      !Number.isSafeInteger(outputTokens) ||
      inputTokens < 0 ||
      outputTokens < 0 ||
      !Number.isSafeInteger(inputTokens + outputTokens) ||
      (settlement.usage.inputCacheHitTokens !== undefined &&
        (!Number.isSafeInteger(settlement.usage.inputCacheHitTokens) ||
          settlement.usage.inputCacheHitTokens < 0 ||
          settlement.usage.inputCacheHitTokens > inputTokens))
    )
      throw new MonitorInvariantError('Invalid actual token usage');
    const hits = settlement.usage.inputCacheHitTokens ?? 0;
    const input = Math.ceil(inputTokens - hits + hits * reservation.cacheHitWeight);
    return { type: 'ACTUAL', amount: input + outputTokens, usage: settlement.usage };
  }

  #sameCharge(left: Charge, right: Charge): boolean {
    return (
      left.type === right.type &&
      left.amount === right.amount &&
      (left.type !== 'ACTUAL' ||
        (left.usage?.inputTokens === right.usage?.inputTokens &&
          left.usage?.outputTokens === right.usage?.outputTokens))
    );
  }

  #replaceCharge(previous: Charge | undefined, next: Charge): void {
    const used =
      this.#used -
      (previous?.type === 'ACTUAL' ? previous.amount : 0) +
      (next.type === 'ACTUAL' ? next.amount : 0);
    const unknown =
      this.#unknown -
      (previous?.type === 'UNKNOWN' ? previous.amount : 0) +
      (next.type === 'UNKNOWN' ? next.amount : 0);
    const inputTokens =
      this.#inputTokens - (previous?.usage?.inputTokens ?? 0) + (next.usage?.inputTokens ?? 0);
    const outputTokens =
      this.#outputTokens - (previous?.usage?.outputTokens ?? 0) + (next.usage?.outputTokens ?? 0);
    if (
      [used, unknown, inputTokens, outputTokens, used + unknown].some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      )
    )
      throw new MonitorInvariantError('Token ledger cannot represent the settlement');
    this.#used = used;
    this.#unknown = unknown;
    this.#inputTokens = inputTokens;
    this.#outputTokens = outputTokens;
  }

  /**
   * The state follows the balance, in both directions: a ledger that was low and got more (a loan
   * came back, a top-up) is in NORMAL again. Before, the state only ever got worse, so a task
   * that lent all it could was wrapped up for good by its next call, with the tokens it had lent
   * coming back unused. Once finalized, the state stays.
   */
  #recalculateState(): void {
    if (this.#finalized) return;
    const rank = { NORMAL: 0, WRAP_UP: 1, EXHAUSTED: 2 } as const;
    const remaining = this.#limit() - this.#used - this.#unknown;
    const byBalance: BudgetState =
      remaining < this.#finalReserve
        ? 'EXHAUSTED'
        : remaining < this.#finalReserve + this.#wrapUpMargin
          ? 'WRAP_UP'
          : 'NORMAL';
    const refused = this.#refused ?? 'NORMAL';
    this.#state = rank[refused] > rank[byBalance] ? refused : byBalance;
  }
}
