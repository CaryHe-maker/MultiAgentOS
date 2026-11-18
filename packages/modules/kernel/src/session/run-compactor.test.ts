import { describe, expect, it } from 'vitest';
import { DEFAULT_KERNEL_CONFIG } from '../interfaces/kernel-config.js';
import { summaryScope } from './run-compactor.js';

const scope = {
  kind: 'MODEL',
  provider: 'deepseek',
  apiModelId: 'deepseek-flash',
  apiProtocol: 'OPENAI_CHAT',
  baseUrl: 'https://api.deepseek.com',
  thinking: 'ENABLED',
  thinkingEffort: 'high',
} as unknown as Parameters<typeof summaryScope>[0];

describe('the summary request', () => {
  it('does not think and has room for a whole summary by default', () => {
    // Real use: with thinking on, 8192 tokens went to the thinking, or ran out before the last
    // sections of the summary.
    expect(DEFAULT_KERNEL_CONFIG.compaction.summaryReasoningEffort).toBe('none');
    expect(DEFAULT_KERNEL_CONFIG.compaction.summaryMaxTokens).toBe(16_384);
  });

  it('is sent with thinking off when the configuration says none, and on at the given effort otherwise', () => {
    const off = summaryScope(scope, 'none');
    expect(off).toMatchObject({ thinking: 'DISABLED' });
    expect(off).not.toHaveProperty('thinkingEffort');
    expect(summaryScope(scope, 'low')).toMatchObject({
      thinking: 'ENABLED',
      thinkingEffort: 'low',
    });
  });
});
