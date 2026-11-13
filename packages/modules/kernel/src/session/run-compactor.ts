import {
  AssembleContextPackSchema,
  ExecutionRequestSchema,
  MEDIA_TYPES,
  canonicalJson,
  entryTokens,
  estimateContext,
  estimateItemTokens,
  newId,
  sha256Hex,
  validate,
  type ArtifactRef,
  type AssembleContextPack,
  type AssembleExecutorInput,
  type CancelExecutionRequest,
  type CompactionFailed,
  type CompactionTarget,
  type CompactionUsage,
  type ContextCompacted,
  type ContextHistoryEntry,
  type ExecutionFact,
  type ExecutionRequest,
  type KernelToWorkflowEvent,
  type ModelRawOutput,
  type PruneCandidate,
  type PrunedItem,
  type TokenUsage,
} from '@multiagentos/contracts';
import type { Settlement, SchedulerDuties } from '../interfaces/index.js';
import type { RunLedgers } from '../monitor/index.js';
import type { AttemptRequestBuilder, ExecutionConfig } from './attempt-request.js';
import {
  CompactionProcess,
  type Change,
  type CompactionConfig,
  type CompactionPorts,
  type CompactionRequest,
  type CompactionResult,
  type PruneOutcome,
  type SummaryOutcome,
  type SummaryRequest,
} from './run-compaction.js';
import type { PinnedAgent } from './run-attempts.js';
import type { SessionArtifacts } from './session-artifacts.js';

/**
 * The summary instruction and what it must produce (Prompt `compaction-system`, AgentToolPool 3):
 * the sections the model-call checks for, and the line added to the instruction of a second try.
 */
export interface CompactionPrompt {
  readonly instruction: string;
  readonly strictSuffix: string;
  readonly requiredSections: readonly string[];
}

/** What RunWork needs of a compactor; tests bring their own. */
export interface Compacting {
  run(request: Omit<CompactionRequest, 'signal'>): Promise<CompactionResult>;
  /** The compaction of this target that is going on, to wait for; undefined when none. */
  runningFor(target: CompactionTarget): Promise<unknown> | undefined;
  reportSource(compactionId: string, entries: readonly ContextHistoryEntry[]): boolean;
  acknowledge(
    compactionId: string,
    stage: 'PRUNE' | 'SUMMARY',
    outcome: 'RECORDED' | 'FAILED',
  ): boolean;
  /** A pause, an abort, `/undo` or the end of the run. */
  cancel(): void;
}

export interface RunCompactorDeps {
  readonly sessionId: string;
  readonly workflowRunId: string;
  readonly compaction: CompactionConfig;
  readonly limits: ExecutionConfig['executionLimits'];
  readonly artifacts: SessionArtifacts;
  readonly builder: AttemptRequestBuilder;
  readonly prompt: CompactionPrompt;
  readonly provider: string;
  readonly ledgers: RunLedgers;
  readonly scheduler: SchedulerDuties;
  readonly dispatch: (request: ExecutionRequest) => Promise<void>;
  readonly cancelExecution: (request: CancelExecutionRequest) => Promise<void>;
  readonly expectInternal: (unitAttemptId: string, handler: (fact: ExecutionFact) => void) => void;
  readonly runEpoch: () => number;
  /** Runs `work` as a message of the Session actor: what leaves Core must go through it. */
  readonly enqueue: (work: () => void) => void;
  readonly toWorkflow: (event: KernelToWorkflowEvent) => void;
  readonly toInteraction: (event: ContextCompacted | CompactionFailed) => void;
  readonly audit: (entry: object) => void;
  readonly now: () => Date;
  readonly schedule: (delayMs: number, due: () => void) => () => void;
  /**
   * The Agent a target is compacted as (one lookup for every target), and the AgentRun that pays
   * for it from a ledger of its own, if any; undefined when the Agent is not known.
   */
  readonly agentOf: (target: CompactionTarget) =>
    | {
        readonly agent: PinnedAgent;
        /** Set when this AgentRun pays from its own ledger (a SubAgent); otherwise the run or the input's work pays. */
        readonly agentRunId?: string;
      }
    | undefined;
  readonly newCompactionId?: () => string;
}

