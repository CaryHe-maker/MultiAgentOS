import { freemem, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import type { MemoryLevel, MemoryPressure } from '@multiagentos/contracts';

/**
 * Memory pressure (M2Design 7.7; Kernel/Monitor 4a). The one thing that runs on its own in the
 * Monitor, because memory belongs to the process and not to a run. It reads, judges, and sends
 * one control message upwards; it holds nothing it could cancel, close or stop with, and it
 * allocates nothing that grows with a run.
 */
export interface MemorySample {
  readonly rssBytes: number;
  /** RSS over the process limit (`constrainedMemory`, else physical memory). */
  readonly rssRatio: number;
  readonly heapRatio: number;
  /** Linux `MemAvailable` over total memory, as a used share; undefined where unknown. */
  readonly systemRatio?: number;
  readonly availableBytes?: number;
}

/** The highest of the ratios: any one of them running out is enough. */
export const pressureRatio = (sample: MemorySample): number =>
  Math.max(sample.rssRatio, sample.heapRatio, sample.systemRatio ?? 0);

export interface MemoryThresholds {
  readonly warningRatio: number;
  readonly dangerRatio: number;
}

export function levelOf(ratio: number, thresholds: MemoryThresholds): MemoryLevel | undefined {
  if (ratio >= thresholds.dangerRatio) return 'DANGER';
  if (ratio >= thresholds.warningRatio) return 'WARNING';
  return undefined;
}

export function readMemorySample(): MemorySample {
  const limit = process.constrainedMemory();
  const total = limit > 0 && limit < totalmem() ? limit : totalmem();
  const rssBytes = process.memoryUsage.rss();
  const heap = getHeapStatistics();
  let availableBytes: number | undefined;
  try {
    const match = /^MemAvailable:\s+(\d+) kB/mu.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (match?.[1] !== undefined) availableBytes = Number(match[1]) * 1024;
  } catch {
    availableBytes = process.platform === 'linux' ? undefined : freemem();
  }
  return {
    rssBytes,
    rssRatio: rssBytes / total,
    heapRatio: heap.used_heap_size / heap.heap_size_limit,
    ...(availableBytes === undefined
      ? {}
      : { systemRatio: 1 - availableBytes / totalmem(), availableBytes }),
  };
}

export interface MemorySamplerDeps {
  readonly intervalMs: number;
  readonly thresholds: MemoryThresholds;
  readonly read?: () => MemorySample;
  /** The only way out: a control message for Core. */
  readonly send: (message: MemoryPressure) => void;
  readonly diagnostic?: (line: string) => void;
}

export interface MemorySampler {
  start(): void;
  stop(): void;
  /** One sample, for tests and for starting values. */
  sampleOnce(): void;
}

/** A message is sent only when the level rises; falling back does not undo a wrap-up. */
export function createMemorySampler(deps: MemorySamplerDeps): MemorySampler {
  const read = deps.read ?? readMemorySample;
  let sent: MemoryLevel | undefined;
  let timer: NodeJS.Timeout | undefined;
  const rank = (level: MemoryLevel | undefined): number =>
    level === 'DANGER' ? 2 : level === 'WARNING' ? 1 : 0;
  const sampleOnce = (): void => {
    let sample: MemorySample;
    try {
      sample = read();
    } catch (error) {
      // A failed reading is not pressure.
      deps.diagnostic?.(
        `memory sampling failed: ${error instanceof Error ? error.message : 'error'}`,
      );
      return;
    }
    const ratio = pressureRatio(sample);
    const level = levelOf(ratio, deps.thresholds);
    if (level === undefined || rank(level) <= rank(sent)) return;
    sent = level;
    deps.send({
      type: 'MemoryPressure',
      level,
      ratio,
      rssBytes: sample.rssBytes,
      heapRatio: sample.heapRatio,
      ...(sample.availableBytes === undefined ? {} : { availableBytes: sample.availableBytes }),
    });
  };
  return {
    sampleOnce,
    start: () => {
      if (timer !== undefined) return;
      timer = setInterval(sampleOnce, deps.intervalMs);
      timer.unref();
    },
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
