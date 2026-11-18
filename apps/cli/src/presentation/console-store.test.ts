import type { LiveState, ThinkingView } from '@multiagentos/user-interaction';
import { describe, expect, it } from 'vitest';
import { ConsoleStore } from './console-store.js';

const view = (number: number, state: ThinkingView['state'] = 'DONE'): ThinkingView => ({
  id: `exe_${String(number)}`,
  number,
  label: 'main',
  state,
  startedAt: '2026-11-07T10:00:00.000Z',
  ...(state === 'OPEN' ? {} : { endedAt: '2026-11-07T10:00:03.200Z' }),
  text: `thought ${String(number)}`,
});

const live = (...blocks: ThinkingView[]): LiveState => ({
  status: '',
  activity: [],
  waiting: 0,
  queued: [],
  thinking: blocks,
});

const FOLDED = (number: number) => `✻ main 思考 3.2s（/think ${String(number)} 展开）`;

/** What the terminal would show, top to bottom: the scroll-back, then the part drawn in place. */
function screen(store: ConsoleStore): string[] {
  const { static: written, tail } = store.snapshot();
  return [
    ...written.map((item) => (item.kind === 'RECORD' ? item.record.text : item.text)),
    '--- in place ---',
    ...tail.map((item) =>
      item.kind === 'RECORD' ? item.record.text : `[block ${String(item.block.number)}]`,
    ),
  ];
}

