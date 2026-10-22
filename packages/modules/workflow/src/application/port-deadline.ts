export const PORT_RETURN_TIMEOUT_MS = 30_000;

/** A deadline stops waiting; it does not prove that the remote operation stopped. */
export class PortDeadlineError extends Error {
  constructor(readonly operation: string) {
    super(`Workflow port return deadline exceeded: ${operation}`);
  }
}

/** Observes late rejection while discarding late values after the deadline. */
export async function awaitPort<T>(operation: string, task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PortDeadlineError(operation)), PORT_RETURN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
