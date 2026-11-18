import type { ContextHistoryEntry } from './history-entry.js';
import { entryTokens } from './compaction-plan.js';

/**
 * How big the next request of a projection will be (M2Design 9.6, "Estimate"): a pure function of
 * the entries, so that it comes out the same after a restart.
 *
 * What the provider counted for the last model turn, plus the entries that came after it, when
 * that count can be relied on: the head of that request (system part, tools, model) was the one of
 * the request about to be made, and nothing has changed what the turn saw since: no summary and no
 * cut result is newer than the turn. Otherwise the whole history is counted from its bytes.
 */
export interface EstimateInput {
  readonly entries: readonly ContextHistoryEntry[];
  /** Digest of the system part and the tools of the request about to be made. */
  readonly headDigest: string;
  /** What that system part and those tools cost, counted from their text. */
  readonly headTokens: number;
  /** What the status line and the like add to a request of this AgentRun. */
  readonly statusTokens: number;
}

export interface Estimate {
  readonly tokens: number;
  /** True when the provider's own count was the start of it. */
  readonly measured: boolean;
}

export function estimateContext(input: EstimateInput): Estimate {
  const { entries, headDigest, headTokens, statusTokens } = input;
  // Anything that rewrote what an earlier turn saw makes that turn's count out of date.
  let changedAt = 0;
  for (const entry of entries) {
    if (entry.kind === 'SUMMARY') changedAt = Math.max(changedAt, entry.seq);
    if (entry.kind === 'TOOL_RESULT' && entry.prunedAt !== undefined)
      changedAt = Math.max(changedAt, entry.prunedAt);
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== 'MODEL_TURN' || entry.measured === undefined) continue;
    if (entry.measured.headDigest !== headDigest || entry.seq <= changedAt) break;
    const after = entries.slice(index + 1).reduce((total, each) => total + entryTokens(each), 0);
    return {
      tokens: entry.measured.inputTokens + entry.measured.outputTokens + after + statusTokens,
      measured: true,
    };
  }
  return {
    tokens:
      headTokens + entries.reduce((total, each) => total + entryTokens(each), 0) + statusTokens,
    measured: false,
  };
}
