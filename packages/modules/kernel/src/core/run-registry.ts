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
}

export interface RunRegistryDeps {
  readonly dataDir: string;
  readonly handler: RunRequestHandler;
  readonly audit?: AuditSink;
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
  readonly #handler: RunRequestHandler;
  readonly #audit: AuditSink | undefined;
  readonly #now: () => Date;
  readonly #ledger = new RequestLedger();
  readonly #tombstones = new Map<string, Tombstone>();
  #run: RunState | undefined;
  #hasCreatedRun = false;
  #closing = false;
  #resolvedDataDir: string | undefined;

  public constructor(deps: RunRegistryDeps) {
    if (!isAbsolute(deps.dataDir)) throw new Error('dataDir must be an absolute path');
    this.#dataDir = deps.dataDir;
    this.#handler = deps.handler;
    this.#audit = deps.audit;
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
    if (run !== undefined && run.workflowRunId === workflowRunId)
      return this.#handler.handleForward(forward, context, run);
    const tombstone = this.#tombstones.get(workflowRunId);
    if (tombstone !== undefined)
      return rejected(forward.request.requestId, 'RUN_BLOCKED', tombstone.closeReason);
    return rejected(forward.request.requestId, 'RUN_NOT_FOUND');
  }

  public async report(fact: ExecutionFact): Promise<void> {
    const run = this.#run;
    if (run === undefined || run.workflowRunId !== fact.workflowRunId) return;
    // Facts for a closed run are evidence only; stage 1.5 adds the audit entry.
    if (run.runState === 'CLOSED') return;
    await this.#handler.report?.(fact, run);
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
    await this.#audit?.append({
      at: run.startedAt,
      workflowRunId: run.workflowRunId,
      type: 'RUN_STARTED',
    });
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

    // Stage 1.5 adds run cancellation and waits for CLOSED plus Outbox drain.
    this.#closing = true;
    const response: SyscallAck = { requestId: request.requestId, outcome: 'ACCEPTED' };
    this.#ledger.remember(request.requestId, request, response);
    return response;
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
