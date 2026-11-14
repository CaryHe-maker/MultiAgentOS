import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
} from '@multiagentos/agent-tool-pool';
import { GlobalArtifactStore } from '@multiagentos/artifacts';
import {
  ArtifactOwnerLineSchema,
  COMPACTION_SECTIONS,
  COMPACTION_STRICT_SUFFIX,
  SessionIndexLineSchema,
  SessionRefLineSchema,
  TrustedInstructionLineSchema,
  TrustedWebSearchLineSchema,
  canonicalJson,
  commandsOffered as commandsOfferedFor,
  createProtocolRegistry,
  newId,
  sha256Hex,
  type DefinitionRef,
  type ExecutorRegistry,
  type PersistenceNamespace,
  type PinnedDefinitionSet,
  type ProviderCredentials,
  type SessionPersistencePort,
  type StoragePath,
  type SystemFault,
  type SystemFaultReporter,
  type TemplateDefinition,
} from '@multiagentos/contracts';
import {
  createExecutorRegistry,
  createCommandAnalyzer,
  createCommandParser,
  createShadowFiles,
  createWorkspaceFiles,
  readRepositoryText,
} from '@multiagentos/executor-set';
import {
  InProcessFabric,
  createInteractionGatewayPort,
  createWorkflowGatewayPort,
  serveInteractionInbox,
  serveModelStream,
  serveWorkflowInbox,
} from '@multiagentos/fabric';
import {
  createSessionGatewayModule,
  createSessionKernelCore,
  createSubprocessRunner,
  createSupervisor,
  agentShareFrom,
  compactionAgentFrom,
  pinAgentFrom,
  probeSandbox,
  type MemorySample,
  type SandboxProbe,
  type TrackedSubprocessRunner,
} from '@multiagentos/kernel';
import { ModuleHost } from '@multiagentos/module-host';
import { FileSessionStore } from '@multiagentos/persistence';
import {
  createUserInteraction,
  type Console,
  type ConsoleView,
} from '@multiagentos/user-interaction';
import { agentBindingOf, createWorkflow } from '@multiagentos/workflow';
import { assertStartupChecks } from '../config/startup-checks.js';
import { assertSystemConfig, ConfigError, type SystemConfig } from '../config/system-config.js';
import { createDeferredFaultReporter } from './deferred-fault-reporter.js';
import { createSystemControl, type ShutdownTimeouts, type StopReport } from './system-control.js';

/** One module's `stop()` may take this long before ModuleHost records it as failed. */
const MODULE_STOP_TIMEOUT_MS = 5000;
/** One module's `start()` and `afterStart` may take this long together. */
const MODULE_START_TIMEOUT_MS = 10000;
/** The whole Supervisor boot; a late completion is not allowed to reopen the system. */
const BOOT_TIMEOUT_MS = 60000;

export interface ComposeOptions {
  readonly config: SystemConfig;
  /** This process's repository, already resolved with realpath (M2Design 2.3). */
  readonly repositoryRoot: string;
  readonly preset: 'standard' | 'readonly';
  readonly view: ConsoleView;
  readonly credentials: ProviderCredentials;
  /** Defaults to the catalog shipped in `agent-tool-pool/definitions`. */
  readonly catalog?: DefinitionCatalog;
  /** Defaults to ExecutorSet; an acceptance test passes scripted ones. */
  readonly executors?: ExecutorRegistry;
  readonly now?: () => Date;
  /** Deadlines of the shutdown paths; the defaults follow `config.kernel`. */
  readonly timeouts?: Partial<ShutdownTimeouts>;
  /** Local fault diagnostics; defaults to stderr. */
  readonly log?: (line: string) => void;
  /** What the sandbox probe found; a test gives its own so that it does not depend on the host. */
  readonly sandboxProbe?: SandboxProbe;
  /** Where memory is read; a test gives its own so that pressure can be made to order. */
  readonly memorySample?: () => MemorySample;
  /** The runner owned by the entry so it can kill children even if composition fails. */
  readonly subprocess?: TrackedSubprocessRunner;
  /** Composition-time fault entry; the entry buffers faults until SystemControl is bound. */
  readonly reportSystemFault?: SystemFaultReporter;
}

