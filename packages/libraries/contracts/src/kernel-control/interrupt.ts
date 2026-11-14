import { Type, type Static } from 'typebox';
import { closed, count } from '../platform-common/schema-helpers.js';

/**
 * Why a run is interrupted from outside the conversation (M2Design 4.3, 7.7): all of them enter
 * Core through the same `interrupt(reason)` (Kernel/Core 5c, 5e).
 */
export const INTERRUPT_REASONS = [
  'MEMORY_PRESSURE',
  'USER_ABORT',
  'INPUT_TIMEOUT',
  'PAUSE_TIMEOUT',
] as const;
export type InterruptReason = (typeof INTERRUPT_REASONS)[number];

export const MEMORY_LEVELS = ['WARNING', 'DANGER'] as const;
export type MemoryLevel = (typeof MEMORY_LEVELS)[number];

/**
 * Whose memory it is. PROCESS (this program's RSS and heap) may interrupt a run; SYSTEM (the
 * machine running short because of other programs) only informs and is recorded.
 */
export const MEMORY_SOURCES = ['PROCESS', 'SYSTEM'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/**
 * The one thing the memory sampler may send (Kernel/Monitor 4a): a control message that Core
 * queues and handles like any other. The sampler holds no run, no Workflow and no way to stop
 * anything itself.
 */
export const MemoryPressureSchema = closed(
  {
    type: Type.Literal('MemoryPressure'),
    source: Type.Enum(MEMORY_SOURCES),
    level: Type.Enum(MEMORY_LEVELS),
    /** The highest of the ratios below, 0..1. */
    ratio: Type.Number({ minimum: 0 }),
    rssBytes: count(),
    heapRatio: Type.Number({ minimum: 0 }),
    availableBytes: Type.Optional(count()),
  },
  'kernel.control.MemoryPressure.v1',
);
export type MemoryPressure = Static<typeof MemoryPressureSchema>;

/** The exit code of a controlled exit after a memory interrupt (SystemFaultHandling 3). */
export const EXIT_CODE_MEMORY_PRESSURE = 75;
