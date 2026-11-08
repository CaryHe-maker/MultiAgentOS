import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ArtifactRef } from '../platform-common/common-schemas.js';
import { applyCompactions } from './compaction-projection.js';
import { estimateContext } from './compaction-estimate.js';
import { planCompaction } from './compaction-plan.js';
import type { ContextHistoryEntry } from './history-entry.js';

const ref = (size: number, digit = 'a'): ArtifactRef => ({
  artifactId: `art_${digit.repeat(64)}`,
  sha256: digit.repeat(64),
  size,
  mediaType: 'text/plain',
});
const TURN = 'trn_aaaaaaaa';
const CONFIG = {
  keepTokens: 1_000,
  keepHumanBytes: 1_000,
  pruneMinBytes: 2_000,
  minReplacedTokens: 100,
};

/** A user message, a model turn and the result of its call, one after another. */
let next = 1;
const seq = () => next++;
const human = (size: number, over: Partial<ContextHistoryEntry> = {}): ContextHistoryEntry =>
  ({
    seq: seq(),
    turnId: TURN,
    category: 'NORMAL',
    kind: 'HUMAN',
    contentRef: ref(size),
    ...over,
  }) as ContextHistoryEntry;
const turn = (size: number): ContextHistoryEntry => ({
  seq: seq(),
  turnId: TURN,
  category: 'NORMAL',
  kind: 'MODEL_TURN',
  modelId: 'm',
  outputRef: ref(size),
  replayable: false,
});
const result = (id: string, size: number, over: object = {}): ContextHistoryEntry => ({
  seq: seq(),
  turnId: TURN,
  category: 'NORMAL',
  kind: 'TOOL_RESULT',
  toolCallId: id,
  toolName: 'read_file',
  status: 'OK',
  outputRef: ref(size),
  requestId: `req_${id}000000`,
  ...over,
});

const rounds = (count: number, size: number): ContextHistoryEntry[] =>
  Array.from({ length: count }, (_, index) => [
    turn(200),
    result(`call_${String(index)}`, size),
  ]).flat();

describe('what a compaction touches', () => {
  it('leaves a history alone that is smaller than the newest part', () => {
    next = 1;
    expect(planCompaction([human(100), ...rounds(1, 300)], CONFIG)).toEqual({
      keepFrom: 0,
      prunable: [],
    });
  });

  it('keeps the newest part from the start of a whole model turn', () => {
    next = 1;
    const entries = [human(100), ...rounds(6, 800)];
    const plan = planCompaction(entries, CONFIG);
    const first = entries[plan.keepFrom];
    expect(first?.kind).toBe('MODEL_TURN');
    // What is kept is at least what was asked, and it does not start in the middle of a round.
    const kept = entries.slice(plan.keepFrom);
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(plan.range).toBeDefined();
  });

  it('replaces the older entries, keeps the PINNED ones and the newest user messages that fit', () => {
    next = 1;
    const user = human(400);
    const pinned = human(300, { category: 'PINNED' });
    const longer = human(450);
    const huge = human(5_000);
    const entries: ContextHistoryEntry[] = [
      user,
      ...rounds(2, 600),
      pinned,
      ...rounds(1, 600),
      longer,
      huge,
      ...rounds(6, 800),
    ];
    const range = planCompaction(entries, CONFIG).range;
    if (range === undefined) throw new Error('no range');
    const kept = new Set(range.keptSeqs);
    expect(kept.has(pinned.seq)).toBe(true);
    // The newest that fit: 450, then 400 (together 850 of the 1000); the 5000 is too long.
    expect(kept.has(longer.seq)).toBe(true);
    expect(kept.has(user.seq)).toBe(true);
    expect(kept.has(huge.seq)).toBe(false);
    expect(range.replacedEntries).toBeGreaterThan(0);
  });

  it('lets a user message go when the newer ones have used the room', () => {
    next = 1;
    const old = human(400);
    const newer = human(480);
    const newest = human(480);
    const entries: ContextHistoryEntry[] = [
      old,
      ...rounds(2, 600),
      newer,
      newest,
      ...rounds(6, 800),
    ];
    const range = planCompaction(entries, CONFIG).range;
    if (range === undefined) throw new Error('no range');
    expect(new Set(range.keptSeqs)).toEqual(new Set([newer.seq, newest.seq]));
  });

  it('names the big tool results of the old part as the ones to cut, and none that is cut', () => {
    next = 1;
    const entries: ContextHistoryEntry[] = [
      human(100),
      turn(100),
      result('call_big', 9_000, { fullRef: ref(50_000, 'f') }),
      turn(100),
      result('call_small', 500),
      turn(100),
      result('call_done', 9_000, { prunedAt: 3 }),
      ...rounds(6, 800),
    ];
    const plan = planCompaction(entries, CONFIG);
    expect(plan.prunable.map((item) => item.toolCallId)).toEqual(['call_big']);
    expect(plan.prunable[0]?.fullRef?.size).toBe(50_000);
  });

  it('stops the range before an entry of the newest part that carries an early seq', () => {
    next = 1;
    const entries = [human(900), ...rounds(3, 800)];
    // A note that was slipped in late: it stands in the newest part but its seq is early.
    const late: ContextHistoryEntry = { seq: 2, category: 'NORMAL', kind: 'NOTE', text: 'late' };
    const plan = planCompaction([...entries, ...rounds(3, 800), late], CONFIG);
    expect(plan.range?.toSeq).toBeLessThan(2);
  });

  it('does not make a range of what is not worth a summary', () => {
    next = 1;
    const entries = [turn(40), result('call_a', 40), turn(40), result('call_b', 40)];
    const plan = planCompaction(entries, { ...CONFIG, keepTokens: 20 });
    expect(plan.range).toBeUndefined();
  });

  it('puts an earlier summary into the range of the next one', () => {
    next = 1;
    const summary: ContextHistoryEntry = {
      seq: 90,
      category: 'NORMAL',
      kind: 'SUMMARY',
      compactionId: 'cmp_aaaaaaaa',
      fromSeq: 1,
      toSeq: 40,
      contentRef: ref(3_000),
    };
    next = 100;
    const plan = planCompaction([summary, ...rounds(8, 800)], CONFIG);
    expect(plan.range?.fromSeq).toBe(1);
    expect(plan.range?.replacedEntries).toBeGreaterThanOrEqual(2);
  });

  it('does not make a range of an earlier summary alone, however large it is', () => {
    next = 1;
    const summary: ContextHistoryEntry = {
      seq: 90,
      category: 'NORMAL',
      kind: 'SUMMARY',
      compactionId: 'cmp_aaaaaaaa',
      fromSeq: 1,
      toSeq: 40,
      contentRef: ref(30_000),
    };
    // Nothing since the summary but the newest part: a summary of a summary says nothing new.
    next = 100;
    const plan = planCompaction([summary, ...rounds(2, 800)], { ...CONFIG, keepTokens: 500 });
    expect(plan.keepFrom).toBeGreaterThan(0);
    expect(plan.range).toBeUndefined();
  });
});

