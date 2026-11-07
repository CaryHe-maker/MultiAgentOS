import {
  applyCompactions,
  entryBytes,
  planCompaction,
  type ArtifactRef,
  type CompactionFailed,
  type CompactionSummaryInput,
  type CompactionTarget,
  type CompactionTrigger,
  type CompactionUsage,
  type ContextCompacted,
  type ContextHistoryEntry,
  type KernelConfig,
  type PruneCandidate,
  type PrunedItem,
} from '@multiagentos/contracts';

/**
 * The process of a compaction (Kernel/Core 6a, M2Design 9.6), written against ports so that it can
 * be tried without a model, a clock or a Session: cut the big old tool results, and when that is
 * not enough have the older history summarised; each step takes effect only once Workflow has
 * recorded it. It decides nothing about *when* to compact; whoever starts it says why.
 */
export type CompactionConfig = KernelConfig['compaction'];

export interface SummaryRequest {
  readonly mode: 'PREFIX' | 'TEXT';
  /** PREFIX: the older history as it is. TEXT: only what the summary takes the place of. */
  readonly entries: readonly ContextHistoryEntry[];
  /** The second try, after an answer that was not a summary: a stricter instruction. */
  readonly strict: boolean;
  /** TEXT: the transcript is cut from the oldest whole turn until it fits in this many tokens. */
  readonly targetTokens?: number;
}

export type SummaryOutcome =
  | {
      readonly kind: 'OK';
      readonly summaryRef: ArtifactRef;
      readonly omittedEntries: number;
      readonly usage: CompactionUsage;
    }
  /** Not a summary (a tool call, a missing section): ask again once, stricter. */
  | { readonly kind: 'INVALID'; readonly usage: CompactionUsage }
  /** Too long for the model, or refused for its size: try the text form, smaller. */
  | { readonly kind: 'OVERFLOW'; readonly usage: CompactionUsage }
  /** The ledger will not pay for it. */
  | { readonly kind: 'BUDGET' }
  /** A pause, an abort or a closing run stopped it. */
  | { readonly kind: 'INTERRUPTED' }
  | { readonly kind: 'FAILED'; readonly usage: CompactionUsage };

export type PruneOutcome =
  | { readonly kind: 'OK'; readonly items: readonly PrunedItem[] }
  | { readonly kind: 'CANCELLED' }
  | { readonly kind: 'FAILED' };

/** What Workflow is asked to record, and answers with an acknowledgement. */
export type Change =
  | { readonly stage: 'PRUNE'; readonly items: readonly PrunedItem[] }
  | {
      readonly stage: 'SUMMARY';
      readonly fromSeq: number;
      readonly toSeq: number;
      readonly keptSeqs: readonly number[];
      readonly summaryRef: ArtifactRef;
      readonly summaryInput: CompactionSummaryInput;
      readonly usage: CompactionUsage;
    };

export interface CompactionPorts {
  readonly config: CompactionConfig;
  newCompactionId(): string;
  /** The projection of the target as Workflow has it now; undefined when the run no longer asks. */
  requestSource(
    compactionId: string,
    target: CompactionTarget,
  ): Promise<readonly ContextHistoryEntry[] | undefined>;
  /** How big the next request of this projection is: the provider's own count when it still holds. */
  sizeOf(target: CompactionTarget, entries: readonly ContextHistoryEntry[]): number;
  /** The most input one call of the target may have (`perCallInputLimit`). */
  perCallInputLimit(target: CompactionTarget): number;
  prune(
    compactionId: string,
    target: CompactionTarget,
    candidates: readonly PruneCandidate[],
  ): Promise<PruneOutcome>;
  summarize(
    compactionId: string,
    target: CompactionTarget,
    request: SummaryRequest,
  ): Promise<SummaryOutcome>;
  record(
    compactionId: string,
    target: CompactionTarget,
    change: Change,
  ): Promise<'RECORDED' | 'FAILED'>;
  notify(event: ContextCompacted | CompactionFailed): void;
  audit(entry: object): void;
}

export interface CompactionRequest {
  readonly trigger: CompactionTrigger;
  readonly target: CompactionTarget;
  /** What the context that is too big counts for, when the caller has seen the pack. */
  readonly currentTokens?: number;
  /** Below this many tokens the compaction is done; absent: it depends on the trigger. */
  readonly goalTokens?: number;
  readonly signal?: AbortSignal;
}

