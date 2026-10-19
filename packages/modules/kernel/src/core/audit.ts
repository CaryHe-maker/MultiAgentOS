import type { ArtifactRef, ReasonCode } from '@multiagentos/contracts';

/** Audit entry types of docs/M1/Kernel/Core.md 7. Later stages emit the remaining ones. */
export type CoreAuditType =
  | 'RUN_STARTED'
  | 'AGENT_RUN_REGISTERED'
  | 'AGENT_RUN_ENDED'
  | 'REQUEST_REJECTED'
  | 'AUTHORIZATION_ASKED'
  | 'AUTHORIZATION_RESOLVED'
  | 'UNIT_ACCEPTED'
  | 'UNIT_REPORTED'
  | 'UNIT_NOT_DELIVERED'
  | 'SETTLEMENT_ANOMALY'
  | 'STALE_FACT'
  | 'CONVERGENCE_STARTED'
  | 'CLOSE_REASON_UPGRADED'
  | 'CONVERGENCE_DEADLINE'
  | 'SYSTEM_FAULT_ABORT'
  | 'RUN_CLOSED';

/**
 * One line of `kernel-core/audit.jsonl`. It must never carry Lease content, credentials,
 * prompts, source text or tool output (Core 7).
 */
export interface CoreAuditEntry {
  readonly at: string;
  readonly workflowRunId: string;
  readonly type: CoreAuditType;
  readonly requestId?: string;
  readonly agentRunId?: string;
  readonly questionId?: string;
  readonly unitAttemptId?: string;
  readonly executionId?: string;
  readonly reasonCode?: ReasonCode;
  readonly resolution?: 'GRANTED' | 'DECLINED' | 'TIMED_OUT' | 'CANCELLED';
  readonly runSummaryRef?: ArtifactRef;
  readonly faultId?: string;
}

/** Injected by the composition root; stage 1.6 wires it to Persistence. */
export interface AuditSink {
  append(entry: CoreAuditEntry): Promise<void>;
}
