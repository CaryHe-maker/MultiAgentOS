import type { ExecutionRequest, ModelProgress, ModelProgressEvent } from '@multiagentos/contracts';
import { MODEL_PROGRESS_MAX_DELTA } from '@multiagentos/contracts';

/** Pieces that come within this time go out as one message. */
export const PROGRESS_COALESCE_MS = 40;

/**
 * What a model call tells while it streams (docs/M2/Phase1Console.md 4), as messages for the
 * person watching: small pieces merged into one every few milliseconds, so a provider that sends a
 * word at a time costs a few dozen messages a second at most. Thinking and the text written for the
 * user are kept apart and in the order they came: a change of kind sends what is held first. The
 * END of the stream goes out at once, after whatever is still held. It only reports; nothing it
 * does can reach the call.
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
  let heldKind: 'REASONING' | 'TEXT' = 'REASONING';
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    while (held.length > 0) {
      const delta = held.slice(0, MODEL_PROGRESS_MAX_DELTA);
      held = held.slice(MODEL_PROGRESS_MAX_DELTA);
      report({ ...base(), kind: heldKind, delta });
    }
  };
  return (event) => {
    if (event.kind === 'END') {
      flush();
      report({ ...base(), kind: 'END' });
      return;
    }
    if (event.kind !== heldKind) flush();
    heldKind = event.kind;
    held += event.delta;
    if (held.length >= MODEL_PROGRESS_MAX_DELTA) flush();
    else {
      timer ??= setTimeout(flush, PROGRESS_COALESCE_MS);
      timer.unref();
    }
  };
}
