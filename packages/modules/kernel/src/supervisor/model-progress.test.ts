import {
  MODEL_PROGRESS_MAX_DELTA,
  type ExecutionRequest,
  type ModelProgress,
} from '@multiagentos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROGRESS_COALESCE_MS, modelProgressOf } from './model-progress.js';

const request = {
  sessionId: 'ses_01JSESSION0000000000000001',
  workflowRunId: 'wfr_01JRUN0000000000000000001',
  executionId: 'exe_01JEXEC0000000000000000001',
} as unknown as ExecutionRequest;

function watcher() {
  const sent: ModelProgress[] = [];
  const progress = modelProgressOf(
    request,
    (message) => void sent.push(message),
    () => new Date(0),
  );
  return { sent, progress };
}

describe('modelProgressOf', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges the pieces that come within a short time into one message', () => {
    const { sent, progress } = watcher();
    progress({ kind: 'REASONING', delta: 'The ' });
    progress({ kind: 'REASONING', delta: 'user ' });
    progress({ kind: 'REASONING', delta: 'says hi.' });
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(PROGRESS_COALESCE_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'REASONING',
      delta: 'The user says hi.',
      sessionId: request.sessionId,
      executionId: request.executionId,
    });
  });

  it('sends what it holds before the end, and the end at once', () => {
    const { sent, progress } = watcher();
    progress({ kind: 'REASONING', delta: 'last words' });
    progress({ kind: 'END' });
    expect(sent.map((message) => message.kind)).toEqual(['REASONING', 'END']);
    // Nothing is left to go out later.
    vi.advanceTimersByTime(PROGRESS_COALESCE_MS * 4);
    expect(sent).toHaveLength(2);
  });

  it('keeps every message within the size the contract allows', () => {
    const { sent, progress } = watcher();
    progress({ kind: 'REASONING', delta: 'x'.repeat(MODEL_PROGRESS_MAX_DELTA * 2 + 5) });
    progress({ kind: 'END' });
    const pieces = sent.filter((message) => message.kind === 'REASONING');
    expect(pieces.length).toBe(3);
    for (const message of pieces)
      if (message.kind === 'REASONING')
        expect(message.delta.length).toBeLessThanOrEqual(MODEL_PROGRESS_MAX_DELTA);
    expect(
      pieces.map((message) => (message.kind === 'REASONING' ? message.delta : '')).join('').length,
    ).toBe(MODEL_PROGRESS_MAX_DELTA * 2 + 5);
  });
});

describe('modelProgressOf sends the start of the answer and the end at once', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the thinking it holds before the start of the answer, so the order is kept', () => {
    const sent: ModelProgress[] = [];
    const progress = modelProgressOf(
      request,
      (message) => void sent.push(message),
      () => new Date(0),
    );
    progress({ kind: 'REASONING', delta: 'think ' });
    progress({ kind: 'REASONING', delta: 'more' });
    progress({ kind: 'TOOL', name: 'write_file', target: 'a.docx' });
    progress({ kind: 'ANSWER' });
    progress({ kind: 'END' });
    expect(sent.map((message) => [message.kind, 'delta' in message ? message.delta : ''])).toEqual([
      ['REASONING', 'think more'],
      ['TOOL', ''],
      ['ANSWER', ''],
      ['END', ''],
    ]);
  });
});
