import type {
  AdmissionProjection,
  ArtifactRef,
  ArtifactStorePort,
  CatalogPort,
  KernelConfig,
  ProtocolRegistry,
  SystemFaultReporter,
} from '@multiagentos/contracts';
import {
  CoreRequestHandler,
  type AuditSink,
  type CoreEventSink,
  type CoreExecutionPort,
  type CoreSupervisorPort,
  type RunState,
} from '../core/index.js';
import { Execution, type AttemptDispatcher } from '../execution/index.js';
import type { ProviderCapacityPort } from '../interfaces/index.js';
import { Monitor } from '../monitor/index.js';
import { Scheduler } from '../scheduler/index.js';
import type { RunProcessor } from './actor.js';
import type { RunEgress } from './egress.js';
import type { RunMessage, RunResponse } from './messages.js';

export interface KernelRunDeps {
  readonly run: RunState;
  readonly catalog: CatalogPort;
  readonly registry: ProtocolRegistry;
  readonly artifacts: ArtifactStorePort;
  readonly config: KernelConfig;
  readonly audit: AuditSink;
  /** One of `dispatcher` or `egress` must be supplied. */
  readonly dispatcher?: AttemptDispatcher;
  readonly capacity: ProviderCapacityPort;
  readonly events?: CoreEventSink;
  /** Egress supplies the dispatcher, events, admission and Supervisor cancel together. */
  readonly egress?: RunEgress;
  readonly admission?: (projection: AdmissionProjection) => void;
  readonly supervisor?: CoreSupervisorPort;
  readonly onRunClosed?: (run: RunState) => void;
  readonly reportSystemFault?: SystemFaultReporter;
  readonly now?: () => Date;
  readonly newAttemptId?: () => string;
  readonly newExecutionId?: () => string;
  /** Lets the actor flush events settled after an asynchronous dispatch has returned. */
  readonly onSettled?: () => void;
}

/**
 * The per-run processor that connects the actor to Core and Execution. It does not own the
 * actor itself; stage 4.5 creates the actor around this object, and the actor calls `settle`
 * after each message.
 */
export class KernelRunProcessor implements RunProcessor {
  readonly #run: RunState;
  readonly #core: CoreRequestHandler;
  readonly #execution: Execution;

  public constructor(run: RunState, core: CoreRequestHandler, execution: Execution) {
    this.#run = run;
    this.#core = core;
    this.#execution = execution;
  }

  public dispatch(message: RunMessage): Promise<RunResponse | void> {
    switch (message.kind) {
      case 'RUN_INIT':
        return this.#core.startRun(this.#run);
      case 'FORWARD':
        return this.#core.handleForward(message.forward, message.context, this.#run);
      case 'EXECUTION_FACT':
        return this.#execution.handleExecutionFact(message.fact);
      case 'CANCEL_RUN':
        return this.#core.beginShutdown(this.#run);
      case 'RUN_TIMEOUT':
        return this.#core.runTimedOut(this.#run);
      case 'AUTHORIZATION_TIMEOUT':
        return this.#core.authorizationTimedOut(this.#run);
      case 'CONVERGENCE_DEADLINE':
        return this.#core.convergenceDeadline(this.#run);
      case 'KERNEL_FAULT':
        return this.#core
          .handleCoreException(this.#run, { kind: 'KERNEL_FAULT', faultId: message.faultId })
          .then(() => undefined);
      default:
        return Promise.resolve(undefined);
    }
  }

  public settle(): Promise<void> {
    return this.#core.settleConvergence(this.#run);
  }
}

export interface KernelRun {
  readonly run: RunState;
  readonly core: CoreRequestHandler;
  readonly execution: Execution;
  readonly processor: KernelRunProcessor;
}

/**
 * Builds the per-run Core, Execution, Monitor and Scheduler chain. The execution port is
 * bound lazily because Core needs it before Execution can receive Core's syscall surface.
 */
export function createKernelRun(deps: KernelRunDeps): KernelRun {
  const dispatcher = deps.dispatcher ?? deps.egress;
  if (dispatcher === undefined) throw new Error('A dispatcher or egress is required');
  const events = deps.events ?? deps.egress;
  const supervisor = deps.supervisor ?? deps.egress;
  const admission =
    deps.admission ??
    (deps.egress === undefined
      ? undefined
      : (projection: AdmissionProjection) => deps.egress?.admission(projection));
  const monitor = new Monitor(deps.config.budget);
  const scheduler = new Scheduler(deps.capacity);
  const holder: { execution?: Execution } = {};

  const requireExecution = (): Execution => {
    if (holder.execution === undefined) throw new Error('Execution is not initialized');
    return holder.execution;
  };
  const executionPort: CoreExecutionPort = {
    createAttempt: (spec) => requireExecution().createAttempt(spec),
    abortQueued: () => requireExecution().abortQueued(),
    synthesizeStopUnconfirmed: (executionIds) =>
      requireExecution().synthesizeStopUnconfirmed(executionIds),
    ownsArtifact: (ref: ArtifactRef) => requireExecution().ownsArtifact(ref),
    readArtifact: (ref) => requireExecution().readArtifact(ref),
    collectUnknownEffects: () => requireExecution().collectUnknownEffects(),
    modelRequestCount: () => requireExecution().modelRequestCount(),
    publishRunSummary: (summary) => requireExecution().publishRunSummary(summary),
  };

  const core = new CoreRequestHandler({
    catalog: deps.catalog,
    registry: deps.registry,
    execution: executionPort,
    monitor,
    scheduler,
    audit: deps.audit,
    config: deps.config,
    ...(events === undefined ? {} : { events }),
    ...(admission === undefined ? {} : { admission }),
    ...(supervisor === undefined ? {} : { supervisor }),
    ...(deps.onRunClosed === undefined ? {} : { onRunClosed: deps.onRunClosed }),
    ...(deps.reportSystemFault === undefined ? {} : { reportSystemFault: deps.reportSystemFault }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  const execution = new Execution({
    core: core.coreSyscalls(deps.run),
    dispatcher,
    workflowRunId: deps.run.workflowRunId,
    artifacts: deps.artifacts,
    config: deps.config,
    registry: deps.registry,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.newAttemptId === undefined ? {} : { newAttemptId: deps.newAttemptId }),
    ...(deps.newExecutionId === undefined ? {} : { newExecutionId: deps.newExecutionId }),
    ...(deps.onSettled === undefined ? {} : { onSettled: deps.onSettled }),
  });
  holder.execution = execution;

  return {
    run: deps.run,
    core,
    execution,
    processor: new KernelRunProcessor(deps.run, core, execution),
  };
}
