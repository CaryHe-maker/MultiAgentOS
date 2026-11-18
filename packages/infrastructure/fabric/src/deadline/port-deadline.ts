import { FabricError } from '../in-process/fabric-error.js';

/**
 * Rejects with `FabricError(REQUEST_TIMEOUT)` once `timeoutMs` has passed (Fabric.md 3). The
 * deadline stops the wait only: a late result or rejection is received and discarded, and
 * nothing proves that the operation did not happen.
 */
export async function withinDeadline<T>(
  task: Promise<T>,
  timeoutMs: number | undefined,
  detail: string,
): Promise<T> {
  if (timeoutMs === undefined) return task;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Promise.race observes the task, so a late rejection is never left unhandled.
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FabricError('REQUEST_TIMEOUT', detail)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
