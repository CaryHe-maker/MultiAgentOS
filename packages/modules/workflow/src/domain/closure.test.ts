import { MEDIA_TYPES, createM1ProtocolRegistry, newId } from '@multiagentos/contracts';
import type { CloseReason, RunClosed, WorkflowInboxEvent } from '@multiagentos/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_CONFIG } from '../index.js';
import { cycleDefinitions } from '../test-support/cycle-definitions.js';
import { runWorkflowCase, finishOutput } from '../test-support/cycle-harness.js';
import { reduceWorkflow } from './reducer.js';
import type { ReducerEnvironment } from './reducer.js';
import type { WorkflowState } from './state.js';

const environment = (): ReducerEnvironment => ({
  config: DEFAULT_WORKFLOW_CONFIG,
  registry: createM1ProtocolRegistry(),
  requestId: newId('req'),
  agentRunId: newId('agr'),
  requestIds: Array.from({ length: 32 }, () => newId('req')),
  createdAt: '2026-10-14T00:00:00.000Z',
});
function closedEvent(reason: CloseReason, workflowRunId: string): WorkflowInboxEvent {
  const event = {
    type: 'RunClosed',
    closeReason: reason,
    unknownEffects: [],
    finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
    ...(reason === 'COMPLETED'
      ? {
          reportRef: {
            artifactId: `art_${'a'.repeat(64)}`,
            mediaType: MEDIA_TYPES.analysisReport,
            sha256: 'a'.repeat(64),
            size: 10,
          },
        }
      : {}),
    ...(reason === 'FAILED'
      ? {
          failure: {
            code: 'KERNEL_INTERNAL',
            category: 'INTERNAL',
            source: 'KERNEL',
          },
        }
      : {}),
    ...(reason === 'VIOLATION'
      ? {
          failure: {
            code: 'GUARD_FAILURE',
            category: 'INTEGRITY',
            source: 'KERNEL',
          },
        }
      : {}),
  } as RunClosed;
  return {
    eventId: newId('evt'),
    workflowRunId,
    seq: 2,
    occurredAt: '2026-10-14T00:00:00.000Z',
    event,
  };
}

describe('Workflow terminal guarantees', () => {
  it.each(['COMPLETED', 'FAILED', 'RUN_TIMEOUT', 'CANCELLED', 'VIOLATION'] as const)(
    'records the authoritative %s outcome',
    (reason) => {
      const workflowRunId = newId('wfr');
      const state: WorkflowState = {
        workflowRunId,
        goal: '分析仓库',
        phase: 'RUNNING',
        agentRuns: [],
        finalCallUsed: false,
        reads: [],
        budgetState: 'NORMAL',
        businessState: 'RUNNING',
      };
      const transition = reduceWorkflow(
        state,
        { kind: 'EVENT', envelope: closedEvent(reason, workflowRunId) },
        environment(),
      );
      expect(transition.actions).toHaveLength(1);
      const write = transition.actions[0];
      if (write?.kind !== 'WRITE_RECORD') throw new Error('Missing terminal record write');
      expect(write.record.businessState).toBe(
        reason === 'RUN_TIMEOUT' || reason === 'VIOLATION' ? `STOPPED(${reason})` : reason,
      );
      expect(write.record.unknownEffects).toEqual([]);
      expect(transition.state.closed?.closeReason).toBe(reason);
    },
  );

  it('never emits another action after closure across arbitrary later inputs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<CloseReason>(
          'COMPLETED',
          'FAILED',
          'RUN_TIMEOUT',
          'CANCELLED',
          'VIOLATION',
        ),
        fc.array(fc.boolean(), { maxLength: 40 }),
        (reason, inputs) => {
          const workflowRunId = newId('wfr');
          const state: WorkflowState = {
            workflowRunId,
            goal: '分析仓库',
            phase: 'RUNNING',
            agentRuns: [],
            finalCallUsed: false,
            reads: [],
            budgetState: 'NORMAL',
            businessState: 'RUNNING',
          };
          const ended = reduceWorkflow(
            state,
            { kind: 'EVENT', envelope: closedEvent(reason, workflowRunId) },
            environment(),
          ).state;
          for (const isEvent of inputs) {
            const transition = reduceWorkflow(
              ended,
              isEvent
                ? { kind: 'EVENT', envelope: closedEvent(reason, workflowRunId) }
                : { kind: 'INTERNAL_ERROR' },
              environment(),
            );
            expect(transition.state).toBe(ended);
            expect(transition.actions).toEqual([]);
          }
        },
      ),
      { seed: 20261014, numRuns: 40 },
    );
  });

  it('converges generated bounded model histories through the public factory', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('FINISH', 'INVALID', 'TOOLS'), { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        async (history, beforeAck) => {
          const modelOutputs = history.map((kind) =>
            kind === 'FINISH'
              ? finishOutput
              : kind === 'INVALID'
                ? { hasText: false, finishReason: 'STOP' as const, toolCalls: [] }
                : {
                    hasText: false,
                    finishReason: 'TOOL_CALLS' as const,
                    toolCalls: [
                      {
                        toolCallId: 'read',
                        toolName: 'read_file',
                        arguments: { path: 'a.ts' },
                      },
                    ],
                  },
          );
          const result = await runWorkflowCase({
            entry: cycleDefinitions(),
            modelOutputs,
            beforeAck,
          });
          expect(result.faults).toEqual([]);
          expect(result.gateway.calls.filter((call) => call.kind === 'CLOSE')).toHaveLength(1);
          expect(result.emitted.at(-1)?.event.type).toBe('RunClosed');
          expect(result.gateway.calls.at(-1)?.kind).toBe('CLOSE');
        },
      ),
      { seed: 20261014, numRuns: 20 },
    );
  });
});
