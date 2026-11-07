import type { ExecutionRequest, ModelProgress, ModelProgressEvent } from '@multiagentos/contracts';
import { MODEL_PROGRESS_MAX_DELTA } from '@multiagentos/contracts';

/** Pieces of thinking that come within this time go out as one message. */
export const PROGRESS_COALESCE_MS = 50;

/**
 * What a model call tells while it streams (docs/M2/Phase1Console.md 4), as messages for the
 * person watching: small pieces merged into one every few milliseconds, so a provider that sends a
 * word at a time costs a handful of messages a second. The END of the stream goes out at once,
 * after whatever is still held. It only reports; nothing it does can reach the call.
 */
export function modelProgressOf(
  request: ExecutionRequest,
  report: (progress: ModelProgress) => void,
  now: () => Date,
): (event: ModelProgressEvent) => void {
  const base = () => ({
    sessionId: request.sessionId,
    workflowRunId: request.workflowRunId,
    executionId: request.executionId,
    at: now().toISOString(),
  });
  let held = '';
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    while (held.length > 0) {
      const delta = held.slice(0, MODEL_PROGRESS_MAX_DELTA);
      held = held.slice(MODEL_PROGRESS_MAX_DELTA);
      report({ ...base(), kind: 'REASONING', delta });
    }
  };
  return (event) => {
    if (event.kind === 'REASONING') {
      held += event.delta;
      if (held.length >= MODEL_PROGRESS_MAX_DELTA) flush();
      else {
        timer ??= setTimeout(flush, PROGRESS_COALESCE_MS);
        timer.unref();
      }
      return;
    }
    flush();
    report({ ...base(), kind: 'END' });
  };
}