const STATUS_TOKENS = 150;
/** How much more than the estimate a reservation holds (Kernel/Monitor 3.2). */
const RESERVE_MARGIN = 1.05;
const CAPACITY_WAIT_MS = 250;
const CAPACITY_WAITS = 240;
const TECHNICAL_RETRIES = 2;
const RETRY_WAIT_MS = 1_000;

type Reservation = {
  readonly settle: (settlement: Settlement) => void;
  readonly release: () => void;
};

const usageOf = (usage: TokenUsage | undefined): CompactionUsage => ({
  inputTokens: usage?.inputTokens ?? 0,
  outputTokens: usage?.outputTokens ?? 0,
  cachedInputTokens: usage?.inputCacheHitTokens ?? 0,
});

/**
 * Everything the compaction process needs of the rest of Kernel (Kernel/Core 6a, Execution 6a):
 * the questions to Workflow and the waiting for its acknowledgements, the pruning and the summary
 * request as Kernel's own executions, the budget they are paid from, and the way they stop when
 * the run is paused, interrupted or closed.
 */
export class RunCompactor implements Compacting {
  readonly #deps: RunCompactorDeps;
  readonly #process: CompactionProcess;
  readonly #sources = new Map<
    string,
    (entries: readonly ContextHistoryEntry[] | undefined) => void
  >();
  readonly #acks = new Map<string, (outcome: 'RECORDED' | 'FAILED') => void>();
  readonly #running = new Map<
    string,
    { executionId: string; done: (fact?: ExecutionFact) => void }
  >();
  readonly #grants = new Set<string>();
  #controller = new AbortController();
  readonly #going = new Map<string, Promise<unknown>>();

  public constructor(deps: RunCompactorDeps) {
    this.#deps = deps;
    this.#process = new CompactionProcess(this.#ports());
  }