export interface System {
  /**
   * Starts the Supervisor only; it boots every other module (ModuleHost 2). When the boot
   * fails, everything already started is stopped before this rejects.
   */
  start(): Promise<void>;
  readonly console: Console;
  /** The built-in template with this id, as `mas run` starts it. */
  templateRef(id: string): DefinitionRef | undefined;
  whenStopped(): Promise<void>;
  /**
   * Runs one command to its end and resolves with the process exit code only after every
   * module stopped, whether the command returned, threw, or the system faulted meanwhile.
   */
  run(command: (console: Console) => Promise<number>): Promise<number>;
  /** The system fault entry; it starts a bounded shutdown. */
  reportFault(fault: SystemFault): void;
  shutdown(): Promise<StopReport>;
  /** Synchronous; for the process guards of the entry. */
  killSubprocesses(): void;
}

/** A view of the store limited to the namespaces of one owner (Interface/Persistence 5). */
function forNamespaces(
  store: SessionPersistencePort,
  owned: readonly PersistenceNamespace[],
): SessionPersistencePort {
  const assertOwner = (namespace: PersistenceNamespace): void => {
    if (!owned.includes(namespace)) throw new Error(`Namespace ${namespace} is not owned here`);
  };
  const limited: SessionPersistencePort = {
    appendLog: <T>(namespace: PersistenceNamespace, path: StoragePath) => {
      assertOwner(namespace);
      return store.appendLog<T>(namespace, path);
    },
    sessionDirectory: (namespace, sessionId) => {
      assertOwner(namespace);
      return store.sessionDirectory(namespace, sessionId);
    },
    capabilities: () => store.capabilities(),
  };
  return Object.freeze(limited);
}

/**
 * The built-ins of this process (Module/Workflow 4): the Agent `main`, the templates, and every
 * Agent a template names, each at the version the catalog pins.
 */
function builtIns(catalog: DefinitionCatalog) {
  const context = { correlationId: newId('cor'), tenantId: 'local', projectId: 'local' };
  const templates = catalog
    .list()
    .filter((each): each is TemplateDefinition => each.kind === 'TEMPLATE');
  const main = catalog.latest('AGENT', 'main');
  if (main === undefined) throw new ConfigError('the built-in Agent main is missing');
  // The Agents `run_subagents` may start are built in with main, whatever the template (M2Design 3.9).
  const spawnable = catalog
    .list()
    .filter((each) => each.kind === 'AGENT' && each.spawnable !== undefined)
    .map(({ id, version }) => ({ id, version }));
  const refs = [
    { id: main.id, version: main.version },
    ...spawnable,
    ...templates.flatMap((template) =>
      template.nodes.flatMap((node) => (node.kind === 'AGENT' ? [node.agent] : [])),
    ),
  ];
  const sets = new Map<string, PinnedDefinitionSet>();
  for (const ref of refs) {
    const pinned = catalog.pinAgent(ref, context);
    if (!pinned.ok) throw new ConfigError(`cannot pin Agent ${ref.id}@${ref.version}`);
    sets.set(ref.id, pinned.value);
  }
  const definitions = catalog.list();
  return {
    sets,
    templates: new Map(templates.map((template) => [template.id, template])),
    definitionsDigest: sha256Hex(canonicalJson(definitions.map((each) => each.digest).sort())),
    definitionVersions: definitions.map((each) => `${each.id}@${each.version}`).sort(),
  };
}

/**
 * The only place that knows several concrete implementations. It builds every module, gives
 * each communication subject its own Fabric client and Port stubs, registers the modules with
 * ModuleHost and hands the host to the Supervisor. Nothing is started here.
 */
