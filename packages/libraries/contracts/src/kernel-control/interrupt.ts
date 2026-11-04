import { Type, type Static } from 'typebox';
import { closed, count } from '../platform-common/schema-helpers.js';

/**
 * Why a run is interrupted from outside the conversation (M2Design 7.7). Phase 3 has the one
 * reason; the user's abort, the Turn timeout and the pause timeout join it in phase 5 through
 * the same entry in Core.
 */
export const INTERRUPT_REASONS = ['MEMORY_PRESSURE'] as const;
export type InterruptReason = (typeof INTERRUPT_REASONS)[number];

export const MEMORY_LEVELS = ['WARNING', 'DANGER'] as const;
export type MemoryLevel = (typeof MEMORY_LEVELS)[number];

/**
 * The one thing the memory sampler may send (Kernel/Monitor 4a): a control message that Core
 * queues and handles like any other. The sampler holds no run, no Workflow and no way to stop
 * anything itself.
 */
export const MemoryPressureSchema = closed(
  {
    type: Type.Literal('MemoryPressure'),
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
