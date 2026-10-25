import type {
  AgentPinRequest,
  CloseRunRequest,
  EndAgentRunRequest,
  PinnedDefinitionSet,
  PortResult,
  ProtocolRegistry,
  ReasonCode,
  RegisterAgentRunRequest,
  SyscallAck,
  SyscallRejected,
  SubmitUnitRequest,
  WorkflowConfig,
  WorkflowInboxEvent,
} from '@multiagentos/contracts';
import type { WorkflowState } from './state.js';
import { failureFromCode, syscallFailureHandling } from './failure-policy.js';
import {
  afterAgentEnd,
  applyCycle,
  beginCycle,
  cycleEnvironment,
  failWorkflow,
  registerWorkflow,
} from './run-lifecycle.js';
import { workflowRunRecord } from './run-record.js';
import { receiveUnitReport } from './unit-cycle.js';

export type WorkflowAction =
  | { readonly kind: 'PIN'; readonly role: 'ENTRY' | 'TARGET'; readonly request: AgentPinRequest }
  | { readonly kind: 'REGISTER'; readonly request: RegisterAgentRunRequest }
  | { readonly kind: 'SUBMIT'; readonly request: SubmitUnitRequest }
  | { readonly kind: 'END'; readonly request: EndAgentRunRequest }
  | { readonly kind: 'WRITE_RECORD'; readonly record: ReturnType<typeof workflowRunRecord> }
  | { readonly kind: 'CLOSE'; readonly request: CloseRunRequest };

export type WorkflowInput =
  | { readonly kind: 'EVENT'; readonly envelope: WorkflowInboxEvent }
  | {
      readonly kind: 'PIN_RESULT';
      readonly role: 'ENTRY' | 'TARGET';
      readonly result: PortResult<PinnedDefinitionSet>;
    }
  | {
      readonly kind: 'SYSCALL_RESULT';
      readonly action: 'REGISTER' | 'SUBMIT' | 'END' | 'CLOSE';
      readonly result: SyscallAck | SyscallRejected;
    }
  | { readonly kind: 'RECORD_WRITTEN' }
  | { readonly kind: 'INTERNAL_ERROR' };

/** IDs are generated outside the reducer so identical inputs yield identical results. */
export interface ReducerEnvironment {
  readonly config: WorkflowConfig;
  readonly requestId: string;
  readonly agentRunId: string;
  readonly requestIds: readonly string[];
  readonly registry: ProtocolRegistry;
  readonly createdAt: string;
}

export interface WorkflowTransition {
  readonly state: WorkflowState;
  readonly actions: readonly WorkflowAction[];
}

function fail(
  state: WorkflowState,
  code: ReasonCode,
  environment: ReducerEnvironment,
): WorkflowTransition {
  return failWorkflow(state, failureFromCode(code), environment);
}

function register(state: WorkflowState, environment: ReducerEnvironment): WorkflowTransition {
  const definitions = state.entry;
  if (definitions === undefined)
    throw new Error('Entry definitions must be pinned before registering an AgentRun');
  return registerWorkflow(state, definitions, environment);
}

