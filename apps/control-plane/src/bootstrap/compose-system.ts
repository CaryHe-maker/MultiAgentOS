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
  createSupervisor,
  type GatewayDeps,
  type KernelCoreDeps,
  type SupervisorDeps,
  type SupervisorModule,
} from '@multiagentos/kernel';
import { ModuleHost } from '@multiagentos/module-host';
import { FilePersistence } from '@multiagentos/persistence';
import {
  createUserInteraction,
  type TerminalPort,
  type UserInteractionDeps,
  type UserInteractionModule,
} from '@multiagentos/user-interaction';
import { createWorkflow, type WorkflowDeps, type WorkflowModule } from '@multiagentos/workflow';
import { assertSystemConfig, type SystemConfig } from '../config/system-config.js';

/**
 * The factories of everything that is not infrastructure. Their signatures are the seams
 * between the parallel work streams: a test replaces any of them with a fake from
 * `@multiagentos/testing` and runs the rest for real.
 */
export interface SystemParts {
  readonly createGateway: (deps: GatewayDeps) => LifecyclePort;
  readonly createKernelCore: (deps: KernelCoreDeps) => LifecyclePort;
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
}

export interface System {
  /** Starts the Supervisor only; it boots every other module (ModuleHost 2). */
  start(): Promise<void>;
  readonly userInteraction: UserInteractionModule;
  /** Resolves after a shutdown request stopped every module. */
  whenStopped(): Promise<void>;
}

/**
 * The only place that knows several concrete implementations. It builds every module, gives
 * each communication subject its own Fabric client and Port stubs, registers the modules with
 * ModuleHost and hands the host to the Supervisor. Nothing is started here.
 */
export async function composeSystem(options: ComposeOptions): Promise<System> {
  const config = assertSystemConfig(options.config);
  const parts: SystemParts = { ...PRODUCT_PARTS, ...options.parts };
  const now = options.now ?? (() => new Date());
  const registry = createM1ProtocolRegistry();
  const catalog =
    options.catalog ??
    (await DefinitionCatalog.load(new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY)));

  const fabric = new InProcessFabric(registry, now);
  const artifacts = new LocalArtifactStore(config.dataDir);
  const persistence = new FilePersistence(config.dataDir);

  const kernelCore = parts.createKernelCore({
    fabric: fabric.client('kernel-core'),
    catalog,
    artifacts,
    persistence,
    registry,
    config: config.kernel,
    dataDir: config.dataDir,
    now,
  });
  const gateway = parts.createGateway({ fabric: fabric.client('gateway'), now });

  const workflowFabric = fabric.client('workflow');
  const workflow = parts.createWorkflow({
    gateway: createWorkflowGatewayPort(workflowFabric),
    catalog,
    persistence,
    registry,
    config: config.workflow,
    now,
  });
  serveWorkflowInbox(workflowFabric, workflow.inbox);

  const interactionFabric = fabric.client('user-interaction');
  const userInteraction = parts.createUserInteraction({
    gateway: createInteractionGatewayPort(interactionFabric),
    terminal: options.terminal,
    now,
  });
  serveInteractionInbox(interactionFabric, userInteraction.inbox);

  const moduleHost = new ModuleHost();
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

  const supervisor = parts.createSupervisor({
    fabric: fabric.client('supervisor'),
    executors: parts.createExecutorRegistry(),
    credentials: options.credentials,
    moduleHost,
    config: config.kernel,
    dataDir: config.dataDir,
    now,
  });

  return {
    start: () => supervisor.start(),
    userInteraction,
    whenStopped: () => supervisor.whenStopped(),
  };
}
