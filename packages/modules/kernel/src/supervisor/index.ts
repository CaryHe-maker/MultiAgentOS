/** Kernel.Supervisor owns the system lifecycle and, in P08, execution dispatch. */
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type {
  ExecutorRegistry,
  FabricPort,
  HealthStatus,
  LifecyclePort,
  ProviderCredentials,
  ModuleId,
} from '@multiagentos/contracts';
import { SCHEMA_IDS } from '@multiagentos/fabric';
import type { KernelConfig } from '../interfaces/index.js';

import { createSubprocessRunner, type TrackedSubprocessRunner } from './subprocess-runner.js';

export { createSubprocessRunner, type TrackedSubprocessRunner } from './subprocess-runner.js';

export interface ModuleHostControl {
  start(afterStart?: (moduleId: ModuleId) => void | Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface SupervisorDeps {
  /** The Fabric client whose producer is `supervisor`. */
  readonly fabric: FabricPort;
  readonly executors: ExecutorRegistry;
  readonly credentials: ProviderCredentials;
  readonly moduleHost: ModuleHostControl;
  readonly config: KernelConfig;
  /** System data directory; the Supervisor empties `<dataDir>/tmp/` before anything starts. */
  readonly dataDir: string;
  /**
   * The runner handed to Executors. The composition root passes its own so that it can still
   * end the child processes when the Supervisor cannot; the default is a private runner.
   */
  readonly subprocess?: TrackedSubprocessRunner;
  readonly now?: () => Date;
}

export interface SupervisorModule extends LifecyclePort {
  whenStopped(): Promise<void>;
}

/** The temporary directory must be a direct child of an absolute data directory. */
function temporaryDirectory(dataDir: string): string {
  if (!isAbsolute(dataDir)) throw new Error('Supervisor dataDir must be absolute');
  const root = resolve(dataDir);
  const temporary = resolve(join(root, 'tmp'));
  if (relative(root, temporary) !== 'tmp')
    throw new Error('Supervisor temporary directory escapes dataDir');
  return temporary;
}

export function createSupervisor(deps: SupervisorDeps): SupervisorModule {
  const now = deps.now ?? (() => new Date());
  const subprocess = deps.subprocess ?? createSubprocessRunner();
  const registered = new Set<string>();
  let ready = false;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let settleStopped: (() => void) | undefined;
  let failStopped: ((error: unknown) => void) | undefined;
  const stopped = new Promise<void>((resolveStopped, rejectStopped) => {
    settleStopped = resolveStopped;
    failStopped = rejectStopped;
  });
  // A caller may choose to await whenStopped only after a shutdown request.
  void stopped.catch(() => undefined);

  const requireReady = (): void => {
    if (!ready) throw new Error('Supervisor is not ready');
  };

  const stop = (): Promise<void> => {
    if (stopping !== undefined) return stopping;
    ready = false;
    stopping = (async () => {
      const errors: unknown[] = [];
      try {
        await deps.moduleHost.stop();
      } catch (error) {
        errors.push(error);
      }
      // Every run has converged by now on the normal path; on a fault path nothing else will.
      subprocess.killAll();
      try {
        await rm(temporaryDirectory(deps.dataDir), { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Supervisor shutdown failed');
    })().then(
      () => settleStopped?.(),
      (error: unknown) => {
        failStopped?.(error);
        throw error;
      },
    );
    return stopping;
  };

  const register = (): void => {
    const serve = (schemaId: string, handler: () => Promise<void>): void => {
      if (registered.has(schemaId)) return;
      deps.fabric.register(schemaId, (envelope) => {
        if (envelope.producer !== 'kernel-core')
          throw new Error('Supervisor request has an invalid producer');
        requireReady();
        return handler();
      });
      registered.add(schemaId);
    };
    serve(SCHEMA_IDS.execute, () =>
      Promise.reject(new Error('NOT_IMPLEMENTED: Supervisor execution dispatch (P08)')),
    );
    serve(SCHEMA_IDS.cancelRunExecutions, () =>
      Promise.reject(new Error('NOT_IMPLEMENTED: Supervisor execution cancellation (P08)')),
    );
    serve(SCHEMA_IDS.supervisorShutdown, () => {
      ready = false;
      // Let Fabric complete this request before ModuleHost stops Fabric itself.
      setImmediate(() => {
        void stop().catch(() => undefined);
      });
      return Promise.resolve();
    });
  };

  return {
    manifest: { moduleId: 'supervisor', version: '0.1.0', dependencies: [] },
    start: () => {
      if (stopping !== undefined) return Promise.reject(new Error('Supervisor has stopped'));
      if (starting !== undefined) return starting;
      starting = (async () => {
        const temporary = temporaryDirectory(deps.dataDir);
        await rm(temporary, { recursive: true, force: true });
        await mkdir(temporary, { recursive: true });
        await deps.moduleHost.start((moduleId) => {
          if (moduleId === 'fabric') register();
        });
        ready = true;
      })();
      return starting.catch((error: unknown) => {
        starting = undefined;
        throw error;
      });
    },
    stop,
    health: (): Promise<HealthStatus> =>
      Promise.resolve({
        status: ready ? 'UP' : 'DOWN',
        checkedAt: now().toISOString(),
        details: [],
      }),
    whenStopped: () => stopped,
  };
}
