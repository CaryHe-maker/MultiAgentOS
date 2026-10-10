import {
  assertValid,
  RunClosedSchema,
  RunFinishedSchema,
  type RunClosed,
  type RunFinished,
  type RunSummary,
} from '@multiagentos/contracts';
import type { ExecutionDuties } from '../interfaces/index.js';

export interface FinalRunEvents {
  readonly workflow: RunClosed;
  readonly interaction: RunFinished;
  /** Internal evidence for Core's audit; never exposed to the user. */
  readonly publishError?: unknown;
}

/** Build both terminal events from one outcome, even if the summary cannot be persisted. */
export async function finalizeRunEvents(
  summary: RunSummary,
  publish: ExecutionDuties['publishRunSummary'],
): Promise<FinalRunEvents> {
  const outcome =
    summary.closeReason === 'COMPLETED'
      ? { closeReason: summary.closeReason, reportRef: summary.reportRef }
      : summary.closeReason === 'FAILED' || summary.closeReason === 'VIOLATION'
        ? { closeReason: summary.closeReason, failure: summary.failure }
        : { closeReason: summary.closeReason };
  let ending:
    | { readonly runSummaryRef: Awaited<ReturnType<typeof publish>> }
    | {
        readonly finalizationError: 'RUN_SUMMARY_WRITE_FAILED';
      };
  let publishError: unknown;
  let publicationFailed = false;
  try {
    ending = { runSummaryRef: await publish(summary) };
  } catch (error) {
    publicationFailed = true;
    publishError = error;
    ending = { finalizationError: 'RUN_SUMMARY_WRITE_FAILED' };
  }
  const fields = { ...outcome, unknownEffects: summary.unknownEffects, ...ending };
  return {
    workflow: assertValid<RunClosed>(RunClosedSchema, { type: 'RunClosed', ...fields }),
    interaction: assertValid<RunFinished>(RunFinishedSchema, { type: 'RunFinished', ...fields }),
    ...(publicationFailed ? { publishError } : {}),
  };
}