/** Interprets input and state without I/O or mutation of previous state. */
export function reduceWorkflow(
  state: WorkflowState | undefined,
  input: WorkflowInput,
  environment: ReducerEnvironment,
): WorkflowTransition {
  if (state === undefined) {
    if (input.kind !== 'EVENT' || input.envelope.event.type !== 'RunStart')
      throw new Error('Cannot process input before RunStart');
    return {
      state: {
        workflowRunId: input.envelope.workflowRunId,
        goal: input.envelope.event.goal,
        phase: 'PINNING_ENTRY',
        budgetState: 'NORMAL',
        reads: [],
        businessState: 'RUNNING',
        agentRuns: [],
        finalCallUsed: false,
      },
      actions: [{ kind: 'PIN', role: 'ENTRY', request: environment.config.entryAgentRef }],
    };
  }
  if (state.closed !== undefined) return { state, actions: [] };
  if (input.kind === 'EVENT') {
    const event = input.envelope.event;
    if (event.type === 'RunClosed') {
      const businessState =
        event.closeReason === 'RUN_TIMEOUT' || event.closeReason === 'VIOLATION'
          ? 'STOPPED'
          : event.closeReason;
      const closed: WorkflowState = {
        ...state,
        phase: 'CLOSING',
        businessState,
        closed: event,
        ...('failure' in event ? { failure: event.failure } : {}),
        ...('reportRef' in event ? { reportRef: event.reportRef } : {}),
      };
      return {
        state: closed,
        actions: [
          { kind: 'WRITE_RECORD', record: workflowRunRecord(closed, environment.createdAt) },
        ],
      };
    }
    if (event.type === 'RunStart') throw new Error('A run cannot start more than once');
    if (state.phase === 'PUBLISHING') {
      const request = state.pendingPublish;
      if (request === undefined || event.requestId !== request.requestId)
        return { state, actions: [] };
      if (
        event.agentRunId !== request.agentRunId ||
        event.unitRef.id !== request.unitRef.id ||
        event.unitRef.version !== request.unitRef.version ||
        event.unitRef.digest !== request.unitRef.digest ||
        event.executionKind !== 'REPORT_PUBLISH'
      )
        throw new Error('Report publication result does not match the pending request');
      if (event.status !== 'OK')
        return failWorkflow(state, failureFromCode(event.reasonCode, event.requestId), environment);
      return {
        state: {
          ...state,
          reportRef: event.outputRef,
          phase: 'ENDING',
          afterEnd: 'CLOSE_COMPLETED',
        },
        actions: [
          {
            kind: 'END',
            request: {
              requestId: environment.requestId,
              workflowRunId: state.workflowRunId,
              agentRunId: request.agentRunId,
            },
          },
        ],
      };
    }
    if (state.phase === 'RUNNING' && state.cycle !== undefined)
      return applyCycle(
        state,
        receiveUnitReport(state.cycle, event, cycleEnvironment(state, environment)),
        environment,
      );
    return { state, actions: [] };
  }
  if (input.kind === 'INTERNAL_ERROR') return fail(state, 'WORKFLOW_INTERNAL', environment);
  if (state.phase === 'CLOSING') return { state, actions: [] };
  if (input.kind === 'RECORD_WRITTEN') {
    if (state.phase !== 'SAVING_REPORT' || state.pendingPublish === undefined)
      return { state, actions: [] };
    return {
      state: { ...state, phase: 'PUBLISHING' },
      actions: [{ kind: 'SUBMIT', request: state.pendingPublish }],
    };
  }
  if (input.kind === 'PIN_RESULT') {
    if (!input.result.ok) return fail(state, 'PIN_FAILED', environment);
    if (input.role === 'ENTRY') {
      const entry = input.result.value;
      const next = { ...state, entry };
      if (entry.handoffTargetRef === undefined) return register(next, environment);
      const { id, version } = entry.handoffTargetRef;
      return {
        state: { ...next, phase: 'PINNING_TARGET' },
        actions: [{ kind: 'PIN', role: 'TARGET', request: { id, version } }],
      };
    }
    const target = input.result.value;
    const expected = state.entry?.handoffTargetRef;
    if (
      expected === undefined ||
      target.agent.id !== expected.id ||
      target.agent.version !== expected.version ||
      target.agent.digest !== expected.digest
    )
      return fail(state, 'PIN_FAILED', environment);
    return register({ ...state, target }, environment);
  }
  if (input.result.outcome === 'REJECTED') {
    if (syscallFailureHandling(input.result, input.action === 'CLOSE') === 'WAIT_FOR_CLOSED')
      return { state: { ...state, phase: 'CLOSING' }, actions: [] };
    return fail(state, input.result.reasonCode, environment);
  }
  if (input.action === 'REGISTER') return beginCycle(state, environment);
  if (input.action === 'END') return afterAgentEnd(state, environment);
  return { state, actions: [] };
}
