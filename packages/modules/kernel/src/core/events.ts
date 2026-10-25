import type { KernelToInteractionEvent, KernelToWorkflowEvent } from '@multiagentos/contracts';

export type CoreEvent = KernelToInteractionEvent | KernelToWorkflowEvent;

/** Stage 1.5 replaces the collector with Core's Outbox; registration is synchronous. */
export interface CoreEventSink {
  emit(event: CoreEvent): void;
}
