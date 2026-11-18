import { describe, expect, it } from 'vitest';
import {
  calibratedTokens,
  estimateItemTokens,
  estimatePackTokens,
  estimateTextTokens,
} from './token-estimate.js';

/** Provider counts of these kinds of text were 2 to 5 bytes per token; bytes alone cannot do it. */
describe('token estimate', () => {
  it('reads each kind of text at about its own density', () => {
    const size = (text: string) => estimateTextTokens(text) / Buffer.byteLength(text);
    const english = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const chinese = '上下文压缩的摘要调用从被压缩对象所用的账本支出。'.repeat(20);
    const digits = '12345,67890,'.repeat(40);
    const encoded = 'aGVsbG8gd29ybGQ1NDMyMQ9xR2tLmZ8='.repeat(20);
    expect(size(english)).toBeGreaterThan(0.15);
    expect(size(english)).toBeLessThan(0.35);
    expect(size(chinese)).toBeGreaterThan(0.15);
    expect(size(chinese)).toBeLessThan(0.25);
    expect(size(digits)).toBeGreaterThan(0.4);
    expect(size(encoded)).toBeGreaterThan(0.45);
  });

  it('never counts a text of one kind of segment as nothing', () => {
    for (const text of ['hello ', 'abc ', 'a ', 'internationalization ', '- ', '\n\n ', '🙂 '])
      expect(estimateTextTokens(text.repeat(100))).toBeGreaterThanOrEqual(30);
  });

  it('counts replayed reasoning, tool calls and tool specs', () => {
    const plain = estimateItemTokens({ role: 'user', content: 'hello' });
    const withReasoning = estimateItemTokens({
      role: 'assistant',
      content: 'hello',
      reasoningContent: 'I should read the file first and then edit it.',
    });
    const withCalls = estimateItemTokens({
      role: 'assistant',
      content: 'hello',
      toolCalls: [{ toolCallId: 'call_1', toolName: 'read_file', arguments: { path: 'a.ts' } }],
    });
    const withSpecs = estimateItemTokens({
      role: 'system',
      content: 'hello',
      toolSpecs: [
        {
          name: 'read_file',
          description: 'Read.',
          parameters: { type: 'object' },
          purpose: 'UNIT',
        },
      ],
    });
    expect(withReasoning).toBeGreaterThan(plain);
    expect(withCalls).toBeGreaterThan(plain);
    expect(withSpecs).toBeGreaterThan(plain);
  });

  it('is stable and sums the items of a pack', () => {
    const items = [
      { role: 'system', content: 'a' },
      { role: 'tool', content: 'b', toolCallId: 'call_1' },
    ] as const;
    const total = estimateItemTokens(items[0]) + estimateItemTokens(items[1]);
    expect(estimatePackTokens({ items: items })).toBe(total);
    expect(estimatePackTokens({ items: items })).toBe(total);
  });
});

describe('calibrated tokens', () => {
  const calibration = { measuredInputTokens: 1_100, estimatedInputTokens: 1_000 };

  it('leaves the estimate alone without a measurement', () => {
    expect(calibratedTokens(1_234)).toBe(1_234);
  });

  it('scales the estimate by the last measured error', () => {
    expect(calibratedTokens(2_000, calibration)).toBe(2_200);
  });

  it('does not scale a request that no longer shares the measured prefix', () => {
    expect(calibratedTokens(699, calibration)).toBe(699);
    expect(calibratedTokens(700, calibration)).toBe(770);
  });
});
