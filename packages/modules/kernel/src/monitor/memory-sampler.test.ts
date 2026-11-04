import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryPressure } from '@multiagentos/contracts';
import {
  createMemorySampler,
  levelOf,
  pressureRatio,
  type MemorySample,
} from './memory-sampler.js';

const thresholds = { warningRatio: 0.75, dangerRatio: 0.9 };
const sample = (ratio: number): MemorySample => ({ rssBytes: 1, rssRatio: ratio, heapRatio: 0 });

describe('levels', () => {
  it('uses the highest of the ratios', () => {
    expect(pressureRatio({ rssBytes: 1, rssRatio: 0.2, heapRatio: 0.8, systemRatio: 0.5 })).toBe(
      0.8,
    );
  });

  it('is normal below the warning, WARNING from it and DANGER from the danger ratio', () => {
    expect(levelOf(0.74, thresholds)).toBeUndefined();
    expect(levelOf(0.75, thresholds)).toBe('WARNING');
    expect(levelOf(0.9, thresholds)).toBe('DANGER');
  });
});

describe('the sampler', () => {
  const run = (ratios: (number | Error)[]) => {
    const sent: MemoryPressure[] = [];
    const diagnostics: string[] = [];
    let index = 0;
    const sampler = createMemorySampler({
      intervalMs: 10,
      thresholds,
      read: () => {
        const next = ratios[index++] ?? 0;
        if (next instanceof Error) throw next;
        return sample(next);
      },
      send: (message) => sent.push(message),
      diagnostic: (line) => diagnostics.push(line),
    });
    for (let step = 0; step < ratios.length; step += 1) sampler.sampleOnce();
    return { sent, diagnostics };
  };

  it('sends nothing while the level is normal', () => {
    expect(run([0.1, 0.5, 0.74]).sent).toEqual([]);
  });

  it('sends one message when the level rises and none while it stays', () => {
    const { sent } = run([0.8, 0.85, 0.8]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'MemoryPressure', level: 'WARNING' });
  });

  it('sends DANGER after WARNING, and nothing when the pressure falls back', () => {
    const { sent } = run([0.8, 0.95, 0.1, 0.95]);
    expect(sent.map((message) => message.level)).toEqual(['WARNING', 'DANGER']);
  });

  it('treats a failed reading as no pressure and says so once per failure', () => {
    const { sent, diagnostics } = run([new Error('no /proc'), 0.1]);
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
