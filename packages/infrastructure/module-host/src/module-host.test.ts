import type { LifecyclePort, ModuleId } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { ModuleHost } from './index.js';

function module(
  moduleId: ModuleId,
  dependencies: readonly ModuleId[],
  log: string[],
  failOnStart = false,
): LifecyclePort {
  return {
    manifest: { moduleId, version: '0.1.0', dependencies },
    start: () => {
      if (failOnStart) return Promise.reject(new Error(`${moduleId} failed`));
      log.push(`start ${moduleId}`);
      return Promise.resolve();
    },
    stop: () => {
      log.push(`stop ${moduleId}`);
      return Promise.resolve();
    },
    health: () =>
      Promise.resolve({ status: 'UP', checkedAt: '2026-10-09T00:00:00.000Z', details: [] }),
  };
}

describe('ModuleHost', () => {
  it('starts in dependency order and stops in the reverse order', async () => {
    const log: string[] = [];
    const host = new ModuleHost();
    host.register(module('workflow', ['gateway'], log));
    host.register(module('gateway', ['kernel-core'], log));
    host.register(module('kernel-core', ['fabric'], log));
    host.register(module('fabric', [], log));
    await host.start();
    await host.stop();
    expect(log).toEqual([
      'start fabric',
      'start kernel-core',
      'start gateway',
      'start workflow',
      'stop workflow',
      'stop gateway',
      'stop kernel-core',
      'stop fabric',
    ]);
    expect([...(await host.health()).keys()]).toHaveLength(4);
  });

  it('stops the started modules again when one fails to start', async () => {
    const log: string[] = [];
    const host = new ModuleHost();
    host.register(module('fabric', [], log));
    host.register(module('persistence', ['fabric'], log));
    host.register(module('kernel-core', ['persistence'], log, true));
    await expect(host.start()).rejects.toThrow('kernel-core failed');
    expect(log).toEqual(['start fabric', 'start persistence', 'stop persistence', 'stop fabric']);
  });

  it('runs an after-start hook before dependent modules and rolls it back on failure', async () => {
    const log: string[] = [];
    const host = new ModuleHost();
    host.register(module('fabric', [], log));
    host.register(module('kernel-core', ['fabric'], log));
    await expect(
      host.start((moduleId) => {
        log.push(`ready ${moduleId}`);
        if (moduleId === 'fabric') throw new Error('registration failed');
      }),
    ).rejects.toThrow('registration failed');
    expect(log).toEqual(['start fabric', 'ready fabric', 'stop fabric']);
  });

  it('preserves both the hook and rollback errors', async () => {
    const host = new ModuleHost();
    host.register({
      manifest: { moduleId: 'fabric', version: '0.1.0', dependencies: [] },
      start: () => Promise.resolve(),
      stop: () => Promise.reject(new Error('rollback failed')),
      health: () => Promise.resolve({ status: 'UP', checkedAt: '', details: [] }),
    });
    await expect(
      host.start(() => {
        throw new Error('registration failed');
      }),
    ).rejects.toMatchObject({
      errors: [new Error('registration failed'), expect.any(AggregateError)],
    });
  });

  it('rejects duplicates, missing dependencies and cycles', () => {
    const host = new ModuleHost();
    host.register(module('fabric', ['gateway'], []));
    expect(() => host.register(module('fabric', [], []))).toThrow('DUPLICATE_MODULE');
    expect(() => host.startOrder()).toThrow('MISSING_DEPENDENCY');
    host.register(module('gateway', ['fabric'], []));
    expect(() => host.startOrder()).toThrow('DEPENDENCY_CYCLE');
  });
});