describe('what the records do to the entries', () => {
  const base = (): ContextHistoryEntry[] => {
    next = 1;
    return [human(300, { category: 'PINNED' }), human(400), ...rounds(3, 600), ...rounds(3, 600)];
  };

  it('puts the summary where the first replaced entry stood, and the kept ones after it', () => {
    const entries = base();
    const [pinned, user, ...rest] = entries;
    if (pinned === undefined || user === undefined) throw new Error('fixture');
    const lastReplaced = rest[3];
    const shown = applyCompactions(entries, {
      pruned: [],
      revoked: new Set(),
      compacted: [
        {
          type: 'CONTEXT_COMPACTED',
          seq: 500,
          compactionId: 'cmp_aaaaaaaa',
          fromSeq: pinned.seq,
          toSeq: lastReplaced?.seq ?? 0,
          keptSeqs: [pinned.seq, user.seq],
          summaryRef: ref(10, 's'),
        },
      ] as never,
    });
    expect(shown.map((entry) => entry.kind).slice(0, 3)).toEqual(['SUMMARY', 'HUMAN', 'HUMAN']);
    expect(shown[1]?.seq).toBe(pinned.seq);
    expect(shown[2]?.seq).toBe(user.seq);
    // What was after the range is as it was.
    expect(shown.slice(3).map((entry) => entry.seq)).toEqual(
      rest.filter((entry) => entry.seq > (lastReplaced?.seq ?? 0)).map((entry) => entry.seq),
    );
  });

  it('does not take a revoked summary into account, and keeps what was pruned', () => {
    const entries = base();
    const target = entries.find((entry) => entry.kind === 'TOOL_RESULT');
    if (target === undefined || target.kind !== 'TOOL_RESULT') throw new Error('fixture');
    const shown = applyCompactions(entries, {
      pruned: [
        {
          type: 'TOOL_RESULTS_PRUNED',
          seq: 400,
          compactionId: 'cmp_bbbbbbbb',
          items: [
            {
              requestId: 'req_x',
              toolCallId: target.toolCallId,
              prunedRef: ref(5, 'p'),
              readableRef: ref(9, 'q'),
              omittedBytes: 10,
            },
          ],
        },
      ] as never,
      revoked: new Set(['cmp_aaaaaaaa']),
      compacted: [
        {
          type: 'CONTEXT_COMPACTED',
          seq: 500,
          compactionId: 'cmp_aaaaaaaa',
          fromSeq: 1,
          toSeq: 6,
          keptSeqs: [],
          summaryRef: ref(10, 's'),
        },
      ] as never,
    });
    expect(shown.some((entry) => entry.kind === 'SUMMARY')).toBe(false);
    const cut = shown.find(
      (entry) => entry.kind === 'TOOL_RESULT' && entry.toolCallId === target.toolCallId,
    );
    expect(cut).toMatchObject({ prunedAt: 400, outputRef: { size: 5 } });
    expect(shown).toHaveLength(entries.length);
  });

  it('changes nothing when the range holds nothing to replace', () => {
    const entries = base();
    const shown = applyCompactions(entries, {
      pruned: [],
      revoked: new Set(),
      compacted: [
        {
          type: 'CONTEXT_COMPACTED',
          seq: 500,
          compactionId: 'cmp_aaaaaaaa',
          fromSeq: 900,
          toSeq: 950,
          keptSeqs: [],
          summaryRef: ref(10, 's'),
        },
      ] as never,
    });
    expect(shown).toEqual(entries);
  });

  it('never leaves a result without its call in what it replaces (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 12 }),
        fc.integer({ min: 100, max: 900 }),
        (count, size) => {
          next = 1;
          const entries = [human(200), ...rounds(count, size)];
          const plan = planCompaction(entries, CONFIG);
          if (plan.range === undefined) return true;
          const shown = applyCompactions(entries, {
            pruned: [],
            revoked: new Set(),
            compacted: [
              {
                type: 'CONTEXT_COMPACTED',
                seq: 9_999,
                compactionId: 'cmp_cccccccc',
                ...plan.range,
                summaryRef: ref(10, 's'),
              },
            ] as never,
          });
          // Every tool result that is shown follows the model turn that made the call.
          let open = false;
          for (const entry of shown) {
            if (entry.kind === 'MODEL_TURN') open = true;
            if (entry.kind === 'TOOL_RESULT' && !open) return false;
          }
          return true;
        },
      ),
    );
  });
});

