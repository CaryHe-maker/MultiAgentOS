import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  ArtifactContent,
  BoundaryContext,
  CloseReason,
  CoreRejectedCode,
  ExecutionFact,
  GatewayForward,
  RunCreated,
  SyscallAck,
  SyscallRejected,
} from '@multiagentos/contracts';
import { RequestLedger } from './request-ledger.js';
import type { AuditSink } from './audit.js';
import { createRunState, type RunState } from './run-state.js';

export type RunResponse = SyscallAck | SyscallRejected | RunCreated | ArtifactContent;

/**
 * The run actor as seen by Core's cross-run registry. `run-actor/RunActor` implements this
 * structurally; keeping the interface here avoids a core -> run-actor import.
 */
export interface RunActorPort {
  start(): void;
  init(): Promise<void>;
  cancel(): Promise<void>;
  abort(faultId: string): Promise<void>;
  forward(forward: GatewayForward, context: Readonly<BoundaryContext>): Promise<RunResponse>;
  reportFact(fact: ExecutionFact): Promise<void>;
  whenClosed(): Promise<void>;
  drain(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The run-actor-facing part of Core that stage 2+ will implement. Stage 1 only installs the
 * routing seam so the registry can be tested without a real run actor.
 */
export interface RunRequestHandler {
  handleForward(
    forward: GatewayForward,
    context: Readonly<BoundaryContext>,
    run: RunState,
  ): Promise<RunResponse>;
  report?(fact: ExecutionFact, run: RunState): Promise<void>;
  shutdownRun?(run: RunState): Promise<void>;
  abortRun?(run: RunState, faultId: string): Promise<void>;
}

export interface RunRegistryDeps {
  readonly dataDir: string;
  /** Direct handler path used by unit tests and older callers. */
  readonly handler?: RunRequestHandler;
  /** Production path: builds the run actor for a new Core state block. */
  readonly createActor?: (run: RunState) => RunActorPort;
  readonly audit?: AuditSink;
  readonly auditFactory?: (workflowRunId: string) => AuditSink;
  /** Called after a normal shutdown drained the actor and its Outbox. */
  readonly onDrained?: (requestId: string) => Promise<void>;
  readonly now?: () => Date;
}

interface Tombstone {
  readonly closeReason: CloseReason;
}

/**
 * Core's only cross-run structure (docs/M1/Kernel/Interaction.md 4.1): it creates and recycles
 * the single M1 run actor, routes messages by `workflowRunId`, handles `createRun` and
 * `shutdown`, and keeps a tombstone after the actor is gone. It stores no per-run component
 * state itself; the `RunState` passed to the handler is the Core state block.
 */
export class RunRegistry {
  readonly #dataDir: string;
  readonly #handler: RunRequestHandler | undefined;
  readonly #createActor: RunRegistryDeps['createActor'];
  readonly #audit: AuditSink | undefined;
  readonly #auditFactory: RunRegistryDeps['auditFactory'];
  readonly #onDrained: RunRegistryDeps['onDrained'];
  readonly #now: () => Date;
  readonly #ledger = new RequestLedger();
  readonly #tombstones = new Map<string, Tombstone>();
  #run: RunState | undefined;
  #actor: RunActorPort | undefined;
  #hasCreatedRun = false;
  #closing = false;
  #resolvedDataDir: string | undefined;
  #shutdownStarted = false;
  #shutdownPromise: Promise<void> = Promise.resolve();

  public constructor(deps: RunRegistryDeps) {
    if (!isAbsolute(deps.dataDir)) throw new Error('dataDir must be an absolute path');
    if (deps.handler === undefined && deps.createActor === undefined)
      throw new Error('RunRegistry needs a handler or an actor factory');
    this.#dataDir = deps.dataDir;
    this.#handler = deps.handler;
    this.#createActor = deps.createActor;
    this.#audit = deps.audit;
    this.#auditFactory = deps.auditFactory;
    this.#onDrained = deps.onDrained;
    this.#now = deps.now ?? (() => new Date());
  }

  public get hasCreatedRun(): boolean {
    return this.#hasCreatedRun;
  }

  public get isClosing(): boolean {
    return this.#closing;
  }

  public async handleForward(
    forward: GatewayForward,
    context: Readonly<BoundaryContext>,
  ): Promise<RunResponse> {
    if (forward.requestType === 'createRun') return this.#createRun(forward, context);
    if (forward.requestType === 'shutdown') return this.#shutdown(forward.request);

    const workflowRunId = forward.request.workflowRunId;
    const run = this.#run;
    if (run !== undefined && run.workflowRunId === workflowRunId) {
      if (this.#actor !== undefined) return this.#actor.forward(forward, context);
      if (this.#handler !== undefined) return this.#handler.handleForward(forward, context, run);
    }
    const tombstone = this.#tombstones.get(workflowRunId);
    if (tombstone !== undefined)
      return rejected(forward.request.requestId, 'RUN_BLOCKED', tombstone.closeReason);
    return rejected(forward.request.requestId, 'RUN_NOT_FOUND');
  }

  public async report(fact: ExecutionFact): Promise<void> {
    const run = this.#run;
    if (run === undefined || run.workflowRunId !== fact.workflowRunId) return;
    if (run.runState === 'CLOSED') {
      await this.#auditFor(run.workflowRunId)?.append({
        at: this.#now().toISOString(),
        workflowRunId: run.workflowRunId,
        type: 'STALE_FACT',
        unitAttemptId: fact.unitAttemptId,
        executionId: fact.executionId,
        ...('reasonCode' in fact ? { reasonCode: fact.reasonCode } : {}),
      });
      return;
    }
    if (this.#actor !== undefined) {
      await this.#actor.reportFact(fact);
      return;
    }
    await this.#handler?.report?.(fact, run);
  }

  /** Called by Core when a run reaches CLOSED (Interaction 6 step ③). */
  public markClosed(workflowRunId: string, closeReason: CloseReason): void {
    const run = this.#run;
    if (run === undefined || run.workflowRunId !== workflowRunId)
      throw new Error('Cannot close an unknown run');
    run.runState = 'CLOSED';
    run.closeReason = closeReason;
    run.closedAt = this.#now().toISOString();
    this.#tombstones.set(workflowRunId, { closeReason });
  }

  async #createRun(
    forward: Extract<GatewayForward, { requestType: 'createRun' }>,
    context: Readonly<BoundaryContext>,
  ): Promise<RunResponse> {
    const { request } = forward;
    const lookup = this.#ledger.lookup<RunCreated>(request.requestId, request);
    if (lookup.kind === 'replay') return lookup.response;
    if (lookup.kind === 'conflict') return rejected(request.requestId, 'REQUEST_CONFLICT');

    if (this.#closing || this.#hasCreatedRun) {
      const response = rejected(request.requestId, 'RUN_LIMIT');
      this.#ledger.remember(request.requestId, request, response);
      return response;
    }

    const repositoryRoot = await this.#resolveRepositoryRoot(request.repositoryPath);
    if (repositoryRoot === undefined) {
      const response = rejected(request.requestId, 'REPOSITORY_INVALID');
      this.#ledger.remember(request.requestId, request, response);
      return response;
    }

    const run = createRunState({
      workflowRunId: forward.workflowRunId,
      correlationId: context.correlationId,
      goal: request.goal,
      repositoryRoot,
      startedAt: this.#now().toISOString(),
    });
    this.#run = run;
    this.#hasCreatedRun = true;
    await this.#auditFor(run.workflowRunId)?.append({
      at: run.startedAt,
      workflowRunId: run.workflowRunId,
      type: 'RUN_STARTED',
    });
    if (this.#createActor !== undefined) {
      const actor = this.#createActor(run);
      this.#actor = actor;
      actor.start();
      await actor.init();
    }
    const response: RunCreated = {
      requestId: request.requestId,
      outcome: 'ACCEPTED',
      workflowRunId: forward.workflowRunId,
    };
    this.#ledger.remember(request.requestId, request, response);
    return response;
  }

  #shutdown(request: Extract<GatewayForward, { requestType: 'shutdown' }>['request']): RunResponse {
    const lookup = this.#ledger.lookup<SyscallAck>(request.requestId, request);
    if (lookup.kind === 'replay') return lookup.response;
    if (lookup.kind === 'conflict') return rejected(request.requestId, 'REQUEST_CONFLICT');

    this.#closing = true;
    const response: SyscallAck = { requestId: request.requestId, outcome: 'ACCEPTED' };
    this.#ledger.remember(request.requestId, request, response);
    if (!this.#shutdownStarted) {
      this.#shutdownStarted = true;
      const run = this.#run;
      const actor = this.#actor;
      if (run !== undefined && actor !== undefined) {
        this.#shutdownPromise = (async () => {
          await actor.cancel();
          await actor.whenClosed();
          await actor.drain();
          this.#rememberTombstone(run);
          await this.#onDrained?.(request.requestId);
        })();
      } else if (run !== undefined && this.#handler?.shutdownRun !== undefined) {
        this.#shutdownPromise = this.#handler.shutdownRun(run).then(() => {
          this.#rememberTombstone(run);
          return this.#onDrained?.(request.requestId);
        });
      } else {
        if (run !== undefined) this.#rememberTombstone(run);
        this.#shutdownPromise = this.#onDrained?.(request.requestId) ?? Promise.resolve();
      }
    }
    return response;
  }

  /** Waits for the shutdown convergence started by `shutdown`. */
  public whenClosed(): Promise<void> {
    return this.#shutdownPromise;
  }

  /** Composition root panic path: cancel all runs within the given deadline. */
  public async abortAllRuns(request: {
    readonly faultId: string;
    readonly deadlineMs: number;
  }): Promise<void> {
    this.#closing = true;
    const run = this.#run;
    const actor = this.#actor;
    if (run === undefined) return;
    const pending =
      actor !== undefined
        ? (async () => {
            await actor.abort(request.faultId);
            await actor.whenClosed();
            await actor.drain();
            this.#rememberTombstone(run);
          })()
        : this.#handler?.abortRun === undefined
          ? Promise.resolve()
          : this.#handler.abortRun(run, request.faultId).then(() => {
              this.#rememberTombstone(run);
            });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, request.deadlineMs);
      timer.unref();
    });
    try {
      await Promise.race([pending, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void pending.catch(() => undefined);
    }
  }

  /** Stops the actor and drains work during Kernel core shutdown. */
  public async stop(): Promise<void> {
    this.#closing = true;
    await this.#actor?.stop();
  }

  #auditFor(workflowRunId: string): AuditSink | undefined {
    return this.#auditFactory?.(workflowRunId) ?? this.#audit;
  }

  #rememberTombstone(run: RunState): void {
    if (run.runState === 'CLOSED' && run.closeReason !== undefined)
      this.#tombstones.set(run.workflowRunId, { closeReason: run.closeReason });
  }

  async #resolveRepositoryRoot(repositoryPath: string): Promise<string | undefined> {
    if (!isAbsolute(repositoryPath)) return undefined;
    try {
      const info = await stat(repositoryPath);
      if (!info.isDirectory()) return undefined;
      const repositoryRoot = await realpath(repositoryPath);
      const dataDir = await this.#dataDirRealPath();
      if (isWithin(repositoryRoot, dataDir) || isWithin(dataDir, repositoryRoot)) return undefined;
      return repositoryRoot;
    } catch {
      return undefined;
    }
  }

  async #dataDirRealPath(): Promise<string> {
    if (this.#resolvedDataDir !== undefined) return this.#resolvedDataDir;
    try {
      this.#resolvedDataDir = await realpath(this.#dataDir);
    } catch {
      // Persistence creates dataDir during startup. Resolving the configured path keeps the
      // boundary check deterministic when the directory is created later in a unit test.
      this.#resolvedDataDir = resolve(this.#dataDir);
    }
    return this.#resolvedDataDir;
  }
}

function isWithin(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function rejected(
  requestId: string,
  reasonCode: CoreRejectedCode | 'RUN_BLOCKED',
  closeReason?: CloseReason,
): SyscallRejected {
  if (reasonCode === 'RUN_BLOCKED') {
    if (closeReason === undefined) throw new Error('RUN_BLOCKED requires closeReason');
    return { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode, closeReason };
  }
  return { requestId, outcome: 'REJECTED', issuer: 'CORE', reasonCode };
}
