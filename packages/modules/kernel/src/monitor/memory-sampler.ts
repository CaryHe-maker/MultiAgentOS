import { freemem, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import type { MemoryLevel, MemoryPressure, MemorySource } from '@multiagentos/contracts';

/**
 * Memory pressure (M2Design 7.7; Kernel/Monitor 4a). The one thing that runs on its own in the
 * Monitor, because memory belongs to the process and not to a run. It reads, judges, and sends
 * control messages upwards; it holds nothing it could cancel, close or stop with, and it
 * allocates nothing that grows with a run.
 *
 * Two kinds of pressure, reported apart. What this process holds (RSS against its limit, the V8
 * heap) may reach DANGER: the run is interrupted. The machine running short (other programs) only
 * ever reaches WARNING and only informs: interrupting a run does not give that memory back.
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

/** What this process holds: the higher of its RSS and its heap. */
export const processRatio = (sample: MemorySample): number =>
  Math.max(sample.rssRatio, sample.heapRatio);

export interface MemoryThresholds {
  readonly warningRatio: number;
  readonly dangerRatio: number;
}

export function levelOf(ratio: number, thresholds: MemoryThresholds): MemoryLevel | undefined {
  if (ratio >= thresholds.dangerRatio) return 'DANGER';
  if (ratio >= thresholds.warningRatio) return 'WARNING';
  return undefined;
}

/** The machine running short is a warning at most. */
export function systemLevelOf(
  sample: MemorySample,
  thresholds: MemoryThresholds,
): MemoryLevel | undefined {
  return levelOf(sample.systemRatio ?? 0, thresholds) === undefined ? undefined : 'WARNING';
}

/** What this program may use of the memory it has: the rest is for the commands and the system. */
export const HEAP_SHARE_OF_MEMORY = 0.6;

export interface MemoryFacts {
  readonly rssBytes: number;
  /** `process.constrainedMemory()`: 0 or a huge number when no container limit applies. */
  readonly constrainedBytes: number;
  readonly physicalBytes: number;
  readonly heapUsedBytes: number;
  readonly heapLimitBytes: number;
  readonly availableBytes?: number;
}

/**
 * The two ratios of this process (M2Design 7.7). The heap is measured against the V8 limit, but
 * never against more than 60% of the memory there is: a limit above that is not reachable before
 * the system gives up. RSS is measured only against a container limit; without one the machine's
 * memory is not this program's to run out of, and the system reading covers it.
 */
export function memorySampleOf(facts: MemoryFacts): MemorySample {
  const constrained = facts.constrainedBytes > 0 && facts.constrainedBytes < facts.physicalBytes;
  const memory = constrained ? facts.constrainedBytes : facts.physicalBytes;
  const heapCeiling = Math.min(facts.heapLimitBytes, memory * HEAP_SHARE_OF_MEMORY);
  return {
    rssBytes: facts.rssBytes,
    rssRatio: constrained ? facts.rssBytes / facts.constrainedBytes : 0,
    heapRatio: facts.heapUsedBytes / heapCeiling,
    ...(facts.availableBytes === undefined
      ? {}
      : {
          systemRatio: 1 - facts.availableBytes / facts.physicalBytes,
          availableBytes: facts.availableBytes,
        }),
  };
}

export function readMemorySample(): MemorySample {
  const heap = getHeapStatistics();
  let availableBytes: number | undefined;
  try {
    const match = /^MemAvailable:\s+(\d+) kB/mu.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (match?.[1] !== undefined) availableBytes = Number(match[1]) * 1024;
  } catch {
    availableBytes = process.platform === 'linux' ? undefined : freemem();
  }
  return memorySampleOf({
    rssBytes: process.memoryUsage.rss(),
    constrainedBytes: process.constrainedMemory(),
    physicalBytes: totalmem(),
    heapUsedBytes: heap.used_heap_size,
    heapLimitBytes: heap.heap_size_limit,
    ...(availableBytes === undefined ? {} : { availableBytes }),
  });
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
  /** The level of this process at the latest sample; undefined when it is normal. */
  level(): MemoryLevel | undefined;
}

const rank = (level: MemoryLevel | undefined): number =>
  level === 'DANGER' ? 2 : level === 'WARNING' ? 1 : 0;

/**
 * A message is sent when a level rises. A level that fell is forgotten, so that rising again is
 * reported again: the process stays up after an interrupt, and the next pressure is news.
 */
export function createMemorySampler(deps: MemorySamplerDeps): MemorySampler {
  const read = deps.read ?? readMemorySample;
  const sent: Record<MemorySource, MemoryLevel | undefined> = {
    PROCESS: undefined,
    SYSTEM: undefined,
  };
  let current: MemoryLevel | undefined;
  let timer: NodeJS.Timeout | undefined;

  const settle = (
    source: MemorySource,
    level: MemoryLevel | undefined,
    ratio: number,
    sample: MemorySample,
  ): void => {
    const before = rank(sent[source]);
    sent[source] = level;
    if (level === undefined || rank(level) <= before) return;
    deps.send({
      type: 'MemoryPressure',
      source,
      level,
      ratio,
      rssBytes: sample.rssBytes,
      heapRatio: sample.heapRatio,
      ...(sample.availableBytes === undefined ? {} : { availableBytes: sample.availableBytes }),
    });
  };

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
    const own = levelOf(processRatio(sample), deps.thresholds);
    current = own;
    settle('PROCESS', own, processRatio(sample), sample);
    settle('SYSTEM', systemLevelOf(sample, deps.thresholds), sample.systemRatio ?? 0, sample);
  };
  return {
    sampleOnce,
    level: () => current,
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
