import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
} from '@multiagentos/agent-tool-pool';
import { LocalArtifactStore } from '@multiagentos/artifacts';
import {
  createM1ProtocolRegistry,
  type CatalogPort,
  type ExecutorRegistry,
  type LifecyclePort,
  type ProviderCredentials,
  type SystemFault,
} from '@multiagentos/contracts';
import { createExecutorRegistry } from '@multiagentos/executor-set';
import {
  InProcessFabric,
  createInteractionGatewayPort,
  createWorkflowGatewayPort,
  serveInteractionInbox,
  serveWorkflowInbox,
} from '@multiagentos/fabric';
import {
  createGateway,
  createKernelCore,
  createSubprocessRunner,
  createSupervisor,
  type GatewayDeps,
  type KernelCoreDeps,
  type KernelCoreModule,
  type SupervisorDeps,
  type SupervisorModule,
} from '@multiagentos/kernel';
import { ModuleHost } from '@multiagentos/module-host';
import { FilePersistence, forPersistenceNamespace } from '@multiagentos/persistence';
import {
  createUserInteraction,
  type TerminalPort,
  type UserInteractionDeps,
  type UserInteractionModule,
} from '@multiagentos/user-interaction';
import { createWorkflow, type WorkflowDeps, type WorkflowModule } from '@multiagentos/workflow';
import { assertSystemConfig, type SystemConfig } from '../config/system-config.js';
import { createSystemControl, type ShutdownTimeouts, type StopReport } from './system-control.js';

/** One module's `stop()` may take this long before ModuleHost records it as failed. */
const MODULE_STOP_TIMEOUT_MS = 5000;

/**
 * The factories of everything that is not infrastructure. Their signatures are the seams
 * between the parallel work streams: a test replaces any of them with a fake from
 * `@multiagentos/testing` and runs the rest for real.
 */
export interface SystemParts {
  readonly createGateway: (deps: GatewayDeps) => LifecyclePort;
  readonly createKernelCore: (deps: KernelCoreDeps) => KernelCoreModule;
  readonly createSupervisor: (deps: SupervisorDeps) => SupervisorModule;
  readonly createWorkflow: (deps: WorkflowDeps) => WorkflowModule;
  readonly createUserInteraction: (deps: UserInteractionDeps) => UserInteractionModule;
  readonly createExecutorRegistry: () => ExecutorRegistry;
}

export const PRODUCT_PARTS: SystemParts = Object.freeze({
  createGateway,
  createKernelCore,
  createSupervisor,
  createWorkflow,
  createUserInteraction,
  createExecutorRegistry,
});

export interface ComposeOptions {
  readonly config: SystemConfig;
  readonly terminal: TerminalPort;
  readonly credentials: ProviderCredentials;
  readonly parts?: Partial<SystemParts>;
  /** Defaults to the catalog shipped in `agent-tool-pool/definitions`. */
  readonly catalog?: CatalogPort;
  readonly now?: () => Date;
  /** Deadlines of the shutdown paths; the defaults follow `config.kernel`. */
  readonly timeouts?: Partial<ShutdownTimeouts>;
  /** Local fault diagnostics; defaults to stderr. */
  readonly log?: (line: string) => void;
}

export interface System {
  /**
   * Starts the Supervisor only; it boots every other module (ModuleHost 2). When the boot
   * fails, everything already started is stopped before this rejects.
   */
  start(): Promise<void>;
  readonly userInteraction: UserInteractionModule;
  /** Resolves after a shutdown request stopped every module. */
  whenStopped(): Promise<void>;
  /**
   * Runs one command to its end and resolves with the process exit code only after every
   * module stopped, whether the command returned, threw, or the system faulted meanwhile.
   */
  run(command: (userInteraction: UserInteractionModule) => Promise<number>): Promise<number>;
  /** The system fault entry (docs/SystemFaultHandling.md 2); it starts a bounded shutdown. */
  reportFault(fault: SystemFault): void;
  shutdown(): Promise<StopReport>;
  /** Synchronous; for the process guards of the entry. */
  killSubprocesses(): void;
}

