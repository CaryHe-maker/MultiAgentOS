import { ulid, type BudgetState, type TokenUsage } from '@multiagentos/contracts';
import type { BudgetConfig } from '../interfaces/kernel-config.js';
import type {
  BudgetSummary,
  MonitorDuties,
  Settlement,
  SettlementAnomaly,
  SettlementResult,
} from '../interfaces/index.js';

interface Charge {
  readonly type: Settlement['type'];
  readonly amount: number;
  readonly usage?: TokenUsage;
}

interface Reservation {
  readonly estimatedTokens: number;
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
  readonly #config: BudgetConfig;
  readonly #reservations = new Map<string, Reservation>();
  readonly #finalReserve: number;
  readonly #wrapUpMargin: number;
  #used = 0;
  #unknown = 0;
  #reserved = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #state: BudgetState = 'NORMAL';
  #finalized = false;

  constructor(config: BudgetConfig) {
    this.#config = config;
    this.#finalReserve = config.finalInputBudget + config.finalMaxOutputTokens;
    this.#wrapUpMargin = config.perCallInputLimit + config.maxOutputTokens;
    if (config.tokenLimit < this.#finalReserve + this.#wrapUpMargin)
      throw new MonitorInvariantError(
        'Token limit cannot cover the final reserve and wrap-up margin',
      );
  }

  reserve({
    estimatedTokens,
    final,
  }: {
    readonly estimatedTokens: number;
    readonly final: boolean;
  }) {
    if (this.#finalized) throw new MonitorInvariantError('Cannot reserve after finalization');
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0)
      throw new MonitorInvariantError('Invalid token estimate');
    if (this.#state === 'EXHAUSTED')
      return { ok: false as const, reasonCode: 'BUDGET_EXHAUSTED' as const };
    const available = this.#config.tokenLimit - (final ? 0 : this.#finalReserve);
    if (this.#used + this.#unknown + this.#reserved + estimatedTokens > available) {
      this.#advance(final ? 'EXHAUSTED' : 'WRAP_UP');
      return {
        ok: false as const,
        reasonCode: final ? ('BUDGET_EXHAUSTED' as const) : ('BUDGET_WRAP_UP' as const),
      };
    }
    const reservationId = `rsv_${ulid()}`;
    this.#reservations.set(reservationId, { estimatedTokens });
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
      this.#reserved -= reservation.estimatedTokens;
      this.#apply(charge, 1);
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
        this.#apply(previous, -1);
        this.#apply(charge, 1);
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

  finalize(): BudgetSummary {
    if (!this.#finalized) {
      for (const reservation of this.#reservations.values()) {
        if (reservation.charge !== undefined) continue;
        this.#reserved -= reservation.estimatedTokens;
        const charge: Charge = { type: 'UNKNOWN', amount: reservation.estimatedTokens };
        this.#apply(charge, 1);
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
      !Number.isSafeInteger(inputTokens + outputTokens)
    )
      throw new MonitorInvariantError('Invalid actual token usage');
    return { type: 'ACTUAL', amount: inputTokens + outputTokens, usage: settlement.usage };
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

  #apply(charge: Charge, sign: 1 | -1): void {
    if (charge.type === 'ACTUAL') {
      this.#used += sign * charge.amount;
      this.#inputTokens += sign * (charge.usage?.inputTokens ?? 0);
      this.#outputTokens += sign * (charge.usage?.outputTokens ?? 0);
    } else if (charge.type === 'UNKNOWN') this.#unknown += sign * charge.amount;
  }

  #advance(next: BudgetState): void {
    const rank = { NORMAL: 0, WRAP_UP: 1, EXHAUSTED: 2 } as const;
    if (rank[next] > rank[this.#state]) this.#state = next;
  }

  #recalculateState(): void {
    const remaining = this.#config.tokenLimit - this.#used - this.#unknown;
    if (remaining < this.#finalReserve) this.#advance('EXHAUSTED');
    else if (remaining < this.#finalReserve + this.#wrapUpMargin) this.#advance('WRAP_UP');
  }
}
