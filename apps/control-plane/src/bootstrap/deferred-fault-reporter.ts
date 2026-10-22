import type { SystemFault, SystemFaultReporter } from '@multiagentos/contracts';

export interface DeferredFaultReporter {
  /** Accepts faults before the composed system exists; buffers them for the target. */
  readonly report: SystemFaultReporter;
  /** Hands buffered faults to the real panic entry and forwards later ones to it. */
  bind(target: SystemFaultReporter): void;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The composition root's pre-boot fault entry (`docs/M1/SystemFaultHandling.md` 4).
 * Configuration, Catalog and factory failures can happen before `SystemControl` exists;
 * buffering them keeps the entry valid instead of installing an empty reporter first.
 */
export function createDeferredFaultReporter(
  log: (line: string) => void = (line) => void process.stderr.write(line),
): DeferredFaultReporter {
  const pending: SystemFault[] = [];
  let target: SystemFaultReporter | undefined;

  const write = (fault: SystemFault): void => {
    try {
      log(`system fault [${fault.phase}] ${fault.source}: ${describe(fault.error)}\n`);
    } catch {
      // A diagnostic failure must not prevent the buffered fault from reaching the system.
    }
  };

  const forward = (fault: SystemFault): void => {
    if (target !== undefined) {
      try {
        target(fault);
      } catch {
        // SystemFaultReporter is required to return without throwing; a broken target still
        // must not create an unhandled rejection during composition.
        write(fault);
      }
      return;
    }
    pending.push(fault);
    write(fault);
  };

  return {
    report: forward,
    bind: (next) => {
      target = next;
      for (const fault of pending.splice(0)) forward(fault);
    },
  };
}