/**
 * The only place that knows several concrete implementations. It builds every module, gives
 * each communication subject its own Fabric client and Port stubs, registers the modules with
 * ModuleHost and hands the host to the Supervisor. Nothing is started here. The returned
 * `System` is the process-level control (`system-control.ts`), not a module.
 */
export async function composeSystem(options: ComposeOptions): Promise<System> {
  const config = assertSystemConfig(options.config);
  const parts: SystemParts = { ...PRODUCT_PARTS, ...options.parts };
  const now = options.now ?? (() => new Date());
  const registry = createM1ProtocolRegistry();
  const catalog =
    options.catalog ??
    (await DefinitionCatalog.load(new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY)));

  // Built before any module so that a module can hold the reporter; it is bound further down.
  let reportFault: (fault: SystemFault) => void = () => undefined;
  const reportSystemFault = (fault: SystemFault): void => reportFault(fault);

  const fabric = new InProcessFabric(registry, now);
  const artifacts = new LocalArtifactStore(config.dataDir);
  const persistence = new FilePersistence(config.dataDir);

  const kernelCore = parts.createKernelCore({
    fabric: fabric.client('kernel-core'),
    catalog,
    artifacts,
    persistence: forPersistenceNamespace(persistence, 'kernel-core'),
    registry,
    config: config.kernel,
    dataDir: config.dataDir,
    reportSystemFault,
    now,
  });
  const gateway = parts.createGateway({ fabric: fabric.client('gateway'), now });

  const workflowFabric = fabric.client('workflow');
  const workflow = parts.createWorkflow({
    gateway: createWorkflowGatewayPort(workflowFabric),
    catalog,
    persistence: forPersistenceNamespace(persistence, 'workflow'),
    registry,
    config: config.workflow,
    reportSystemFault,
    now,
  });
  serveWorkflowInbox(workflowFabric, workflow.inbox);

  const interactionFabric = fabric.client('user-interaction');
  const userInteraction = parts.createUserInteraction({
    gateway: createInteractionGatewayPort(interactionFabric),
    terminal: options.terminal,
    reportSystemFault,
    now,
  });
  serveInteractionInbox(interactionFabric, userInteraction.inbox);

  const moduleHost = new ModuleHost({ stopTimeoutMs: MODULE_STOP_TIMEOUT_MS });
  for (const module of [
    fabric,
    artifacts,
    persistence,
    kernelCore,
    gateway,
    workflow,
    userInteraction,
  ])
    moduleHost.register(module);

  // The root keeps the runner so that it can end the child processes without the Supervisor.
  const subprocess = createSubprocessRunner();
  const supervisor = parts.createSupervisor({
    fabric: fabric.client('supervisor'),
    executors: parts.createExecutorRegistry(),
    credentials: options.credentials,
    moduleHost,
    config: config.kernel,
    dataDir: config.dataDir,
    subprocess,
    now,
  });

  const stopMs = MODULE_STOP_TIMEOUT_MS * (moduleHost.startOrder().length + 2);
  const control = createSystemControl({
    supervisor,
    kernelCore,
    moduleHost,
    killSubprocesses: () => subprocess.killAll(),
    timeouts: {
      // Twice the convergence backstop of Interaction 6, to leave room for the final events.
      abortRunsMs: 2 * (config.kernel.cancelGraceMs + config.kernel.convergenceMarginMs),
      stopMs,
      settleMs: stopMs,
      ...options.timeouts,
    },
    now,
    log: options.log ?? ((line) => void process.stderr.write(line)),
  });
  reportFault = (fault) => control.reportFault(fault);

  return {
    start: () => control.start(),
    userInteraction,
    whenStopped: () => supervisor.whenStopped(),
    run: (command) => control.run(() => command(userInteraction)),
    reportFault: (fault) => control.reportFault(fault),
    shutdown: () => control.shutdown(),
    killSubprocesses: () => subprocess.killAll(),
  };
}
