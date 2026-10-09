import { describe, expect, it } from 'vitest';
import { estimateItemTokens, estimatePackTokens, estimateTextTokens } from './token-estimate.js';

describe('token estimate', () => {
  it('counts UTF-8 bytes, so it never falls below the token count', () => {
    expect(estimateTextTokens('abc')).toBe(3);
    expect(estimateTextTokens('中文')).toBe(6);
  });

  it('includes tool calls and tool specs and adds a fixed overhead per item', () => {
    const plain = estimateItemTokens({ role: 'user', content: 'hello' });
    expect(plain).toBe(Buffer.byteLength('{"content":"hello","role":"user"}') + 16);
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
    expect(withCalls).toBeGreaterThan(plain);
    expect(withSpecs).toBeGreaterThan(plain);
  });

  it('is stable and sums the items of a pack', () => {
    const items = [
      { role: 'system', content: 'a' },
      { role: 'tool', content: 'b', toolCallId: 'call_1' },
    ] as const;
    const total = estimateItemTokens(items[0]) + estimateItemTokens(items[1]);
    expect(estimatePackTokens({ items: items as never })).toBe(total);
    expect(estimatePackTokens({ items: items as never })).toBe(total);
  });
});
