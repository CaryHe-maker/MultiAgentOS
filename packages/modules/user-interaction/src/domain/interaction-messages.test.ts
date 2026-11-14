import { describe, expect, it } from 'vitest';
import { REASON_CODES } from '@multiagentos/contracts';
import { describeReason } from './interaction-messages.js';

describe('describeReason', () => {
  it('provides Chinese descriptions for every reason and a safe fallback', () => {
    for (const code of REASON_CODES) expect(describeReason(code)).toMatch(/[一-鿿]/u);
    expect(describeReason('unrecognized-secret')).toBe('请求未能完成，请检查运行配置。');
    expect(describeReason('toString')).toBe('请求未能完成，请检查运行配置。');
  });
});
