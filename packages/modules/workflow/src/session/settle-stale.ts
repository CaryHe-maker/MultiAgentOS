import type { SessionLogRecord } from '@multiagentos/contracts';
import type { NewLogRecord } from './session-log-store.js';

const REASON = '上一个进程中断';
const NO_RESULT = 'Not executed: the previous process ended before this call finished.';

interface OpenAgentRun {
  readonly workflowRunId: string;
  readonly turnId?: string;
}

/**
 * Step 4 of M2Design 10.3: what a log needs after a process ended without closing it. Everything
 * that succeeded stays as it is. Everything still open ends here: an interrupted AgentRun is never
 * resumed, the next prompt starts a new one. Every tool call of such an AgentRun gets an answer,
 * or the provider would refuse the history. The result depends on the records alone.
 */
export function settleStaleRecords(records: readonly SessionLogRecord[]): readonly NewLogRecord[] {
  const openUnits = new Map<string, { workflowRunId: string; turnId?: string }>();
  const openAgentRuns = new Map<string, OpenAgentRun>();
  const openNodes = new Map<string, { workflowRunId: string; turnId?: string }>();
  const openTurns = new Map<string, string>();
  /** Inputs of the user whose work did not come to rest, by their checkpoint. */
  const openInputs = new Map<string, string>();
  const openRuns = new Set<string>();
  const unanswered = new Map<string, { agentRunId: string } & OpenAgentRun>();

  for (const record of records) {
    switch (record.type) {
      case 'AGENT_RUN_REGISTERED':
        openAgentRuns.set(record.agentRunId, {
          workflowRunId: record.workflowRunId,
          ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
        });
        break;
      case 'AGENT_RUN_ENDED':
        openAgentRuns.delete(record.agentRunId);
        break;
      case 'NODE_STARTED':
        openNodes.set(record.nodeId, {
          workflowRunId: record.workflowRunId,
          ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
        });
        break;
      case 'NODE_ENDED':
        openNodes.delete(record.nodeId);
        break;
      case 'MODEL_TURN':
        for (const call of record.toolCalls)
          unanswered.set(call.toolCallId, {
            agentRunId: record.agentRunId,
            workflowRunId: record.workflowRunId,
            ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
          });
        break;
      case 'FEEDBACK':
        if (record.toolCallId !== undefined) unanswered.delete(record.toolCallId);
        break;
      case 'NODE_RESUMED':
        // The tasks of the call answered it, as a projection reads them.
        unanswered.delete(record.call.toolCallId);
        break;
      case 'UNIT_SUBMITTED':
        openUnits.set(record.requestId, {
          workflowRunId: record.workflowRunId,
          ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
        });
        if (record.inputSource.kind === 'TOOL_CALL')
          unanswered.delete(record.inputSource.toolCallId);
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
      case 'HUMAN_ANSWERED':
        if (record.kind === 'prompt' && record.checkpointId !== undefined)
          openInputs.set(record.checkpointId, record.workflowRunId);
        break;
      case 'INPUT_SETTLED':
        openInputs.delete(record.checkpointId);
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
  for (const [toolCallId, call] of unanswered) {
    if (!openAgentRuns.has(call.agentRunId)) continue;
    settled.push({
      type: 'FEEDBACK',
      code: 'INTERRUPTED',
      message: NO_RESULT,
      toolCallId,
      ...call,
    });
  }
  for (const [agentRunId, agentRun] of openAgentRuns) {
    settled.push({ type: 'AGENT_RUN_ENDED', agentRunId, outcome: 'INTERRUPTED', ...agentRun });
  }
  for (const [nodeId, node] of openNodes) {
    settled.push({ type: 'NODE_ENDED', nodeId, status: 'INTERRUPTED', ...node });
  }
  // A log written before checkpoints replaced Turns closes its open Turn the way it did then.
  for (const [turnId, workflowRunId] of openTurns) {
    settled.push({ type: 'TURN_ENDED', turnId, workflowRunId, reason: 'PROCESS_EXITED' });
  }
  for (const [checkpointId, workflowRunId] of openInputs) {
    settled.push({ type: 'INPUT_SETTLED', checkpointId, workflowRunId, reason: 'PROCESS_EXITED' });
  }
  for (const workflowRunId of openRuns) {
    settled.push({ type: 'WORKFLOW_RUN_ENDED', workflowRunId, closeReason: 'PROCESS_EXITED' });
  }
  if (settled.length > 0) {
    settled.push({
      type: 'STALE_UNITS_SETTLED',
      requestIds: [...openUnits.keys()],
      ...(openTurns.size === 0 ? {} : { turnIds: [...openTurns.keys()] }),
      workflowRunIds: [...openRuns],
    });
  }
  return settled;
}

const INTERRUPT_REASON = '运行被中断（内存紧张）';
const INTERRUPT_NO_RESULT = 'Not executed: the run was interrupted before this call finished.';

/**
 * What an interrupt leaves open in one run that stays in the log (Core 5c): the Kernel cancelled
 * the work in flight and Workflow no longer waits for its reports. Every call the model made gets
 * its answer here, or the next run's history would hold a call without a result and the provider
 * would refuse it. The process did not end, so nothing else is settled: the AgentRun, its node
 * and the run close through the reply that says why.
 */
export function settleOpenCalls(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
): readonly NewLogRecord[] {
  const openUnits = new Map<string, { workflowRunId: string; turnId?: string }>();
  const unanswered = new Map<string, { agentRunId: string } & OpenAgentRun>();
  for (const record of records) {
    if (!('workflowRunId' in record) || record.workflowRunId !== workflowRunId) continue;
    switch (record.type) {
      case 'MODEL_TURN':
        for (const call of record.toolCalls)
          unanswered.set(call.toolCallId, {
            agentRunId: record.agentRunId,
            workflowRunId: record.workflowRunId,
            ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
          });
        break;
      case 'FEEDBACK':
        if (record.toolCallId !== undefined) unanswered.delete(record.toolCallId);
        break;
      case 'UNIT_SUBMITTED':
        openUnits.set(record.requestId, {
          workflowRunId: record.workflowRunId,
          ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
        });
        if (record.inputSource.kind === 'TOOL_CALL')
          unanswered.delete(record.inputSource.toolCallId);
        break;
      case 'UNIT_COMPLETED':
      case 'UNIT_INTERRUPTED':
        openUnits.delete(record.requestId);
        break;
      default:
        break;
    }
  }
  const settled: NewLogRecord[] = [];
  for (const [requestId, unit] of openUnits)
    settled.push({ type: 'UNIT_INTERRUPTED', requestId, reason: INTERRUPT_REASON, ...unit });
  for (const [toolCallId, call] of unanswered)
    settled.push({
      type: 'FEEDBACK',
      code: 'INTERRUPTED',
      message: INTERRUPT_NO_RESULT,
      toolCallId,
      ...call,
    });
  return settled;
}
