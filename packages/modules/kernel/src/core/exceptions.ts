import type { ReasonCode, ViolationCode } from '@multiagentos/contracts';

/**
 * Core's non-halting exception inputs (docs/M1/Kernel/Core.md 9). These are not a new
 * transport: they are the same messages, results and synchronous returns, normalized at their
 * receiving point. `EXECUTION_FAILED` and `SETTLEMENT_ANOMALY` are observations that keep the
 * existing structured result path.
 */
export type CoreException =
  | { readonly kind: 'KERNEL_FAULT'; readonly faultId: string }
  | { readonly kind: 'RUN_TIMEOUT' }
  | { readonly kind: 'AUTHORIZATION_TIMEOUT' }
  | {
      readonly kind: 'VIOLATION';
      readonly reasonCode: ViolationCode;
      readonly unitRequestId?: string;
    }
  | { readonly kind: 'STOP_UNCONFIRMED'; readonly unitRequestId?: string }
  | {
      readonly kind: 'EXECUTION_FAILED';
      readonly reasonCode: ReasonCode;
      readonly retryable: boolean;
    }
  | {
      readonly kind: 'SETTLEMENT_ANOMALY';
      readonly unitAttemptId: string;
      readonly anomaly: 'ACTUAL_EXCEEDED_ESTIMATE' | 'CONFLICTING_SETTLEMENT';
    };

export type CoreExceptionOutcome = 'HANDLED' | 'IGNORED' | 'ALREADY_CLOSED';
