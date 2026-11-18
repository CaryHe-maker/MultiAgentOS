/**
 * Kernel-private interfaces between Core, Monitor and Scheduler, and the Kernel configuration
 * defaults. Nothing here enters `@multiagentos/contracts`. `reservationId` (prefix `rsv`) comes
 * from Monitor and `grantId` (prefix `grt`) from Scheduler; neither leaves the Kernel core.
 */
import type { BudgetState, TokenUsage } from '@multiagentos/contracts';

export * from './kernel-config.js';

// --- Core -> Monitor: duties ------------------------------------------------------------------

export type Settlement =
  | { readonly type: 'ACTUAL'; readonly usage: TokenUsage }
  | { readonly type: 'NOT_SENT' }
  | { readonly type: 'UNKNOWN' };

export type SettlementAnomaly =
  | {
      readonly type: 'ACTUAL_EXCEEDED_ESTIMATE';
      readonly reservationId: string;
      readonly estimatedTokens: number;
      readonly actualTokens: number;
    }
  | {
      readonly type: 'CONFLICTING_SETTLEMENT';
      readonly reservationId: string;
      readonly previousTokens: number;
      readonly offeredTokens: number;
    };

export interface SettlementResult {
  readonly budgetState: BudgetState;
  readonly anomalies: readonly SettlementAnomaly[];
}

export interface BudgetSummary {
  readonly limit: number;
  readonly used: number;
  readonly unknown: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly finalBudgetState: BudgetState;
}

export interface MonitorDuties {
  reserve(request: {
    readonly estimatedTokens: number;
    readonly final: boolean;
  }):
    | { readonly ok: true; readonly reservationId: string }
    | { readonly ok: false; readonly reasonCode: 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED' };
  /** Idempotent by reservationId. */
  settle(reservationId: string, settlement: Settlement): SettlementResult;
  budgetState(): BudgetState;
  /** Settles what is still reserved as unknown consumption. */
  finalize(): BudgetSummary;
}

// --- Core -> Scheduler: duties ----------------------------------------------------------------

export interface SchedulerDuties {
  /**
   * `CAPACITY`: every slot of the provider is held, which is normal with several AgentRuns and
   * means wait (M2Design 7.2). `STOPPED`: the run no longer grants (it converges).
   */
  acquire(
    provider: string,
  ):
    | { readonly ok: true; readonly grantId: string }
    | { readonly ok: false; readonly reason: 'CAPACITY' | 'STOPPED' };
  /** Idempotent. */
  release(grantId: string): void;
  stopGranting(): void;
  releaseAll(): number;
}

/** Capacity shared by all runs. It lives in the process, with `providerCapacity` slots per provider. */
export interface ProviderCapacityPort {
  /** Returns a token, or null when the provider is busy. */
  tryAcquire(provider: string): string | null;
  release(token: string): void;
}