  public async run(request: Omit<CompactionRequest, 'signal'>): Promise<CompactionResult> {
    const key = canonicalJson(request.target);
    const running = this.#process.run({ ...request, signal: this.#controller.signal });
    this.#going.set(key, running);
    try {
      return await running;
    } finally {
      if (this.#going.get(key) === running) this.#going.delete(key);
    }
  }

  public runningFor(target: CompactionTarget): Promise<unknown> | undefined {
    return this.#going.get(canonicalJson(target))?.catch(() => undefined);
  }

  /** Workflow answered the question for the material of a compaction. */
  public reportSource(compactionId: string, entries: readonly ContextHistoryEntry[]): boolean {
    const resolve = this.#sources.get(compactionId);
    if (resolve === undefined) return false;
    this.#sources.delete(compactionId);
    resolve(entries);
    return true;
  }

  /** Workflow says whether it put the result in the log. */
  public acknowledge(
    compactionId: string,
    stage: 'PRUNE' | 'SUMMARY',
    outcome: 'RECORDED' | 'FAILED',
  ): boolean {
    const key = `${compactionId}:${stage}`;
    const resolve = this.#acks.get(key);
    if (resolve === undefined) return false;
    this.#acks.delete(key);
    resolve(outcome);
    return true;
  }

  /**
   * A pause, an abort, `/undo` or the end of the run: what was started stops, nothing is written
   * for it, and what is still being waited for is given up (Kernel/Core 6a).
   */
  public cancel(): void {
    this.#controller.abort();
    this.#controller = new AbortController();
    for (const resolve of this.#sources.values()) resolve(undefined);
    this.#sources.clear();
    for (const resolve of this.#acks.values()) resolve('FAILED');
    this.#acks.clear();
    for (const [, running] of this.#running) {
      void this.#deps
        .cancelExecution({
          executionId: running.executionId,
          runEpoch: this.#deps.runEpoch(),
          reason: 'ABORTED',
        })
        .catch(() => undefined);
      running.done();
    }
    this.#running.clear();
    for (const grant of this.#grants) this.#deps.scheduler.release(grant);
    this.#grants.clear();
  }

  // -------------------------------------------------------------------------------------------

  #ports(): CompactionPorts {
    const deps = this.#deps;
    return {
      config: deps.compaction,
      newCompactionId: deps.newCompactionId ?? (() => newId('cmp')),
      requestSource: (compactionId, target) =>
        new Promise((resolve) => {
          this.#sources.set(compactionId, resolve);
          deps.enqueue(() => {
            deps.toWorkflow({ type: 'CompactionSourceQuery', compactionId, target });
          });
        }),
      sizeOf: (target, entries) => this.#sizeOf(target, entries),
      perCallInputLimit: (target) =>
        deps.agentOf(target)?.agent.budget.perCallInputLimit ?? Number.MAX_SAFE_INTEGER,
      prune: (compactionId, target, candidates) => this.#prune(candidates),
      summarize: (compactionId, target, request) => this.#summarize(target, request),
      record: (compactionId, target, change) => this.#record(compactionId, target, change),
      notify: (event) => {
        deps.enqueue(() => {
          deps.toInteraction(event);
        });
      },
      audit: (entry) => {
        deps.audit(entry);
      },
    };
  }

  #head(agent: PinnedAgent): { digest: string; tokens: number } {
    const toolSpecs = agent.toolSpecs(false);
    return {
      digest: sha256Hex(canonicalJson({ instructions: agent.instructions, toolSpecs })),
      tokens:
        estimateItemTokens({ role: 'system', content: agent.instructions }) +
        estimateItemTokens({ role: 'system', content: '', toolSpecs }),
    };
  }

  #sizeOf(target: CompactionTarget, entries: readonly ContextHistoryEntry[]): number {
    const found = this.#deps.agentOf(target);
    if (found === undefined) return entries.reduce((total, entry) => total + entryTokens(entry), 0);
    const head = this.#head(found.agent);
    return estimateContext({
      entries,
      headDigest: head.digest,
      headTokens: head.tokens,
      statusTokens: STATUS_TOKENS,
    }).tokens;
  }

  async #record(
    compactionId: string,
    target: CompactionTarget,
    change: Change,
  ): Promise<'RECORDED' | 'FAILED'> {
    const deps = this.#deps;
    return new Promise((resolve) => {
      this.#acks.set(`${compactionId}:${change.stage}`, resolve);
      deps.enqueue(() => {
        deps.toWorkflow(
          change.stage === 'PRUNE'
            ? {
                type: 'ToolResultsPruned',
                compactionId,
                target,
                items: [...change.items],
              }
            : {
                type: 'ContextCompacted',
                compactionId,
                target,
                fromSeq: change.fromSeq,
                toSeq: change.toSeq,
                keptSeqs: [...change.keptSeqs],
                summaryRef: change.summaryRef,
                summaryInput: change.summaryInput,
                usage: change.usage,
              },
        );
      });
    });
  }

  // ---- Kernel's own executions ----------------------------------------------------------------

