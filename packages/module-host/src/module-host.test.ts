import { describe, expect, it } from 'vitest';
import { ModuleHost, simpleLifecycle } from './index.js';

describe('FR-HOST-001 lifecycle host', () => {
  it('starts dependencies and reports health', async () => {
    const host = new ModuleHost();
    host.register(simpleLifecycle('base'));
    host.register(simpleLifecycle('dependent', ['base']));
    await host.start();
    expect(await host.health()).toMatchObject({
      base: { status: 'UP' },
      dependent: { status: 'UP' },
    });
    await host.stop();
    expect(await host.health()).toMatchObject({
      base: { status: 'DOWN' },
      dependent: { status: 'DOWN' },
    });
  });
  it('rejects dependency cycles', async () => {
    const host = new ModuleHost();
    host.register(simpleLifecycle('a', ['b']));
    host.register(simpleLifecycle('b', ['a']));
    await expect(host.start()).rejects.toThrow('cycle');
  });
});
