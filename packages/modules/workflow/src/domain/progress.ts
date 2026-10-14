import type { WrapUpReason } from '@multiagentos/contracts';

export interface ProgressState {
  readonly regenerationCount: number;
  readonly noProgressCount: number;
  readonly wrapUpReason?: WrapUpReason;
}

/** A valid action clears regeneration; reaching the limit preserves an earlier wrap-up reason. */
export function recordRegeneration<T extends ProgressState>(
  state: T,
  isInvalid: boolean,
  regenerationLimit: number,
): T {
  const regenerationCount = isInvalid ? state.regenerationCount + 1 : 0;
  return {
    ...state,
    regenerationCount,
    ...(regenerationCount >= regenerationLimit && state.wrapUpReason === undefined
      ? { wrapUpReason: 'REGENERATION_LIMIT' as const }
      : {}),
  };
}

/** Complete TOOL_CALLS or INVALID rounds; only a new successful result clears no-progress. */
export function recordRoundProgress<T extends ProgressState>(
  state: T,
  hasNewOk: boolean,
  noProgressRounds: number,
): T {
  const noProgressCount = hasNewOk ? 0 : state.noProgressCount + 1;
  return {
    ...state,
    noProgressCount,
    ...(noProgressCount >= noProgressRounds && state.wrapUpReason === undefined
      ? { wrapUpReason: 'NO_PROGRESS' as const }
      : {}),
  };
}