  /** Runs one execution of Kernel's own and waits for its fact; undefined when it was cancelled. */
  async #execute(
    kind: 'CONTEXT_PRUNE' | 'CONTEXT_ASSEMBLE' | 'MODEL',
    input: unknown,
    scope: unknown,
    limits: unknown,
  ): Promise<ExecutionFact | undefined> {
    const deps = this.#deps;
    const unitAttemptId = newId('una');
    const executionId = newId('exe');
    const request = validate<ExecutionRequest>(ExecutionRequestSchema, {
      sessionId: deps.sessionId,
      workflowRunId: deps.workflowRunId,
      unitAttemptId,
      executionId,
      runEpoch: deps.runEpoch(),
      executionKind: kind,
      input,
      scope,
      limits,
    });
    if (!request.ok) throw new Error(`An internal ${kind} request is invalid`);
    return new Promise<ExecutionFact | undefined>((resolve) => {
      this.#running.set(unitAttemptId, { executionId, done: resolve });
      deps.expectInternal(unitAttemptId, (fact) => {
        this.#running.delete(unitAttemptId);
        resolve(fact);
      });
      deps.dispatch(request.value).catch(() => {
        this.#running.delete(unitAttemptId);
        resolve(undefined);
      });
    });
  }

  #limits(kind: 'CONTEXT_PRUNE' | 'CONTEXT_ASSEMBLE' | 'MODEL'): {
    deadline: string;
    maxOutputBytes: number;
  } {
    const { timeoutMs, maxOutputBytes } = this.#deps.limits[kind];
    return {
      deadline: new Date(this.#deps.now().getTime() + timeoutMs).toISOString(),
      maxOutputBytes,
    };
  }

  async #prune(candidates: readonly PruneCandidate[]): Promise<PruneOutcome> {
    const { artifacts, compaction } = this.#deps;
    const items: { toolCallId: string; text: string }[] = [];
    const readable = new Map<
      string,
      { previewRef: ArtifactRef; fullRef?: ArtifactRef; text: string; requestId: string }
    >();
    for (const candidate of candidates) {
      const preview = await artifacts.read(candidate.previewRef);
      if (!preview.ok) continue;
      items.push({ toolCallId: candidate.toolCallId, text: preview.text });
      readable.set(candidate.toolCallId, {
        previewRef: candidate.previewRef,
        ...(candidate.fullRef === undefined ? {} : { fullRef: candidate.fullRef }),
        text: preview.text,
        requestId: candidate.requestId,
      });
    }
    if (items.length === 0) return { kind: 'OK', items: [] };
    const fact = await this.#execute(
      'CONTEXT_PRUNE',
      { headBytes: compaction.pruneHeadBytes, tailBytes: compaction.pruneTailBytes, items },
      { kind: 'NONE' },
      this.#limits('CONTEXT_PRUNE'),
    );
    if (fact === undefined) return { kind: 'CANCELLED' };
    if (fact.outcome === 'TERMINATED') return { kind: 'CANCELLED' };
    if (fact.outcome !== 'COMPLETED' || fact.executionKind !== 'CONTEXT_PRUNE')
      return { kind: 'FAILED' };
    const cut = (
      JSON.parse(fact.result.artifact.text) as {
        items: { toolCallId: string; text: string; omittedBytes: number }[];
      }
    ).items;
    const done: PrunedItem[] = [];
    for (const each of cut) {
      const origin = readable.get(each.toolCallId);
      if (origin === undefined || each.omittedBytes === 0) continue;
      const prunedRef = await artifacts.put(each.text, MEDIA_TYPES.fileText, 'SESSION');
      // A result that was not cut before has only its preview: that becomes what `read_output`
      // reads, and it is kept for good (Execution 6a). It is not marked as a full output: the
      // same bytes are what the context shows as the preview.
      const readableRef =
        origin.fullRef ??
        (await artifacts.put(origin.text, origin.previewRef.mediaType, 'SESSION'));
      done.push({
        requestId: origin.requestId,
        toolCallId: each.toolCallId,
        prunedRef,
        readableRef,
        omittedBytes: each.omittedBytes,
      });
    }
    return { kind: 'OK', items: done };
  }

  // ---- the summary request --------------------------------------------------------------------

  async #reserve(
    estimatedTokens: number,
    cacheHitWeight: number,
    agentRunId: string | undefined,
  ): Promise<Reservation | 'REFUSED' | 'STOPPED'> {
    const { ledgers, scheduler, provider } = this.#deps;
    let grantId: string | undefined;
    for (let waits = 0; grantId === undefined; waits += 1) {
      const grant = scheduler.acquire(provider);
      if (grant.ok) grantId = grant.grantId;
      else if (grant.reason === 'STOPPED' || waits >= CAPACITY_WAITS) return 'STOPPED';
      else if (this.#controller.signal.aborted) return 'STOPPED';
      else await this.#sleep(CAPACITY_WAIT_MS);
    }
    this.#grants.add(grantId);
    const release = () => {
      scheduler.release(grantId);
      this.#grants.delete(grantId);
    };
    // The target's own ledger pays: an AgentRun's, the open input's for main, else a ledger of its
    // own taken from the run (Kernel/Monitor 3.4).
    if (agentRunId !== undefined || ledgers.hasOpenInput()) {
      const reserved = ledgers.reserve(
        { estimatedTokens, final: false, cacheHitWeight },
        agentRunId,
      );
      if (!reserved.ok) {
        release();
        return 'REFUSED';
      }
      return {
        settle: (settlement) => {
          ledgers.settle(reserved.reservationId, settlement);
          release();
        },
        release,
      };
    }
    const own = ledgers.openCompactionLedger(estimatedTokens);
    const reservationId = own.ok ? own.reserve(cacheHitWeight) : undefined;
    if (!own.ok || reservationId === undefined) {
      if (own.ok) own.close();
      release();
      return 'REFUSED';
    }
    return {
      settle: (settlement) => {
        own.settle(reservationId, settlement);
        own.close();
        release();
      },
      release: () => {
        own.settle(reservationId, { type: 'NOT_SENT' });
        own.close();
        release();
      },
    };
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.#deps.schedule(ms, () => {
        resolve();
      });
      this.#controller.signal.addEventListener(
        'abort',
        () => {
          cancel();
          resolve();
        },
        { once: true },
      );
    });
  }

  async #summarize(target: CompactionTarget, request: SummaryRequest): Promise<SummaryOutcome> {
    const deps = this.#deps;
    const found = deps.agentOf(target);
    if (found === undefined) return { kind: 'INTERRUPTED' };
    const { agent } = found;
    const { compaction, prompt } = deps;
    const instruction = request.strict
      ? `${prompt.instruction}${prompt.strictSuffix}`
      : prompt.instruction;
    // What a summary that did not come about ran into, for whoever looks at the audit afterwards:
    // the outcome and its code, never any content.
    const problem = (stage: string, detail: Readonly<Record<string, unknown>>): void =>
      deps.audit({
        type: 'COMPACTION_SUMMARY_PROBLEM',
        stage,
        mode: request.mode,
        strict: request.strict,
        ...detail,
      });

    // What it will cost, before anything is sent: the input of this form plus the summary.
    const inputTokens =
      request.mode === 'PREFIX'
        ? this.#head(agent).tokens +
          request.entries.reduce((total, entry) => total + entryTokens(entry), 0)
        : Math.min(
            request.targetTokens ?? agent.budget.perCallInputLimit,
            request.entries.reduce((total, entry) => total + entryTokens(entry), 0) +
              estimateItemTokens({ role: 'system', content: instruction }),
          );
    const estimatedTokens =
      Math.min(Math.ceil(inputTokens * RESERVE_MARGIN), agent.budget.perCallInputLimit) +
      compaction.summaryMaxTokens;
    const reservation = await this.#reserve(
      estimatedTokens,
      agent.cacheHitWeight,
      found.agentRunId,
    );
    if (reservation === 'STOPPED') return { kind: 'INTERRUPTED' };
    if (reservation === 'REFUSED') return { kind: 'BUDGET' };

    // 1. the request, as a context pack
    const history = await deps.builder.resolveHistory(request.entries);
    const assemble: AssembleExecutorInput = {
      final: false,
      tokenBudget: agent.budget.perCallInputLimit,
      instructions: agent.instructions,
      toolSpecs: agent.toolSpecs(false),
      history,
      status: {
        round: 1,
        maxRounds: 1,
        final: false,
        budget: { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' },
      },
      compaction: {
        mode: request.mode,
        instruction,
        ...(request.targetTokens === undefined ? {} : { targetTokens: request.targetTokens }),
      },
    };
    const assembled = await this.#execute(
      'CONTEXT_ASSEMBLE',
      assemble,
      { kind: 'NONE' },
      this.#limits('CONTEXT_ASSEMBLE'),
    );
    if (assembled === undefined || assembled.outcome === 'TERMINATED') {
      reservation.release();
      return { kind: 'INTERRUPTED' };
    }
    if (assembled.outcome === 'REJECTED' && assembled.reasonCode === 'LIMIT_EXCEEDED') {
      problem('ASSEMBLE', { outcome: assembled.outcome, reasonCode: assembled.reasonCode });
      reservation.settle({ type: 'NOT_SENT' });
      return { kind: 'OVERFLOW', usage: usageOf(undefined) };
    }
    if (assembled.outcome !== 'COMPLETED' || assembled.executionKind !== 'CONTEXT_ASSEMBLE') {
      problem('ASSEMBLE', {
        outcome: assembled.outcome,
        ...('reasonCode' in assembled ? { reasonCode: assembled.reasonCode } : {}),
      });
      reservation.settle({ type: 'NOT_SENT' });
      return { kind: 'FAILED', usage: usageOf(undefined) };
    }
    const pack = JSON.parse(assembled.result.artifact.text) as AssembleContextPack;
    if (!validate<AssembleContextPack>(AssembleContextPackSchema, pack).ok) {
      problem('ASSEMBLE', { outcome: 'INVALID_PACK' });
      reservation.settle({ type: 'NOT_SENT' });
      return { kind: 'FAILED', usage: usageOf(undefined) };
    }
    const omittedEntries =
      'omittedEntries' in assembled.result.output
        ? (assembled.result.output.omittedEntries ?? 0)
        : 0;

    // 2. the model, with a little patience for what is only technical
    const scope = summaryScope(agent.modelScope, compaction.summaryReasoningEffort);
    for (let attempt = 0; ; attempt += 1) {
      const fact = await this.#execute(
        'MODEL',
        {
          contextPack: pack,
          final: false,
          compaction: { requiredSections: [...prompt.requiredSections] },
        },
        scope,
        { ...this.#limits('MODEL'), maxOutputTokens: compaction.summaryMaxTokens },
      );
      if (fact === undefined || fact.outcome === 'TERMINATED') {
        reservation.release();
        return { kind: 'INTERRUPTED' };
      }
      if (fact.executionKind !== 'MODEL') {
        problem('MODEL', { outcome: 'WRONG_EXECUTION_KIND' });
        reservation.settle({ type: 'UNKNOWN' });
        return { kind: 'FAILED', usage: usageOf(undefined) };
      }
      if (fact.outcome === 'COMPLETED') {
        reservation.settle(
          fact.usage === undefined ? { type: 'UNKNOWN' } : { type: 'ACTUAL', usage: fact.usage },
        );
        const raw = JSON.parse(fact.result.artifact.text) as ModelRawOutput;
        const summaryRef = await deps.artifacts.put(
          raw.text ?? '',
          MEDIA_TYPES.markdown,
          'SESSION',
        );
        return { kind: 'OK', summaryRef, omittedEntries, usage: usageOf(fact.usage) };
      }
      const settlement: Settlement =
        'requestState' in fact && fact.requestState === 'NOT_SENT'
          ? { type: 'NOT_SENT' }
          : 'usage' in fact &&
              fact.usage !== undefined &&
              'requestState' in fact &&
              fact.requestState === 'SENT'
            ? { type: 'ACTUAL', usage: fact.usage }
            : { type: 'UNKNOWN' };
      problem('MODEL', {
        attempt,
        outcome: fact.outcome,
        ...('reasonCode' in fact ? { reasonCode: fact.reasonCode } : {}),
        ...('retryable' in fact ? { retryable: fact.retryable } : {}),
        ...('requestState' in fact ? { requestState: fact.requestState } : {}),
      });
      if (fact.outcome === 'FAILED' && fact.reasonCode === 'COMPACTION_SUMMARY_INVALID') {
        reservation.settle(settlement);
        return { kind: 'INVALID', usage: usageOf('usage' in fact ? fact.usage : undefined) };
      }
      if (fact.outcome === 'REJECTED' && fact.reasonCode === 'CONTEXT_OVERFLOW') {
        reservation.settle({ type: 'NOT_SENT' });
        return { kind: 'OVERFLOW', usage: usageOf(undefined) };
      }
      if (
        fact.outcome === 'FAILED' &&
        fact.retryable &&
        attempt < TECHNICAL_RETRIES &&
        settlement.type === 'NOT_SENT'
      ) {
        await this.#sleep(RETRY_WAIT_MS);
        if (this.#controller.signal.aborted) {
          reservation.release();
          return { kind: 'INTERRUPTED' };
        }
        continue;
      }
      reservation.settle(settlement);
      return { kind: 'FAILED', usage: usageOf('usage' in fact ? fact.usage : undefined) };
    }
  }
}

/** The scope of the summary request: the AgentRun's own, with the thinking the configuration asks for. */
export function summaryScope(
  scope: PinnedAgent['modelScope'],
  effort: CompactionConfig['summaryReasoningEffort'],
): PinnedAgent['modelScope'] {
  if (scope.kind !== 'MODEL') return scope;
  const base = {
    kind: 'MODEL' as const,
    provider: scope.provider,
    apiModelId: scope.apiModelId,
    apiProtocol: scope.apiProtocol,
    baseUrl: scope.baseUrl,
  };
  return effort === 'none'
    ? { ...base, thinking: 'DISABLED' }
    : { ...base, thinking: 'ENABLED', thinkingEffort: effort };
}
