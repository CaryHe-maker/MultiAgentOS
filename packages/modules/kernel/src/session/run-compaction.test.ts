import {
  entryTokens,
  type ArtifactRef,
  type ContextHistoryEntry,
  type PrunedItem,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_KERNEL_CONFIG } from '../interfaces/kernel-config.js';
import {
  CompactionProcess,
  type Change,
  type CompactionPorts,
  type PruneOutcome,
  type SummaryOutcome,
  type SummaryRequest,
} from './run-compaction.js';

const ref = (size: number, digit = 'a'): ArtifactRef => ({
  artifactId: `art_${digit.repeat(64)}`,
  sha256: digit.repeat(64),
  size,
  mediaType: 'text/plain',
});
const USAGE = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 };
const MAIN = { kind: 'MAIN' } as const;
const CONFIG = {
  ...DEFAULT_KERNEL_CONFIG.compaction,
  // Of the limit most of these use (100,000): 1,000 tokens.
  keepRatio: 0.01,
  keepHumanBytes: 1_000,
  pruneMinBytes: 2_000,
  summaryMaxTokens: 500,
};

let seq = 0;
const human = (size = 100): ContextHistoryEntry => ({
  seq: (seq += 1),
  category: 'NORMAL',
  kind: 'HUMAN',
  contentRef: ref(size),
});
const turn = (size = 200): ContextHistoryEntry => ({
  seq: (seq += 1),
  category: 'NORMAL',
  kind: 'MODEL_TURN',
  modelId: 'm',
  outputRef: ref(size),
  replayable: false,
});
const result = (id: string, size: number): ContextHistoryEntry => ({
  seq: (seq += 1),
  category: 'NORMAL',
  kind: 'TOOL_RESULT',
  toolCallId: id,
  toolName: 'read_file',
  status: 'OK',
  outputRef: ref(size),
  requestId: `req_${id}00000`,
});
const rounds = (count: number, size: number): ContextHistoryEntry[] =>
  Array.from({ length: count }, (_, i) => [turn(), result(`call_${String(i)}`, size)]).flat();

interface Script {
  summaries?: SummaryOutcome[];
  prune?: PruneOutcome;
  record?: ('RECORDED' | 'FAILED')[];
  /** What the projection is, per ask: the second one is what is left after a prune. */
  entries?: readonly ContextHistoryEntry[] | undefined;
  limit?: number;
}

function ports(script: Script) {
  const log: string[] = [];
  const summarised: SummaryRequest[] = [];
  const recorded: Change[] = [];
  const notified: object[] = [];
  const audits: { type: string }[] = [];
  const summaries = [...(script.summaries ?? [])];
  const records = [...(script.record ?? [])];
  const entries = 'entries' in script ? script.entries : [];
  const implementation: CompactionPorts = {
    config: CONFIG,
    newCompactionId: () => 'cmp_testtest',
    requestSource: () => {
      log.push('source');
      return Promise.resolve(entries);
    },
    sizeOf: (_target, list) => list.reduce((total, entry) => total + entryTokens(entry), 0),
    perCallInputLimit: () => script.limit ?? 50_000,
    prune: (_id, _target, candidates) => {
      log.push(`prune ${String(candidates.length)}`);
      return Promise.resolve(script.prune ?? { kind: 'OK', items: [] });
    },
    summarize: (_id, _target, request) => {
      log.push(`summarize ${request.mode}${request.strict ? ' strict' : ''}`);
      summarised.push(request);
      const next = summaries.shift();
      return Promise.resolve(next ?? { kind: 'FAILED', usage: USAGE });
    },
    record: (_id, _target, change) => {
      log.push(`record ${change.stage}`);
      recorded.push(change);
      return Promise.resolve(records.shift() ?? 'RECORDED');
    },
    notify: (event) => void notified.push(event),
    audit: (entry) => void audits.push(entry as { type: string }),
  };
  return { implementation, log, summarised, recorded, notified, audits };
}

const ok = (omitted = 0): SummaryOutcome => ({
  kind: 'OK',
  summaryRef: ref(500, 's'),
  omittedEntries: omitted,
  usage: USAGE,
});
const item = (id: string): PrunedItem => ({
  requestId: `req_${id}00000`,
  toolCallId: id,
  prunedRef: ref(50, 'p'),
  readableRef: ref(9_000, 'q'),
  omittedBytes: 8_000,
});

const big = () => {
  seq = 0;
  return [human(900), ...rounds(10, 2_500)];
};

