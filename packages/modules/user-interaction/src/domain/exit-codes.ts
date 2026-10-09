import type { CloseReason } from '@multiagentos/contracts';

/** Process exit code for each way a run can end (docs/M1/Module/UserInteraction.md 3). */
export const EXIT_CODES: { readonly [Reason in CloseReason]: number } = Object.freeze({
  COMPLETED: 0,
  FAILED: 1,
  RUN_TIMEOUT: 2,
  VIOLATION: 3,
  CANCELLED: 130,
});

/** `createRun` was rejected, so no run exists. */
export const EXIT_CODE_RUN_REJECTED = 4;