describe('ConsoleStore', () => {
  it('writes records at once while nothing has been thought', () => {
    const store = new ConsoleStore();
    store.print({ kind: 'USER', text: 'hello' });
    store.print({ kind: 'NOTICE', text: 'opened' });
    expect(screen(store)).toEqual(['hello', 'opened', '--- in place ---']);
  });

  it('keeps the first block and what follows it in place, in the order it happened', () => {
    const store = new ConsoleStore();
    store.print({ kind: 'USER', text: 'question' });
    store.update(live(view(1, 'OPEN')));
    store.print({ kind: 'NOTICE', text: 'allowed' });
    store.print({ kind: 'STEP', text: 'step' });
    // The question came before the block and is final; the rest waits with the block.
    expect(screen(store)).toEqual(['question', '--- in place ---', '[block 1]', 'allowed', 'step']);
  });

  it('keeps every block open, and what is between them, until the view folds one', () => {
    const store = new ConsoleStore();
    store.print({ kind: 'USER', text: 'question' });
    store.update(live(view(1)));
    store.print({ kind: 'NOTICE', text: 'allowed' });
    store.update(live(view(1), view(2)));
    store.print({ kind: 'STEP', text: 'step' });
    store.update(live(view(1), view(2), view(3, 'OPEN')));
    expect(screen(store)).toEqual([
      'question',
      '--- in place ---',
      '[block 1]',
      'allowed',
      '[block 2]',
      'step',
      '[block 3]',
    ]);
  });

  it('moves a folded block and what came before the next open one into the scroll-back', () => {
    const store = new ConsoleStore();
    store.print({ kind: 'USER', text: 'question' });
    store.update(live(view(1)));
    store.print({ kind: 'NOTICE', text: 'allowed' });
    store.update(live(view(1), view(2)));
    store.print({ kind: 'STEP', text: 'step' });
    store.update(live(view(1), view(2), view(3, 'OPEN')));

    store.foldBlocks(['exe_1']);
    // Block 1 is one folded line, and `allowed`, which came before block 2, goes with it.
    expect(screen(store)).toEqual([
      'question',
      FOLDED(1),
      'allowed',
      '--- in place ---',
      '[block 2]',
      'step',
      '[block 3]',
    ]);
    store.print({ kind: 'REPLY', agentLabel: 'main', text: 'the answer' });
    store.foldBlocks(['exe_2']);
    expect(screen(store)).toEqual([
      'question',
      FOLDED(1),
      'allowed',
      FOLDED(2),
      'step',
      '--- in place ---',
      '[block 3]',
      'the answer',
    ]);
  });

  it('writes everything at once when no block is open any more', () => {
    const store = new ConsoleStore();
    store.update(live(view(1)));
    store.print({ kind: 'STEP', text: 'step' });
    store.foldBlocks(['exe_1']);
    expect(screen(store)).toEqual([FOLDED(1), 'step', '--- in place ---']);
    store.print({ kind: 'REPLY', agentLabel: 'main', text: 'the answer' });
    expect(screen(store)).toEqual([FOLDED(1), 'step', 'the answer', '--- in place ---']);
  });

  it('never opens a folded block again, however often the console passes it', () => {
    const store = new ConsoleStore();
    store.update(live(view(1), view(2)));
    store.foldBlocks(['exe_1']);
    store.update(live(view(1), view(2, 'OPEN')));
    store.update(live(view(1), view(2), view(3)));
    expect(screen(store)).toEqual([FOLDED(1), '--- in place ---', '[block 2]', '[block 3]']);
    // Folding what is folded already changes nothing.
    store.foldBlocks(['exe_1']);
    expect(store.snapshot().static).toHaveLength(1);
  });

  it('folds a block that was cut at its beginning when the next block begins', () => {
    const store = new ConsoleStore();
    store.update(live(view(1, 'OPEN')));
    store.markElided(['exe_1']);
    // Still the same thinking: nothing is folded.
    store.update(live(view(1)));
    expect(screen(store)).toEqual(['--- in place ---', '[block 1]']);
    // The next one begins: the one that was cut is folded at once.
    store.update(live(view(1), view(2, 'OPEN')));
    expect(screen(store)).toEqual([FOLDED(1), '--- in place ---', '[block 2]']);
  });

  it('does not fold a block that was cut when a later one is only an update of itself', () => {
    const store = new ConsoleStore();
    store.update(live(view(1, 'OPEN')));
    store.markElided(['exe_1']);
    store.update(live({ ...view(1, 'OPEN'), text: 'more and more' }));
    expect(store.snapshot().static).toHaveLength(0);
  });

  it('only ever adds to the scroll-back', () => {
    const store = new ConsoleStore();
    const seen: number[] = [];
    store.subscribe(() => void seen.push(store.snapshot().static.length));
    store.print({ kind: 'USER', text: 'a' });
    store.update(live(view(1)));
    store.print({ kind: 'NOTICE', text: 'b' });
    store.update(live(view(1), view(2)));
    store.foldBlocks(['exe_1']);
    store.update(live(view(1), view(2), view(3)));
    store.foldBlocks(['exe_2']);
    expect(seen).toEqual([...seen].sort((left, right) => left - right));
    const ids = store.snapshot().static.map((item) => item.id);
    expect(ids).toEqual([...ids].sort((left, right) => left - right));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('moves a block that the console no longer passes into the scroll-back as a line', () => {
    const store = new ConsoleStore();
    store.update(live(view(1)));
    store.print({ kind: 'NOTICE', text: 'after' });
    // Another Session: the console starts again without any block.
    store.update(live());
    expect(screen(store)).toEqual([FOLDED(1), 'after', '--- in place ---']);
  });

  it('moves the oldest items into the scroll-back when the view runs out of room', () => {
    const store = new ConsoleStore();
    store.update(live(view(1)));
    store.print({ kind: 'NOTICE', text: 'one' });
    store.print({ kind: 'NOTICE', text: 'two' });
    store.print({ kind: 'NOTICE', text: 'three' });
    const second = store.snapshot().tail[1];
    expect(second?.kind).toBe('RECORD');
    store.advanceFloor(second?.seq ?? 0);
    expect(screen(store)).toEqual([FOLDED(1), '--- in place ---', 'one', 'two', 'three']);
    // A floor that has been passed does not move back.
    store.advanceFloor(1);
    expect(store.snapshot().static).toHaveLength(1);
  });

  it('gives the latest state of a block in place', () => {
    const store = new ConsoleStore();
    store.update(live(view(1, 'OPEN')));
    store.update(live({ ...view(1, 'OPEN'), text: 'more and more' }));
    const [item] = store.snapshot().tail;
    expect(item?.kind === 'BLOCK' ? item.block.text : '').toBe('more and more');
  });
});
