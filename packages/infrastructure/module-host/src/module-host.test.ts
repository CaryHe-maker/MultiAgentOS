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
    // The failed module may hold what it acquired before it threw, so it is stopped as well.
    expect(log).toEqual([
      'start fabric',
      'start persistence',
      'stop kernel-core',
      'stop persistence',
      'stop fabric',
    ]);
    expect(host.ledger().map((entry) => entry.state)).toEqual(['STOPPED', 'STOPPED', 'STOPPED']);
    // A clean rollback leaves the host startable; the Supervisor may retry the boot.
    await expect(host.start()).rejects.toThrow('kernel-core failed');
  });

  it('keeps a failed stop in the ledger, stops the rest and does not retry it', async () => {
    const log: string[] = [];
    const host = new ModuleHost();
    host.register(module('fabric', [], log));
    let stops = 0;
    host.register({
      ...module('gateway', ['fabric'], log),
      stop: () => {
        stops += 1;
        return Promise.reject(new Error('gateway stop failed'));
      },
    });
    await host.start();
    await expect(host.stop()).rejects.toMatchObject({ errors: [new Error('gateway stop failed')] });
    await expect(host.stop()).rejects.toThrow('Some modules failed to stop');
    expect(stops).toBe(1);
    expect(log.at(-1)).toBe('stop fabric');
    expect(host.ledger()).toMatchObject([
      { moduleId: 'fabric', state: 'STOPPED' },
      { moduleId: 'gateway', state: 'STOP_FAILED', error: new Error('gateway stop failed') },
    ]);
    await expect(host.start()).rejects.toThrow('HOST_STOPPED');
  });

  it('ends a start in flight when stop arrives and starts nothing afterwards', async () => {
    const log: string[] = [];
    const host = new ModuleHost();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    host.register({
      ...module('fabric', [], log),
      start: async () => {
        await gate;
        log.push('start fabric');
      },
    });
    host.register(module('gateway', ['fabric'], log));
    const starting = host.start();
    const first = host.stop();
    const second = host.stop();
    expect(second).toBe(first);
    release();
    await expect(starting).rejects.toThrow('HOST_STOPPED');
    await first;
    expect(log).toEqual(['start fabric', 'stop fabric']);
    expect(host.ledger().map((entry) => entry.state)).toEqual(['STOPPED', 'REGISTERED']);
  });

  it('records a stop that exceeds the timeout and goes on', async () => {
    const log: string[] = [];
    const host = new ModuleHost({ stopTimeoutMs: 10 });
    host.register(module('fabric', [], log));
    host.register({
      ...module('gateway', ['fabric'], log),
      stop: () => new Promise<void>(() => undefined),
    });
    await host.start();
    await expect(host.stop()).rejects.toThrow('Some modules failed to stop');
    expect(log.at(-1)).toBe('stop fabric');
    expect(host.ledger()[1]).toMatchObject({
      state: 'STOP_FAILED',
      error: { code: 'STOP_TIMEOUT' },
    });
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
