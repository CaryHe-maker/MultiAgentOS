import { REASON_CODE_CATEGORY } from '@multiagentos/contracts';
import type {
  FailureHandling,
  ReasonCode,
  RunFailure,
  SyscallRejected,
  UnitDefinition,
  UnitFailedCode,
  UnitRejectedCode,
  WrapUpReason,
} from '@multiagentos/contracts';

/** Only final model-call failures bypass the pinned failurePolicy. */
export function unitFailureHandling(
  unit: UnitDefinition,
  code: UnitRejectedCode | UnitFailedCode,
  isFinal: boolean,
): FailureHandling {
  return isFinal && unit.executionKind === 'MODEL'
    ? 'DEGRADED_REPORT'
    : (unit.failurePolicy[code] ?? 'FATAL');
}

const SEVERITY: Readonly<Record<FailureHandling, number>> = {
  RETURN_TO_MODEL: 0,
  FINAL_CALL: 1,
  DEGRADED_REPORT: 2,
  FATAL: 3,
};

/** Returns no handling for a round without failures; arrival order does not affect severity. */
export function mostSevereFailure(
  handlings: readonly FailureHandling[],
): FailureHandling | undefined {
  return handlings.reduce<FailureHandling | undefined>(
    (worst, next) => (worst === undefined || SEVERITY[next] > SEVERITY[worst] ? next : worst),
    undefined,
  );
}

/** Constructs the protocol failure without forwarding local exception messages. */
export function failureFromCode(code: ReasonCode, unitRequestId?: string): RunFailure {
  return {
    code,
    category: REASON_CODE_CATEGORY[code],
    source: 'WORKFLOW',
    ...(unitRequestId === undefined ? {} : { unitRequestId }),
  };
}

/** Closing rejections and RUN_BLOCKED always wait for RunClosed; other rejections are fatal. */
export function syscallFailureHandling(
  rejection: SyscallRejected,
  isCloseRun: boolean,
): 'WAIT_FOR_CLOSED' | 'CLOSE_FAILED' {
  return isCloseRun || rejection.reasonCode === 'RUN_BLOCKED' ? 'WAIT_FOR_CLOSED' : 'CLOSE_FAILED';
}

/** The M1 pinned definitions use FINAL_CALL only for these two reason codes. */
export function finalCallReason(code: UnitRejectedCode | UnitFailedCode): WrapUpReason {
  if (code === 'USER_DECLINED' || code === 'BUDGET_WRAP_UP') return code;
  throw new Error(`FINAL_CALL has no specified wrap-up mapping for ${code}`);
}
