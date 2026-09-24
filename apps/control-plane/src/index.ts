import { join } from 'node:path';
import { BuiltInCatalog } from '@multiagentos/agent-tool-pool';
import { LocalArtifactStore } from '@multiagentos/artifacts';
import { InMemoryMessageRouter } from '@multiagentos/communication';
import { LocalContextEngine } from '@multiagentos/context-engine';
import { Kernel } from '@multiagentos/kernel';
import { ModuleHost, simpleLifecycle } from '@multiagentos/module-host';
import { FileRepository, persistenceCapabilities } from '@multiagentos/persistence';
import { UserInteractionService } from '@multiagentos/user-interaction';
import { WorkflowService } from '@multiagentos/workflow';
import { createM1ProtocolRegistry } from '@multiagentos/contracts';
import { LocalReadExecutor } from '@multiagentos/executor';

export interface M1Runtime {
  readonly host: ModuleHost;
  readonly interaction: UserInteractionService;
  readonly workflow: WorkflowService;
  readonly kernel: Kernel;
  readonly router: InMemoryMessageRouter;
  readonly protocols: ReturnType<typeof createM1ProtocolRegistry>;
  readonly runRepository: FileRepository<{ readonly id: string; readonly value: unknown }>;
}

export function createM1Runtime(stateRoot: string): M1Runtime {
  const protocols = createM1ProtocolRegistry();
  const catalog = new BuiltInCatalog();
  const workflow = new WorkflowService(catalog);
  const artifacts = new LocalArtifactStore(join(stateRoot, 'artifacts'));
  const context = new LocalContextEngine();
  const kernel = new Kernel(workflow, context, artifacts, new LocalReadExecutor(artifacts));
  const interaction = new UserInteractionService(kernel);
  const router = new InMemoryMessageRouter();
  const runRepository = new FileRepository<{ readonly id: string; readonly value: unknown }>(
    join(stateRoot, 'runs'),
  );
  void persistenceCapabilities();
  const host = new ModuleHost();
  for (const module of [
    simpleLifecycle('contracts'),
    simpleLifecycle('communication', ['contracts']),
    simpleLifecycle('persistence', ['contracts']),
    simpleLifecycle('artifacts', ['contracts']),
    simpleLifecycle('agent-tool-pool', ['contracts']),
    simpleLifecycle('context-engine', ['contracts']),
    simpleLifecycle('workflow', ['contracts', 'agent-tool-pool']),
    simpleLifecycle('kernel', ['contracts', 'workflow', 'context-engine']),
    simpleLifecycle('user-interaction', ['contracts', 'kernel']),
  ])
    host.register(module);
  return Object.freeze({ host, interaction, workflow, kernel, router, protocols, runRepository });
}