describe('the process of a compaction (Kernel/Core 6a)', () => {
  it('cuts the big results first, and writes no summary when that is enough', async () => {
    seq = 0;
    const entries = [human(100), turn(), result('call_big', 9_000), ...rounds(8, 300)];
    const p = ports({ entries, prune: { kind: 'OK', items: [item('call_big')] }, limit: 5_000 });
    const outcome = await new CompactionProcess(p.implementation).run({
      trigger: 'AUTO',
      target: MAIN,
      // The assembly counted this much; once the big result is cut, the rest is well under 85%.
      currentTokens: 5_000,
    });
    expect(outcome).toEqual({ kind: 'CHANGED', pruned: 1, summarised: false });
    expect(p.log).toEqual(['source', 'prune 1', 'record PRUNE']);
    expect(p.notified).toEqual([
      { type: 'ContextCompacted', trigger: 'AUTO', compactedInputs: 0, prunedResults: 1 },
    ]);
    expect(p.audits.map((entry) => entry.type)).toEqual(['COMPACTION_STARTED', 'COMPACTION_ENDED']);
  });

  it('goes on to a summary when the cut was not enough, and tells what it replaced', async () => {
    const entries = big();
    const p = ports({
      entries,
      prune: { kind: 'OK', items: [item('call_0')] },
      summaries: [ok()],
      limit: 20_000,
    });
    const outcome = await new CompactionProcess(p.implementation).run({
      trigger: 'AUTO',
      target: MAIN,
      currentTokens: 19_900,
    });
    expect(outcome).toEqual({ kind: 'CHANGED', pruned: 1, summarised: true });
    expect(p.log).toEqual([
      'source',
      'prune 9',
      'record PRUNE',
      'summarize PREFIX',
      'record SUMMARY',
    ]);
    const change = p.recorded[1];
    expect(change).toMatchObject({
      stage: 'SUMMARY',
      summaryInput: { mode: 'PREFIX', omittedEntries: 0 },
      usage: USAGE,
    });
    if (change?.stage !== 'SUMMARY') throw new Error('not a summary');
    expect(change.fromSeq).toBeLessThanOrEqual(change.toSeq);
    expect(p.notified[0]).toMatchObject({ type: 'ContextCompacted', summaryRef: ref(500, 's') });
  });

  it('sends the older history as it is when it fits, a transcript of what is replaced when not', async () => {
    const entries = big();
    const fits = ports({ entries, summaries: [ok()], limit: 100_000 });
    await new CompactionProcess(fits.implementation).run({ trigger: 'USER', target: MAIN });
    expect(fits.summarised[0]?.mode).toBe('PREFIX');
    const tight = ports({ entries, summaries: [ok(2)], limit: 3_000 });
    await new CompactionProcess(tight.implementation).run({ trigger: 'USER', target: MAIN });
    expect(tight.summarised[0]).toMatchObject({ mode: 'TEXT' });
    expect(tight.summarised[0]?.targetTokens).toBeGreaterThan(0);
    expect(tight.recorded.at(-1)).toMatchObject({
      summaryInput: { mode: 'TEXT', omittedEntries: 2 },
    });
  });

  it('asks once more, stricter, for an answer that was not a summary, and then gives up', async () => {
    const entries = big();
    const second = ports({
      entries,
      summaries: [{ kind: 'INVALID', usage: USAGE }, ok()],
      limit: 100_000,
    });
    const done = await new CompactionProcess(second.implementation).run({
      trigger: 'USER',
      target: MAIN,
    });
    expect(done).toMatchObject({ kind: 'CHANGED' });
    expect(second.log.filter((line) => line.startsWith('summarize'))).toEqual([
      'summarize PREFIX',
      'summarize PREFIX strict',
    ]);
    // What both requests used is charged to the compaction.
    expect(second.recorded.at(-1)).toMatchObject({ usage: { inputTokens: 200, outputTokens: 40 } });
    const never = ports({
      entries,
      summaries: [
        { kind: 'INVALID', usage: USAGE },
        { kind: 'INVALID', usage: USAGE },
      ],
      limit: 100_000,
    });
    expect(
      await new CompactionProcess(never.implementation).run({ trigger: 'USER', target: MAIN }),
    ).toEqual({ kind: 'FAILED', reason: 'SUMMARY_FAILED' });
    expect(never.recorded).toEqual([]);
  });

  it('falls back to the transcript when the model refuses the size, smaller each time', async () => {
    const entries = big();
    const p = ports({
      entries,
      summaries: [{ kind: 'OVERFLOW', usage: USAGE }, { kind: 'OVERFLOW', usage: USAGE }, ok(3)],
      limit: 100_000,
    });
    const outcome = await new CompactionProcess(p.implementation).run({
      trigger: 'OVERFLOW',
      target: MAIN,
      goalTokens: 1,
    });
    expect(outcome).toMatchObject({ kind: 'CHANGED' });
    const modes = p.summarised.map((request) => request.mode);
    expect(modes).toEqual(['PREFIX', 'TEXT', 'TEXT']);
    const targets = p.summarised.map((request) => request.targetTokens ?? Infinity);
    expect(targets[2]).toBeLessThan(targets[1] ?? 0);
  });

  it('fails when every fallback size was refused', async () => {
    const entries = big();
    const refused: SummaryOutcome = { kind: 'OVERFLOW', usage: USAGE };
    const p = ports({
      entries,
      summaries: Array.from({ length: 10 }, () => refused),
      limit: 100_000,
    });
    expect(
      await new CompactionProcess(p.implementation).run({ trigger: 'USER', target: MAIN }),
    ).toEqual({ kind: 'FAILED', reason: 'SUMMARY_FAILED' });
    expect(p.summarised.length).toBe(1 + CONFIG.summaryFallbackTargets.length);
  });

  it('writes nothing when the ledger will not pay, and tells a user who asked', async () => {
    const entries = big();
    const asked = ports({ entries, summaries: [{ kind: 'BUDGET' }], limit: 100_000 });
    expect(
      await new CompactionProcess(asked.implementation).run({ trigger: 'USER', target: MAIN }),
    ).toEqual({ kind: 'BUDGET' });
    expect(asked.notified).toEqual([
      { type: 'CompactionFailed', trigger: 'USER', reason: 'BUDGET_INSUFFICIENT' },
    ]);
    // An automatic one ends in the usual wrap-up, with no message of its own.
    const auto = ports({ entries, summaries: [{ kind: 'BUDGET' }], limit: 100_000 });
    await new CompactionProcess(auto.implementation).run({
      trigger: 'AUTO',
      target: MAIN,
      currentTokens: 99_999,
    });
    expect(auto.notified).toEqual([]);
  });

  it('has nothing to do for a history smaller than its newest part', async () => {
    seq = 0;
    const p = ports({ entries: [human(100), ...rounds(1, 200)] });
    expect(
      await new CompactionProcess(p.implementation).run({ trigger: 'USER', target: MAIN }),
    ).toEqual({ kind: 'UNCHANGED', reason: 'NOTHING_TO_COMPACT' });
    expect(p.notified).toEqual([
      { type: 'CompactionFailed', trigger: 'USER', reason: 'NOTHING_TO_COMPACT' },
    ]);
  });

  it('leaves a context alone that is small enough, unless the user asked', async () => {
    const entries = big();
    const small = ports({ entries, limit: 100_000 });
    expect(
      await new CompactionProcess(small.implementation).run({
        trigger: 'AUTO',
        target: MAIN,
        currentTokens: 100,
      }),
    ).toEqual({ kind: 'UNCHANGED', reason: 'SMALL_ENOUGH' });
    expect(small.log).toEqual(['source', 'prune 9']);
  });

  it('does not write a summary that Workflow could not record', async () => {
    const entries = big();
    const p = ports({ entries, summaries: [ok()], record: ['FAILED'], limit: 100_000 });
    expect(
      await new CompactionProcess(p.implementation).run({ trigger: 'USER', target: MAIN }),
    ).toEqual({ kind: 'FAILED', reason: 'NOT_RECORDED' });
    expect(p.notified).toEqual([
      { type: 'CompactionFailed', trigger: 'USER', reason: 'NOT_RECORDED' },
    ]);
    expect(p.audits.at(-1)?.type).toBe('COMPACTION_FAILED');
  });

  it('keeps a cut that took effect when the summary then fails', async () => {
    const entries = big();
    const p = ports({
      entries,
      prune: { kind: 'OK', items: [item('call_0')] },
      summaries: [{ kind: 'FAILED', usage: USAGE }],
      limit: 20_000,
    });
    const outcome = await new CompactionProcess(p.implementation).run({
      trigger: 'AUTO',
      target: MAIN,
      currentTokens: 19_900,
    });
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'SUMMARY_FAILED' });
    expect(p.recorded.map((change) => change.stage)).toEqual(['PRUNE']);
  });

  it('stops at once when the run stops it, and says nothing of it', async () => {
    const entries = big();
    const controller = new AbortController();
    const p = ports({ entries, summaries: [{ kind: 'INTERRUPTED' }], limit: 100_000 });
    expect(
      await new CompactionProcess(p.implementation).run({
        trigger: 'USER',
        target: MAIN,
        signal: controller.signal,
      }),
    ).toEqual({ kind: 'CANCELLED' });
    expect(p.notified).toEqual([]);
    controller.abort();
    const aborted = ports({ entries });
    expect(
      await new CompactionProcess(aborted.implementation).run({
        trigger: 'USER',
        target: MAIN,
        signal: controller.signal,
      }),
    ).toEqual({ kind: 'CANCELLED' });
    expect(aborted.log).toEqual(['source']);
  });

  it('does nothing when the run no longer asks for the material', async () => {
    const p = ports({ entries: undefined });
    expect(
      await new CompactionProcess(p.implementation).run({ trigger: 'USER', target: MAIN }),
    ).toEqual({ kind: 'CANCELLED' });
  });
});