export async function composeSystem(options: ComposeOptions): Promise<System> {
  const config = assertSystemConfig(options.config);
  const now = options.now ?? (() => new Date());
  const registry = createProtocolRegistry();
  const catalog =
    options.catalog ??
    (await DefinitionCatalog.load(new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY)));
  const builtin = builtIns(catalog);
  // The instruction of the summary request of a compaction: without the Prompt nothing is compacted.
  const compactionDefinition = catalog.latest('PROMPT', 'compaction-system');
  const compactionPrompt =
    compactionDefinition?.kind === 'PROMPT'
      ? {
          instruction: compactionDefinition.template,
          strictSuffix: COMPACTION_STRICT_SUFFIX,
          requiredSections: [...COMPACTION_SECTIONS],
        }
      : undefined;
  assertStartupChecks(config.kernel, [...builtin.sets.values()], registry, options.credentials);
  const main = builtin.sets.get('main');
  if (main === undefined) throw new ConfigError('the built-in Agent main is missing');

  const subprocess = options.subprocess ?? createSubprocessRunner();
  // Writes rest on snapshots, and snapshots on git: without it the system only reads (M2Design 4.6).
  const log = options.log ?? ((line: string) => void process.stderr.write(line));
  const probe = await subprocess.run('git', ['--version'], {
    cwd: options.repositoryRoot,
    signal: new AbortController().signal,
    maxOutputBytes: 1024,
    env: {},
  });
  const hasGit = probe.exitCode === 0;
  const preset = hasGit ? options.preset : 'readonly';
  if (!hasGit && options.preset !== 'readonly')
    log('git was not found, so this session is read-only: nothing can be written or undone.\n');
  // Commands run isolated or not at all (M2Design 6.2): the probe decides once for the process.
  const sandbox = options.sandboxProbe ?? (await probeSandbox(options.repositoryRoot));
  if (!sandbox.available && preset !== 'readonly')
    log(`Commands cannot run isolated here (${sandbox.reason}). ${sandbox.hint}
`);
  const commandsOffered = commandsOfferedFor(sandbox.available, config.kernel.sandbox.unavailable);
  const analyzeCommand = createCommandAnalyzer(await createCommandParser(), config.kernel.command);
  const snapshotsOf = (sessionId: string): string =>
    join(config.dataDir, 'sessions', sessionId, 'kernel-execution', 'snapshots');
  const internalFaults =
    options.reportSystemFault === undefined ? createDeferredFaultReporter(options.log) : undefined;
  const reportSystemFault: SystemFaultReporter =
    options.reportSystemFault ?? ((fault) => internalFaults?.report(fault));

  try {
    const fabric = new InProcessFabric(registry, now);
    const artifacts = new GlobalArtifactStore(config.dataDir);
    const persistence = new FileSessionStore(config.dataDir, {
      'session-index': SessionIndexLineSchema,
      'session-refs': SessionRefLineSchema,
      'trusted-instructions': TrustedInstructionLineSchema,
      'trusted-web-search': TrustedWebSearchLineSchema,
      'artifact-owners': ArtifactOwnerLineSchema,
    });

    // The interface is built after the Kernel, which may need it before the system is up.
    const interaction: { console?: Console } = {};
    const kernelCore = createSessionKernelCore({
      fabric: fabric.client('kernel-core'),
      artifacts,
      persistence: forNamespaces(persistence, ['kernel-core', 'kernel-execution']),
      registry,
      pinAgent: pinAgentFrom(catalog, registry),
      compactionAgent: compactionAgentFrom(catalog, registry, {
        preset,
        commands: commandsOffered,
      }),
      agentShare: agentShareFrom(catalog),
      ...(compactionPrompt === undefined ? {} : { compactionPrompt }),
      mainBudget: main.agent.budget,
      config: config.kernel,
      repositoryRoot: options.repositoryRoot,
      preset,
      ...(preset === 'readonly'
        ? {}
        : {
            workspace: {
              files: createWorkspaceFiles(options.repositoryRoot),
              git: subprocess,
              directoryOf: snapshotsOf,
              shadowOf: (sessionId: string) => createShadowFiles(snapshotsOf(sessionId)),
            },
          }),
      readRepositoryFile: readRepositoryText,
      dataDir: config.dataDir,
      // Memory ran short and no run is open: leave in control, as the interface does when a run ends.
      onMemoryNotice: (notice) => interaction.console?.notifyMemory(notice),
      ...(options.memorySample === undefined ? {} : { memorySample: options.memorySample }),
      commands: {
        analyze: analyzeCommand,
        sandbox: () => (sandbox.available ? 'AVAILABLE' : 'UNAVAILABLE'),
        probe: sandbox.available
          ? { available: true }
          : { available: false, reason: sandbox.reason },
      },
      reportSystemFault,
      diagnostic: log,
      now,
    });
    const gateway = createSessionGatewayModule({ fabric: fabric.client('gateway'), now });

    // Workflow and UserInteraction wait for their ports at most this long; the Kernel's own
    // clients have no deadline.
    const deadline = { requestTimeoutMs: config.portReturnTimeoutMs };
    const workflowFabric = fabric.client('workflow', deadline);
    const workflow = createWorkflow({
      gateway: createWorkflowGatewayPort(workflowFabric),
      persistence: forNamespaces(persistence, ['workflow']),
      agents: new Map(
        [...builtin.sets].map(
          ([id, set]) =>
            [id, agentBindingOf(set, registry, preset, { commands: commandsOffered })] as const,
        ),
      ),
      templates: builtin.templates,
      sandbox: sandbox.available
        ? { state: 'ISOLATED' }
        : commandsOffered
          ? { state: 'UNISOLATED', reason: sandbox.reason }
          : { state: 'UNAVAILABLE', reason: sandbox.reason },
      definitionsDigest: builtin.definitionsDigest,
      definitionVersions: builtin.definitionVersions,
      config: config.workflow,
      now,
      git: inGitWorkTree(options.repositoryRoot),
      // For comparing runs with and without inherited contexts (Orchestration 3.9, D35).
      ...(process.env['MAO_INHERIT_CONTEXT'] === 'off' ? { inheritContext: false } : {}),
    });
    serveWorkflowInbox(workflowFabric, workflow.runner);

    const interactionFabric = fabric.client('user-interaction', deadline);
    const userInteraction = createUserInteraction({
      gateway: createInteractionGatewayPort(interactionFabric),
      view: options.view,
      now,
    });
    serveInteractionInbox(interactionFabric, userInteraction.console);
    // The thinking of the model calls, beside the ordered events (Phase1Console 4).
    serveModelStream(interactionFabric, (stream) =>
      userInteraction.console.handleModelStream(stream),
    );

    const moduleHost = new ModuleHost({
      startTimeoutMs: MODULE_START_TIMEOUT_MS,
      stopTimeoutMs: MODULE_STOP_TIMEOUT_MS,
    });
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
    const supervisor = createSupervisor({
      fabric: fabric.client('supervisor'),
      executors:
        options.executors ?? createExecutorRegistry({ web: { config: config.kernel.web } }),
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
        bootMs: BOOT_TIMEOUT_MS,
        // Twice the convergence backstop of Interaction 6, plus the Session close.
        abortRunsMs:
          2 * (config.kernel.cancelGraceMs + config.kernel.convergenceMarginMs) +
          config.kernel.sessionCloseTimeoutMs,
        stopMs,
        settleMs: stopMs,
        ...options.timeouts,
      },
      now,
      log: options.log ?? ((line) => void process.stderr.write(line)),
    });
    internalFaults?.bind((fault) => control.reportFault(fault));

    const { console } = userInteraction;
    interaction.console = console;
    return {
      start: () => control.start(),
      console,
      templateRef: (id) => {
        const template = builtin.templates.get(id);
        // A pre-orchestrated template runs as a specialist of a long task, never by itself (D39).
        return template === undefined || template.playbook !== undefined
          ? undefined
          : { id, version: template.version };
      },
      whenStopped: () => supervisor.whenStopped(),
      run: (command) => control.run(() => command(console)),
      reportFault: (fault) => control.reportFault(fault),
      shutdown: () => control.shutdown(),
      killSubprocesses: () => subprocess.killAll(),
    };
  } catch (error) {
    // A factory or registration can fail after the runner was created. Nothing was started,
    // so ending the children and rethrowing is the complete cleanup for this stage.
    try {
      subprocess.killAll();
    } catch {
      // The original composition error is more useful than a cleanup failure.
    }
    throw error;
  }
}

/**
 * Whether a folder lies in a git work tree: a `.git` (a folder, or the file of a worktree) in it
 * or in a folder above it. Only what the model is offered depends on it (git_inspect).
 */
export function inGitWorkTree(folder: string): boolean {
  for (let current = folder; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}
