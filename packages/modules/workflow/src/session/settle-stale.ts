import type { SessionLogRecord } from '@multiagentos/contracts';
import type { NewLogRecord } from './session-log-store.js';

const REASON = '上一个进程中断';

/**
 * Step 4 of M2Design 10.3: what a log needs after a process ended without closing it. Interrupted
 * Units are recorded and never submitted again; the result depends on the records alone.
 */
export function settleStaleRecords(records: readonly SessionLogRecord[]): readonly NewLogRecord[] {
  const openUnits = new Map<string, { workflowRunId: string; turnId?: string }>();
  const openTurns = new Map<string, string>();
  const openRuns = new Set<string>();

  for (const record of records) {
    switch (record.type) {
      case 'UNIT_SUBMITTED':
        openUnits.set(record.requestId, {
          workflowRunId: record.workflowRunId,
          ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
        });
        break;
      case 'UNIT_COMPLETED':
      case 'UNIT_INTERRUPTED':
        openUnits.delete(record.requestId);
        break;
      case 'TURN_STARTED':
        if (record.turnId !== undefined) openTurns.set(record.turnId, record.workflowRunId);
        break;
      case 'TURN_ENDED':
        if (record.turnId !== undefined) openTurns.delete(record.turnId);
        break;
      case 'WORKFLOW_RUN_STARTED':
        openRuns.add(record.workflowRunId);
        break;
      case 'WORKFLOW_RUN_ENDED':
        openRuns.delete(record.workflowRunId);
        break;
      default:
        break;
    }
  }

  const settled: NewLogRecord[] = [];
  for (const [requestId, unit] of openUnits) {
    settled.push({ type: 'UNIT_INTERRUPTED', requestId, reason: REASON, ...unit });
  }
  for (const [turnId, workflowRunId] of openTurns) {
    settled.push({ type: 'TURN_ENDED', turnId, workflowRunId, reason: 'PROCESS_EXITED' });
  }
  for (const workflowRunId of openRuns) {
    settled.push({ type: 'WORKFLOW_RUN_ENDED', workflowRunId, closeReason: 'PROCESS_EXITED' });
  }
  if (settled.length > 0) {
    settled.push({
      type: 'STALE_UNITS_SETTLED',
      requestIds: [...openUnits.keys()],
      turnIds: [...openTurns.keys()],
      workflowRunIds: [...openRuns],
    });
  }
  return settled;
}
