import {
  newId,
  type BoundaryContextV1,
  type SessionListEntry,
  type WorkflowGatewayPortV1,
  type WorkflowSessionEvent,
  type WorkflowSystemEvent,
} from '@multiagentos/contracts';

/**
 * Workflow stand-in for the Session part of Kernel work: it answers Session commands, list
 * queries and deletion from memory. `failNext` makes the next command fail, which is how a test
 * reaches the SessionFailed paths. It keeps no log and advances no graph.
 */
export interface FakeSessionWorkflow {
  handle(event: WorkflowSessionEvent | WorkflowSystemEvent): Promise<void>;
  readonly sessions: readonly SessionListEntry[];
  failNext(code: 'SESSION_LOCKED' | 'SESSION_LOG_CORRUPT'): void;
}

const context = (sessionId?: string): BoundaryContextV1 => ({
  correlationId: newId('cor'),
  tenantId: 'local',
  projectId: 'local',
  ...(sessionId === undefined ? {} : { sessionId }),
});

export function createFakeSessionWorkflow(gateway: WorkflowGatewayPortV1): FakeSessionWorkflow {
  const sessions = new Map<string, SessionListEntry>();
  let failure: 'SESSION_LOCKED' | 'SESSION_LOG_CORRUPT' | undefined;

  const reply = (
    sessionId: string,
    commandId: string,
    result: Parameters<WorkflowGatewayPortV1['reportSessionCommand']>[0]['result'],
  ) =>
    gateway.reportSessionCommand(
      { requestId: newId('req'), sessionId, commandId, result },
      context(sessionId),
    );

  return {
    get sessions() {
      return [...sessions.values()];
    },
    failNext: (code) => {
      failure = code;
    },
    handle: async (envelope) => {
      const { event } = envelope;
      if (event.type === 'SessionListQuery') {
        await gateway.reportSessionList(
          {
            requestId: newId('req'),
            queryId: event.queryId,
            sessions: [...sessions.values()].sort((a, b) =>
              b.lastActiveAt.localeCompare(a.lastActiveAt),
            ),
          },
          context(),
        );
        return;
      }
      if (event.type === 'SessionDelete') {
        const entry = sessions.get(event.sessionId);
        if (entry !== undefined) sessions.set(event.sessionId, { ...entry, status: 'DELETED' });
        await reply(event.sessionId, event.commandId, { command: 'DELETE', outcome: 'DONE' });
        return;
      }
      const sessionId = (envelope as WorkflowSessionEvent).sessionId;
      if (failure !== undefined) {
        const code = failure;
        failure = undefined;
        await reply(sessionId, event.commandId, {
          command: event.command,
          outcome: 'FAILED',
          failure: { code },
        });
        return;
      }
      if (event.command === 'CLOSE') {
        await reply(sessionId, event.commandId, { command: 'CLOSE', outcome: 'DONE' });
        return;
      }
      if (event.command === 'CREATE') {
        const at = new Date().toISOString();
        sessions.set(sessionId, {
          sessionId,
          createdAt: at,
          lastActiveAt: at,
          turnCount: 0,
          status: 'ACTIVE',
        });
      }
      await reply(sessionId, event.commandId, { command: event.command, outcome: 'READY' });
    },
  };
}