export type CompactionResult =
  | { readonly kind: 'CHANGED'; readonly pruned: number; readonly summarised: boolean }
  | { readonly kind: 'UNCHANGED'; readonly reason: 'NOTHING_TO_COMPACT' | 'SMALL_ENOUGH' }
  | { readonly kind: 'BUDGET' }
  | { readonly kind: 'CANCELLED' }
  | { readonly kind: 'FAILED'; readonly reason: 'SUMMARY_FAILED' | 'NOT_RECORDED' };

const NO_USAGE: CompactionUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
const sum = (a: CompactionUsage, b: CompactionUsage): CompactionUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
});
const totalBytes = (entries: readonly ContextHistoryEntry[]): number =>
  entries.reduce((total, entry) => total + entryBytes(entry), 0);

export class CompactionProcess {
  readonly #ports: CompactionPorts;

  public constructor(ports: CompactionPorts) {
    this.#ports = ports;
  }

  public async run(request: CompactionRequest): Promise<CompactionResult> {
    const { trigger, target } = request;
    const id = this.#ports.newCompactionId();
    this.#ports.audit({ type: 'COMPACTION_STARTED', compactionId: id, trigger, target });
    const result = await this.#steps(id, request);
    this.#end(id, request, result);
    return result;
  }

  #end(id: string, request: CompactionRequest, result: CompactionResult): void {
    const { trigger } = request;
    if (result.kind === 'CHANGED') {
      this.#ports.audit({ type: 'COMPACTION_ENDED', compactionId: id, trigger, ...result });
      // A summary was told when it was recorded; results that were only cut are told here.
      if (!result.summarised)
        this.#ports.notify({
          type: 'ContextCompacted',
          trigger,
          compactedTurns: 0,
          prunedResults: result.pruned,
        });
      return;
    }
    this.#ports.audit({ type: 'COMPACTION_FAILED', compactionId: id, trigger, result });
    // An idle compaction was not asked for, so its failure is not the user's business; an
    // automatic one that merely had nothing to do, or no budget, ends in the usual wrap-up.
    if (trigger === 'IDLE' || result.kind === 'CANCELLED') return;
    const reason =
      result.kind === 'FAILED'
        ? result.reason
        : result.kind === 'BUDGET'
          ? 'BUDGET_INSUFFICIENT'
          : 'NOTHING_TO_COMPACT';
    if (trigger !== 'USER' && (result.kind === 'BUDGET' || result.kind === 'UNCHANGED')) return;
    this.#ports.notify({ type: 'CompactionFailed', trigger, reason });
  }

  async #steps(id: string, request: CompactionRequest): Promise<CompactionResult> {
    const { trigger, target, signal } = request;
    const { config } = this.#ports;
    const cancelled = () => signal?.aborted === true;
    let entries = await this.#ports.requestSource(id, target);
    if (entries === undefined || cancelled()) return { kind: 'CANCELLED' };

    const limit = this.#ports.perCallInputLimit(target);
    const startTokens = request.currentTokens ?? this.#ports.sizeOf(target, entries);
    const startBytes = Math.max(totalBytes(entries), 1);
    const goal =
      request.goalTokens ??
      (trigger === 'IDLE'
        ? config.idleTriggerRatio * limit
        : trigger === 'AUTO'
          ? config.triggerRatio * limit
          : undefined);
    const planConfig = {
      keepTokens: config.keepTokens,
      keepHumanBytes: config.keepHumanBytes,
      pruneMinBytes: config.pruneMinBytes,
      minReplacedTokens: Math.floor(config.summaryMaxTokens / 8),
    };

    // 1. Cut the big old results: no model, so no budget. What the summary reads is what the
    // model last saw, not the cut: a fact in the middle of a long result is in it, and the
    // request is the cached prefix.
    const uncut = entries;
    let pruned = 0;
    const candidates = planCompaction(entries, planConfig).prunable;
    if (candidates.length > 0) {
      const cut = await this.#ports.prune(id, target, candidates);
      if (cut.kind === 'CANCELLED' || cancelled()) return { kind: 'CANCELLED' };
      // A cut that failed leaves the results as they are; the summary may still be enough.
      if (cut.kind === 'OK' && cut.items.length > 0) {
        const recorded = await this.#ports.record(id, target, { stage: 'PRUNE', items: cut.items });
        if (recorded === 'FAILED') return { kind: 'FAILED', reason: 'NOT_RECORDED' };
        pruned = cut.items.length;
        const at = Math.max(0, ...entries.map((entry) => entry.seq)) + 1;
        entries = applyCompactions(entries, {
          compacted: [],
          revoked: new Set(),
          pruned: [
            {
              type: 'TOOL_RESULTS_PRUNED',
              seq: at,
              compactionId: id,
              target,
              items: [...cut.items],
            } as never,
          ],
        });
      }
    }

    // 2. Small enough now? A user who asked for it gets the summary whatever the size.
    if (trigger !== 'USER' && goal !== undefined) {
      const now = pruned === 0 ? startTokens : (startTokens * totalBytes(entries)) / startBytes;
      if (now <= goal)
        return pruned > 0
          ? { kind: 'CHANGED', pruned, summarised: false }
          : { kind: 'UNCHANGED', reason: 'SMALL_ENOUGH' };
    }

    // 3. What would a summary take the place of?
    const plan = planCompaction(entries, planConfig);
    const { range } = plan;
    if (range === undefined)
      return pruned > 0
        ? { kind: 'CHANGED', pruned, summarised: false }
        : { kind: 'UNCHANGED', reason: 'NOTHING_TO_COMPACT' };

    // 4. The summary: the history as it is when it fits, otherwise as a transcript, smaller.
    const older = uncut.slice(0, plan.keepFrom);
    const kept = new Set(range.keptSeqs);
    const replaced = older.filter(
      (entry) => entry.kind === 'SUMMARY' || (entry.category === 'NORMAL' && !kept.has(entry.seq)),
    );
    const room = limit - config.summaryMaxTokens;
    let mode: 'PREFIX' | 'TEXT' = this.#ports.sizeOf(target, older) <= room ? 'PREFIX' : 'TEXT';
    let strict = false;
    let fallback = 0;
    let targetTokens =
      mode === 'TEXT' ? Math.floor((config.summaryFallbackTargets[0] ?? 0.5) * room) : undefined;
    let usage = NO_USAGE;
    for (;;) {
      if (cancelled()) return { kind: 'CANCELLED' };
      const outcome = await this.#ports.summarize(id, target, {
        mode,
        entries: mode === 'PREFIX' ? older : replaced,
        strict,
        ...(targetTokens === undefined ? {} : { targetTokens }),
      });
      if (outcome.kind === 'BUDGET') return { kind: 'BUDGET' };
      if (outcome.kind === 'INTERRUPTED' || cancelled()) return { kind: 'CANCELLED' };
      usage = sum(usage, 'usage' in outcome ? outcome.usage : NO_USAGE);
      if (outcome.kind === 'FAILED') return { kind: 'FAILED', reason: 'SUMMARY_FAILED' };
      if (outcome.kind === 'INVALID') {
        // Not a summary: once more with a stricter instruction, then it has failed.
        if (strict) return { kind: 'FAILED', reason: 'SUMMARY_FAILED' };
        strict = true;
        continue;
      }
      if (outcome.kind === 'OVERFLOW') {
        // Too long for the model: the text form at a smaller size, each time smaller still.
        if (mode === 'PREFIX') mode = 'TEXT';
        else fallback += 1;
        const share = config.summaryFallbackTargets[fallback];
        if (share === undefined) return { kind: 'FAILED', reason: 'SUMMARY_FAILED' };
        targetTokens = Math.floor(share * room);
        continue;
      }
      const recorded = await this.#ports.record(id, target, {
        stage: 'SUMMARY',
        fromSeq: range.fromSeq,
        toSeq: range.toSeq,
        keptSeqs: range.keptSeqs,
        summaryRef: outcome.summaryRef,
        summaryInput: { mode, omittedEntries: outcome.omittedEntries },
        usage,
      });
      if (recorded === 'FAILED') return { kind: 'FAILED', reason: 'NOT_RECORDED' };
      this.#ports.notify({
        type: 'ContextCompacted',
        trigger,
        summaryRef: outcome.summaryRef,
        compactedTurns: range.replacedTurns,
        prunedResults: pruned,
      });
      return { kind: 'CHANGED', pruned, summarised: true };
    }
  }
}
