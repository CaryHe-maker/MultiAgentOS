import { WorkflowInboxEventSchema, newId, validate } from '@multiagentos/contracts';
import type { BoundaryContext, WorkflowInboxEvent } from '@multiagentos/contracts';
import { FabricError, Inbox } from '@multiagentos/fabric';
import type { WorkflowDeps, WorkflowModule } from '../index.js';
import { reduceWorkflow } from '../domain/reducer.js';
import type { WorkflowAction, WorkflowInput } from '../domain/reducer.js';
import type { WorkflowState } from '../domain/state.js';

/** Fabric and the composition root enforce the port deadline (Workflow.md 11.1). */
const isPortTimeout = (error: unknown): boolean =>
  error instanceof FabricError && error.code === 'REQUEST_TIMEOUT';

/** Builds the consumer without starting it; all effects use public ports. */
export function createWorkflowRunner(deps: WorkflowDeps): WorkflowModule {
  const states = new Map<string, WorkflowState>();
  let isStarted = false;
  let isStopping = false;
  let stopTask: Promise<void> | undefined;
  let hasFault = false;
  const operationErrors = new Map<string, { operation: string; error: unknown }>();
  const now = deps.now ?? (() => new Date());
  const contextOf = (workflowRunId: string): BoundaryContext => ({
    correlationId: newId('cor'),
    tenantId: 'local',
    projectId: 'local',
    workflowRunId,
  });

  async function executeUnchecked(
    action: WorkflowAction,
    workflowRunId: string,
  ): Promise<WorkflowInput> {
    const context = contextOf(workflowRunId);
    switch (action.kind) {
      case 'PIN':
        return {
          kind: 'PIN_RESULT',
          role: action.role,
          result: await deps.catalog.pinAgent(action.request, context),
        };
      case 'REGISTER':
        return {
          kind: 'SYSCALL_RESULT',
          action: 'REGISTER',
          result: await deps.gateway.registerAgentRun(action.request, context),
        };
      case 'CLOSE':
        return {
          kind: 'SYSCALL_RESULT',
          action: 'CLOSE',
          result: await deps.gateway.closeRun(action.request, context),
        };
      case 'SUBMIT':
        return {
          kind: 'SYSCALL_RESULT',
          action: 'SUBMIT',
          result: await deps.gateway.submitUnit(action.request, context),
        };
      case 'END':
        return {
          kind: 'SYSCALL_RESULT',
          action: 'END',
          result: await deps.gateway.endAgentRun(action.request, context),
        };
      case 'WRITE_RECORD':
        await deps.persistence
          .repository<typeof action.record>('workflow', workflowRunId)
          .put(action.record);
        return { kind: 'RECORD_WRITTEN' };
    }
  }

  async function execute(action: WorkflowAction, workflowRunId: string): Promise<WorkflowInput> {
    try {
      return await executeUnchecked(action, workflowRunId);
    } catch (error) {
      operationErrors.set(workflowRunId, { operation: action.kind, error });
      throw error;
    }
  }

  async function advance(workflowRunId: string, input: WorkflowInput): Promise<void> {
    const transition = reduceWorkflow(states.get(workflowRunId), input, {
      config: deps.config,
      requestId: newId('req'),
      agentRunId: newId('agr'),
      requestIds: Array.from({ length: 32 }, () => newId('req')),
      registry: deps.registry,
      createdAt: now().toISOString(),
    });
    states.set(workflowRunId, transition.state);
    for (const action of transition.actions) {
      if (hasFault && action.kind !== 'WRITE_RECORD') continue;
      const current = states.get(workflowRunId);
      if (current?.closed !== undefined && action.kind !== 'WRITE_RECORD') continue;
      if (current?.phase === 'CLOSING' && action.kind !== 'CLOSE' && action.kind !== 'WRITE_RECORD')
        continue;
      await advance(workflowRunId, await execute(action, workflowRunId));
    }
  }

  async function handle(envelope: WorkflowInboxEvent): Promise<void> {
    if (hasFault && (envelope.event.type !== 'RunClosed' || !states.has(envelope.workflowRunId)))
      return;
    try {
      await advance(envelope.workflowRunId, { kind: 'EVENT', envelope });
    } catch (error) {
      const state = states.get(envelope.workflowRunId);
      // Escalate errors after closure or from the close action; never retry at this level.
      if (
        isPortTimeout(error) ||
        state === undefined ||
        state.phase === 'CLOSING' ||
        state.closed !== undefined
      ) {
        hasFault = true;
        operationErrors.delete(envelope.workflowRunId);
        throw error;
      }
      const diagnostic = operationErrors.get(envelope.workflowRunId);
      try {
        // Never persist exception text, stacks, provider responses or source content.
        await deps.persistence.auditLog('workflow', envelope.workflowRunId).append({
          diagnosticId: newId('cor'),
          workflowRunId: envelope.workflowRunId,
          operation: diagnostic?.operation ?? 'REDUCE',
          code: diagnostic === undefined ? 'INTERNAL_ERROR' : 'PORT_FAILURE',
          phase: state.phase,
          occurredAt: now().toISOString(),
        });
        await advance(envelope.workflowRunId, { kind: 'INTERNAL_ERROR' });
      } catch (closureError) {
        hasFault = true;
        throw new AggregateError([error, closureError], 'Workflow failure could not be closed', {
          cause: closureError,
        });
      } finally {
        operationErrors.delete(envelope.workflowRunId);
      }
    }
  }

  const inbox = new Inbox<WorkflowInboxEvent>({
    channels: ['default'],
    dedupeKey: (envelope) => envelope.eventId,
    ...(deps.reportSystemFault === undefined
      ? {}
      : {
          onError: (error: unknown, envelope: WorkflowInboxEvent) => {
            hasFault = true;
            deps.reportSystemFault?.({
              source: 'workflow',
              phase: 'RUN',
              error,
              workflowRunId: envelope.workflowRunId,
            });
          },
        }),
  });

  function startConsumer(): void {
    if (isStarted) return;
    isStarted = true;
    inbox.start(handle);
  }

  return {
    manifest: Object.freeze({
      moduleId: 'workflow',
      version: '0.1.0',
      // Workflow calls Gateway and Persistence directly; the Catalog is a library, not a module.
      dependencies: Object.freeze(['gateway', 'persistence'] as const),
    }),
    inbox: {
      deliver: (envelope) => {
        if (isStopping) return Promise.reject(new Error('Workflow has stopped accepting events'));
        const checked = validate<WorkflowInboxEvent>(WorkflowInboxEventSchema, envelope);
        if (!checked.ok)
          return Promise.reject(new Error('Workflow Inbox event violates its contract'));
        // Copy validated events so the sender cannot mutate a queued message.
        inbox.enqueue(structuredClone(checked.value));
        return Promise.resolve();
      },
    },
    start: () => {
      if (isStopping) return Promise.reject(new Error('Workflow has stopped and cannot start'));
      startConsumer();
      return Promise.resolve();
    },
    stop: () => {
      if (stopTask !== undefined) return stopTask;
      isStopping = true;
      // Events may arrive before start; drain them before completing stop.
      if (inbox.size > 0) startConsumer();
      stopTask = inbox.idle().then(() => {
        isStarted = false;
      });
      return stopTask;
    },
    health: () =>
      Promise.resolve({
        status: hasFault ? 'DEGRADED' : isStarted && !isStopping ? 'UP' : 'DOWN',
        checkedAt: now().toISOString(),
        details: hasFault ? ['Workflow event processing encountered a system fault'] : [],
      }),
  };
}
