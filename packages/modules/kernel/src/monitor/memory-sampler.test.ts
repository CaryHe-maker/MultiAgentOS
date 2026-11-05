import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryPressure } from '@multiagentos/contracts';
import {
  createMemorySampler,
  levelOf,
  memorySampleOf,
  processRatio,
  systemLevelOf,
  type MemorySample,
} from './memory-sampler.js';

const thresholds = { warningRatio: 0.75, dangerRatio: 0.9 };
const sample = (ratio: number, systemRatio?: number): MemorySample => ({
  rssBytes: 1,
  rssRatio: ratio,
  heapRatio: 0,
  ...(systemRatio === undefined ? {} : { systemRatio }),
});

describe('levels', () => {
  it('counts what this process holds as the higher of its RSS and its heap', () => {
    expect(processRatio({ rssBytes: 1, rssRatio: 0.2, heapRatio: 0.8, systemRatio: 0.99 })).toBe(
      0.8,
    );
  });

  it('is normal below the warning, WARNING from it and DANGER from the danger ratio', () => {
    expect(levelOf(0.74, thresholds)).toBeUndefined();
    expect(levelOf(0.75, thresholds)).toBe('WARNING');
    expect(levelOf(0.9, thresholds)).toBe('DANGER');
  });

  it('lets the machine running short reach WARNING only', () => {
    expect(systemLevelOf(sample(0.1, 0.8), thresholds)).toBe('WARNING');
    expect(systemLevelOf(sample(0.1, 0.99), thresholds)).toBe('WARNING');
    expect(systemLevelOf(sample(0.1, 0.5), thresholds)).toBeUndefined();
    expect(systemLevelOf(sample(0.1), thresholds)).toBeUndefined();
  });
});

describe('what is measured', () => {
  const GB = 1024 ** 3;
  const facts = {
    rssBytes: 1 * GB,
    constrainedBytes: 2 ** 64,
    physicalBytes: 8 * GB,
    heapUsedBytes: 1 * GB,
    heapLimitBytes: 2 * GB,
  };

  it('does not measure RSS against the machine: only a container limit counts', () => {
    expect(memorySampleOf(facts).rssRatio).toBe(0);
    expect(memorySampleOf({ ...facts, constrainedBytes: 0 }).rssRatio).toBe(0);
    expect(memorySampleOf({ ...facts, constrainedBytes: 2 * GB }).rssRatio).toBe(0.5);
  });

  it('measures the heap against the V8 limit', () => {
    expect(memorySampleOf(facts).heapRatio).toBe(0.5);
  });

  it('never against more than 60% of the memory there is', () => {
    // A 4 GB limit on an 8 GB machine: 4.8 GB is allowed, so the limit rules.
    expect(memorySampleOf({ ...facts, heapLimitBytes: 4 * GB }).heapRatio).toBe(0.25);
    // The same limit on a 4 GB machine: only 2.4 GB can be used.
    const small = memorySampleOf({ ...facts, physicalBytes: 4 * GB, heapLimitBytes: 4 * GB });
    expect(small.heapRatio).toBeCloseTo(1 / 2.4, 5);
    // In a 3 GB container too.
    const boxed = memorySampleOf({ ...facts, constrainedBytes: 3 * GB, heapLimitBytes: 4 * GB });
    expect(boxed.heapRatio).toBeCloseTo(1 / 1.8, 5);
  });

  it('reads the machine from what is available', () => {
    expect(memorySampleOf({ ...facts, availableBytes: 2 * GB }).systemRatio).toBe(0.75);
    expect(memorySampleOf(facts).systemRatio).toBeUndefined();
  });
});

describe('the sampler', () => {
  const run = (readings: (MemorySample | Error)[]) => {
    const sent: MemoryPressure[] = [];
    const diagnostics: string[] = [];
    const levels: (string | undefined)[] = [];
    let index = 0;
    const sampler = createMemorySampler({
      intervalMs: 10,
      thresholds,
      read: () => {
        const next = readings[index++] ?? sample(0);
        if (next instanceof Error) throw next;
        return next;
      },
      send: (message) => sent.push(message),
      diagnostic: (line) => diagnostics.push(line),
    });
    for (let step = 0; step < readings.length; step += 1) {
      sampler.sampleOnce();
      levels.push(sampler.level());
    }
    return { sent, diagnostics, levels };
  };
  const own = (...ratios: number[]) => ratios.map((ratio) => sample(ratio));
  const summary = (sent: MemoryPressure[]) =>
    sent.map((message) => `${message.source}:${message.level}`);

  it('sends nothing while the level is normal', () => {
    expect(run(own(0.1, 0.5, 0.74)).sent).toEqual([]);
  });

  it('sends one message when the level rises and none while it stays', () => {
    const { sent } = run(own(0.8, 0.85, 0.8));
    expect(summary(sent)).toEqual(['PROCESS:WARNING']);
    expect(sent[0]).toMatchObject({ type: 'MemoryPressure', ratio: 0.8 });
  });

  it('sends DANGER after WARNING', () => {
    expect(summary(run(own(0.8, 0.95)).sent)).toEqual(['PROCESS:WARNING', 'PROCESS:DANGER']);
  });

  it('sends a level again when it rises again after it fell, DANGER included', () => {
    expect(summary(run(own(0.95, 0.1, 0.95, 0.8, 0.95)).sent)).toEqual([
      'PROCESS:DANGER',
      'PROCESS:DANGER',
      'PROCESS:DANGER',
    ]);
    expect(summary(run(own(0.8, 0.1, 0.8)).sent)).toEqual(['PROCESS:WARNING', 'PROCESS:WARNING']);
  });

  it('knows the live level of the process, and follows it down', () => {
    expect(run(own(0.8, 0.1, 0.95, 0.8)).levels).toEqual([
      'WARNING',
      undefined,
      'DANGER',
      'WARNING',
    ]);
  });

  it('reports the machine running short as SYSTEM, apart from the process', () => {
    const { sent, levels } = run([sample(0.1, 0.8), sample(0.1, 0.95), sample(0.1, 0.4)]);
    expect(summary(sent)).toEqual(['SYSTEM:WARNING']);
    // It does not touch the level that refuses work.
    expect(levels).toEqual([undefined, undefined, undefined]);
  });

  it('reports both when both are short, each once', () => {
    const { sent } = run([sample(0.8, 0.9), sample(0.8, 0.9)]);
    expect(summary(sent).sort()).toEqual(['PROCESS:WARNING', 'SYSTEM:WARNING']);
  });

  it('treats a failed reading as no pressure and says so once per failure', () => {
    const { sent, diagnostics } = run([new Error('no /proc'), sample(0.1)]);
    expect(sent).toEqual([]);
    expect(diagnostics).toEqual(['memory sampling failed: no /proc']);
  });

  it('runs on a timer that does not keep the process alive', () => {
    vi.useFakeTimers();
    try {
      const sent: MemoryPressure[] = [];
      const sampler = createMemorySampler({
        intervalMs: 1000,
        thresholds,
        read: () => sample(0.95),
        send: (message) => sent.push(message),
      });
      sampler.start();
      sampler.start();
      vi.advanceTimersByTime(3000);
      sampler.stop();
      vi.advanceTimersByTime(3000);
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('can only reach Core through the message it is given (architecture)', () => {
    const source = readFileSync(new URL('./memory-sampler.ts', import.meta.url), 'utf8');
    for (const forbidden of ['cancelRun', 'closeRun', 'shutdown', 'process.exit', 'abortAllRuns'])
      expect(source.replaceAll(/\/\*[\s\S]*?\*\//gu, '')).not.toContain(forbidden);
  });
});
