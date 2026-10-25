/**
 * Ends the local wait for a control request when `signal` fires, without asserting that the
 * request was cancelled. The port deadline itself is enforced by this module's Fabric client.
 */
export async function awaitControl<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
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
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
