export const PORT_RETURN_TIMEOUT_MS = 30_000;

/** Stops waiting without asserting that the remote operation was cancelled. */
export async function awaitPort<T>(operation: string, task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Interaction port return deadline exceeded: ${operation}`)),
          PORT_RETURN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