describe('how big the next request will be', () => {
  const head = 'h'.repeat(64);
  const measuredTurn = (
    inputTokens: number,
    headDigest = head,
    at?: number,
  ): ContextHistoryEntry => ({
    seq: at ?? seq(),
    category: 'NORMAL',
    kind: 'MODEL_TURN',
    modelId: 'm',
    outputRef: ref(100),
    replayable: false,
    measured: { inputTokens, outputTokens: 50, headDigest },
  });
  const input = (entries: ContextHistoryEntry[]) => ({
    entries,
    headDigest: head,
    headTokens: 1_000,
    statusTokens: 100,
  });

  it('starts from what the provider counted, and adds what came after', () => {
    next = 1;
    const entries = [human(4_000), measuredTurn(30_000), result('call_1', 4_000)];
    const estimate = estimateContext(input(entries));
    expect(estimate.measured).toBe(true);
    expect(estimate.tokens).toBe(30_000 + 50 + Math.ceil((4_000 + 24) * 0.4) + 100);
  });

  it('counts the bytes when the head of the request is not the one that was counted', () => {
    next = 1;
    const entries = [human(4_000), measuredTurn(30_000, 'x'.repeat(64)), result('call_1', 4_000)];
    const estimate = estimateContext(input(entries));
    expect(estimate.measured).toBe(false);
    expect(estimate.tokens).toBeLessThan(10_000);
  });

  it('does not rely on a count that a summary or a cut came after', () => {
    next = 1;
    const afterSummary: ContextHistoryEntry[] = [
      measuredTurn(30_000, head, 5),
      {
        seq: 9,
        category: 'NORMAL',
        kind: 'SUMMARY',
        compactionId: 'cmp_aaaaaaaa',
        fromSeq: 1,
        toSeq: 4,
        contentRef: ref(100),
      },
    ];
    expect(estimateContext(input(afterSummary)).measured).toBe(false);
    const afterCut: ContextHistoryEntry[] = [
      measuredTurn(30_000, head, 5),
      {
        seq: 6,
        category: 'NORMAL',
        kind: 'TOOL_RESULT',
        toolCallId: 'call_1',
        toolName: 'x',
        status: 'OK',
        outputRef: ref(10),
        prunedAt: 8,
      },
    ];
    expect(estimateContext(input(afterCut)).measured).toBe(false);
  });

  it('relies on a count that was made after the summary', () => {
    next = 1;
    const entries: ContextHistoryEntry[] = [
      {
        seq: 9,
        category: 'NORMAL',
        kind: 'SUMMARY',
        compactionId: 'cmp_aaaaaaaa',
        fromSeq: 1,
        toSeq: 4,
        contentRef: ref(100),
      },
      measuredTurn(12_000, head, 12),
    ];
    expect(estimateContext(input(entries))).toMatchObject({
      measured: true,
      tokens: 12_000 + 50 + 100,
    });
  });

  it('uses the last turn that was counted, not an older one', () => {
    next = 1;
    const entries = [measuredTurn(5_000), result('call_1', 100), measuredTurn(9_000)];
    expect(estimateContext(input(entries)).tokens).toBe(9_000 + 50 + 100);
  });
});
