import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

describe('control-plane entry', () => {
  it('returns usage errors before composing or starting the system', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(main(['analyse'])).resolves.toBe(64);
      // A goal alone is a run of the template mission; nothing at all is a usage error.
      await expect(main(['run'])).resolves.toBe(64);
      await expect(main(['--unknown'])).resolves.toBe(64);
    } finally {
      write.mockRestore();
    }
  });

  it('returns 70 when configuration fails before a system exists', async () => {
    const previous = process.env['MULTIAGENTOS_CONFIG'];
    process.env['MULTIAGENTOS_CONFIG'] = join(tmpdir(), 'missing-multiagentos-config.json');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(main(['run', '--repo', tmpdir(), 'Explain X'])).resolves.toBe(70);
    } finally {
      if (previous === undefined) delete process.env['MULTIAGENTOS_CONFIG'];
      else process.env['MULTIAGENTOS_CONFIG'] = previous;
      write.mockRestore();
    }
  });
});
