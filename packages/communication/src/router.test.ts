import { describe, expect, it } from 'vitest';
import { InMemoryMessageRouter } from './index.js';

describe('FR-COM-002 in-process router', () => {
  it('preserves request/handler semantics', async () => {
    const router = new InMemoryMessageRouter();
    router.register<{ value: number }, { value: number }>('test.Double.v0', (request) =>
      Promise.resolve({ value: request.value * 2 }),
    );
    await expect(router.request('test.Double.v0', { value: 3 })).resolves.toEqual({ value: 6 });
    await expect(router.request('test.Missing.v0', {})).rejects.toThrow('NO_HANDLER');
  });
});
