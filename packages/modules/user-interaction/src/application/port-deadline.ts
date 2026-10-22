export const PORT_RETURN_TIMEOUT_MS = 30_000;

/** Stops waiting without asserting that the remote operation was cancelled. */
export async function awaitPort<T>(
  operation: string,
  task: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        if (signal === undefined) return;
        onAbort = () => {
          const reason: unknown = signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new Error('Local port wait stopped', {
                  cause: reason,
                }),
          );
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Interaction port return deadline exceeded: ${operation}`)),
          PORT_RETURN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}
