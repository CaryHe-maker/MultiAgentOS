import { describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

describe('control-plane entry', () => {
  it('returns usage errors before composing or starting the system', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(main(['analyze', '--repo', 'relative', 'Explain X'])).resolves.toBe(64);
      await expect(main(['analyze', '--repo', '/repo'])).resolves.toBe(64);
    } finally {
      write.mockRestore();
    }
  });
});
