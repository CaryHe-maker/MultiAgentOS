import {
  PinnedDefinitionSetSchema,
  RegisterAgentRunRequestSchema,
  CloseRunRequestSchema,
  createM1ProtocolRegistry,
  newId,
  validate,
} from '@multiagentos/contracts';
import type { SystemFault, WorkflowInboxEvent } from '@multiagentos/contracts';
import { FabricError } from '@multiagentos/fabric';
import { describe, expect, it, vi } from 'vitest';
import { createWorkflow, DEFAULT_WORKFLOW_CONFIG } from '../index.js';
import { definitions } from '../test-support/definitions.js';
import { FixedCatalog } from '../test-support/fixed-catalog.js';
import { MemoryPersistence } from '../test-support/memory-persistence.js';
import { ScriptedGateway } from '../test-support/scripted-gateway.js';
import type { WorkflowDeps } from '../index.js';

const now = () => new Date('2026-10-14T00:00:00.000Z');
/** What Fabric or the composition root's wrapper rejects with once the port deadline passes. */
const timedOut = (detail: string) => new FabricError('REQUEST_TIMEOUT', detail);

function startEvent(): WorkflowInboxEvent {
  return {
    eventId: newId('evt'),
    workflowRunId: newId('wfr'),
    seq: 1,
    occurredAt: now().toISOString(),
    event: { type: 'RunStart', goal: '分析仓库' },
  };
}

function setup(extra: Partial<WorkflowDeps> = {}) {
  const gateway = new ScriptedGateway();
  const catalog = new FixedCatalog([definitions(), definitions('code-viewer', false)]);
  const module = createWorkflow({
    gateway,
    catalog,
    persistence: new MemoryPersistence(),
    registry: createM1ProtocolRegistry(),
    config: DEFAULT_WORKFLOW_CONFIG,
    now,
    ...extra,
  });
  gateway.inbox = module.inbox;
  return { module, gateway, catalog };
}

describe('Workflow pinning and registration', () => {
  it('pins both agents and registers only the entry without starting in the factory', async () => {
    const { module, gateway, catalog } = setup();
    expect((await module.health()).status).toBe('DOWN');
    const envelope = startEvent();
    await module.inbox.deliver(envelope);
    expect(catalog.requests).toEqual([]);
    await module.start();
    await module.stop();
    expect(catalog.requests).toEqual([
      { id: 'planner', version: 'v0.1.0' },
      { id: 'code-viewer', version: 'v0.1.0' },
    ]);
    expect(gateway.calls).toHaveLength(2);
    const call = gateway.calls[0];
    expect(call?.kind).toBe('REGISTER');
    expect(call?.request).toMatchObject({
      workflowRunId: envelope.workflowRunId,
      agentRef: { id: 'planner', digest: 'a'.repeat(64) },
    });
    expect(validate(RegisterAgentRunRequestSchema, call?.request).ok).toBe(true);
    expect(gateway.contexts[0]).toMatchObject({ workflowRunId: envelope.workflowRunId });
  });

  it('pins only the entry when there is no handoff target', async () => {
    const catalog = new FixedCatalog([definitions('planner', false)]);
    const { module, gateway } = setup({ catalog });
    await module.start();
    await module.inbox.deliver(startEvent());
    await module.stop();
    expect(catalog.requests).toHaveLength(1);
    expect(gateway.calls.map((call) => call.kind)).toEqual(['REGISTER', 'SUBMIT']);
  });

  it.each(['ENTRY', 'TARGET', 'DIGEST'] as const)(
    'closes with PIN_FAILED on %s pinning failure',
    async (failure) => {
      const catalog = new FixedCatalog(
        failure === 'ENTRY'
          ? []
          : failure === 'TARGET'
            ? [definitions()]
            : [
                definitions(),
                {
                  ...definitions('code-viewer', false),
                  agent: { ...definitions('code-viewer', false).agent, digest: 'b'.repeat(64) },
                },
              ],
      );
      const { module, gateway } = setup({ catalog });
      await module.start();
      await module.inbox.deliver(startEvent());
      await module.stop();
      expect(gateway.calls.map((call) => call.kind)).toEqual(['CLOSE']);
      expect(gateway.calls[0]?.request).toMatchObject({
        outcome: 'FAILED',
        failure: { code: 'PIN_FAILED', category: 'DEPENDENCY', source: 'WORKFLOW' },
      });
      expect(validate(CloseRunRequestSchema, gateway.calls[0]?.request).ok).toBe(true);
    },
  );

  it.each(['FORBIDDEN', 'RUN_BLOCKED'] as const)(
    'handles registration rejected with %s',
    async (code) => {
      const { module, gateway } = setup();
      gateway.scripts.push((call) =>
        Promise.resolve(
          code === 'RUN_BLOCKED'
            ? {
                requestId: call.request.requestId,
                outcome: 'REJECTED',
                issuer: 'CORE',
                reasonCode: 'RUN_BLOCKED',
                closeReason: 'CANCELLED',
              }
            : {
                requestId: call.request.requestId,
                outcome: 'REJECTED',
                issuer: 'CORE',
                reasonCode: 'FORBIDDEN',
              },
        ),
      );
      await module.start();
      await module.inbox.deliver(startEvent());
      await module.stop();
      expect(gateway.calls.map((call) => call.kind)).toEqual(
        code === 'RUN_BLOCKED' ? ['REGISTER'] : ['REGISTER', 'CLOSE'],
      );
    },
  );

  it('deduplicates eventId without waiting for a seq gap', async () => {
    const { module, gateway } = setup();
    const envelope = { ...startEvent(), seq: 7 };
    await module.start();
    await module.inbox.deliver(envelope);
    await module.inbox.deliver(envelope);
    await module.stop();
    expect(gateway.calls).toHaveLength(2);
  });

  it('deliver does not wait for registration and stop drains the queue', async () => {
    const { module, gateway } = setup();
    let accept: (() => void) | undefined;
    let notifyRegistration: () => void = () => {};
    const registering = new Promise<void>((resolve) => {
      notifyRegistration = resolve;
    });
    gateway.scripts.push(
      (call) =>
        new Promise((resolve) => {
          accept = () => resolve({ requestId: call.request.requestId, outcome: 'ACCEPTED' });
          notifyRegistration();
        }),
    );
    await module.start();
    await module.inbox.deliver(startEvent());
    await registering;
    let isStopped = false;
    const stopping = module.stop().then(() => {
      isStopped = true;
    });
    expect(isStopped).toBe(false);
    accept?.();
    await stopping;
    expect(isStopped).toBe(true);
    await module.stop();
    expect((await module.health()).status).toBe('DOWN');
  });

  it('stop before start drains queued events and repeated stops share the result', async () => {
    const { module, gateway } = setup();
    await module.inbox.deliver(startEvent());
    const first = module.stop();
    expect(module.stop()).toBe(first);
    await first;
    expect(gateway.calls).toHaveLength(2);
  });

  it('issues no requests after RunClosed', async () => {
    const { module, gateway } = setup();
    const envelope = startEvent();
    await module.start();
    await module.inbox.deliver(envelope);
    await module.inbox.deliver({
      ...envelope,
      eventId: newId('evt'),
      seq: 2,
      event: {
        type: 'RunClosed',
        closeReason: 'CANCELLED',
        unknownEffects: [],
        finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
      },
    });
    await module.inbox.deliver({ ...envelope, eventId: newId('evt'), seq: 3 });
    await module.stop();
    expect(gateway.calls).toHaveLength(2);
  });

  it('closes after a registration error and escalates only if closure also fails', async () => {
    const reportSystemFault = vi.fn<(fault: SystemFault) => void>();
    const { module, gateway } = setup({ reportSystemFault });
    gateway.scripts.push(
      () => Promise.reject(new Error('Injected transport failure')),
      () => Promise.reject(new Error('Injected close failure')),
    );
    await module.start();
    await module.inbox.deliver(startEvent());
    await module.stop();
    expect(gateway.calls.map((call) => call.kind)).toEqual(['REGISTER', 'CLOSE']);
    expect(reportSystemFault).toHaveBeenCalledTimes(1);
    const fault = reportSystemFault.mock.calls[0]?.[0];
    expect(fault?.source).toBe('workflow');
    expect(fault?.phase).toBe('RUN');
    expect(fault?.error).toBeInstanceOf(Error);
    expect(fault?.error).toBeInstanceOf(AggregateError);
    expect((fault?.error as AggregateError).errors).toHaveLength(2);
  });

  it('stop preserves unobserved errors when no fault reporter is provided', async () => {
    const { module, gateway } = setup();
    gateway.scripts.push(
      () => Promise.reject(new Error('Injected transport failure')),
      () => Promise.reject(new Error('Injected close failure')),
    );
    await module.start();
    await module.inbox.deliver(startEvent());
    await expect(module.stop()).rejects.toThrow('Workflow failure could not be closed');
    await expect(module.stop()).rejects.toThrow('Workflow failure could not be closed');
  });

  it('rejects extra fields without processing the invalid event', async () => {
    const { module, gateway } = setup();
    await expect(
      module.inbox.deliver({ ...startEvent(), extra: true } as WorkflowInboxEvent),
    ).rejects.toThrow('event violates its contract');
    await module.stop();
    expect(gateway.calls).toEqual([]);
  });

  it('rejects an unsupported feature before pinning definitions or submitting work', async () => {
    const { module, gateway, catalog } = setup();
    await expect(
      module.inbox.deliver({
        ...startEvent(),
        event: { type: 'RestoreRequested' },
      } as unknown as WorkflowInboxEvent),
    ).rejects.toThrow('event violates its contract');
    await module.stop();
    expect(catalog.requests).toEqual([]);
    expect(gateway.calls).toEqual([]);
  });

  it('copies an accepted start before the caller can change the objective', async () => {
    const { module, gateway } = setup();
    const event = startEvent();
    const accepted = module.inbox.deliver(event);
    if (event.event.type !== 'RunStart') throw new Error('Expected a start event');
    event.event.goal = 'Changed after publication';
    await accepted;
    await module.start();
    await module.stop();
    expect(gateway.calls.at(-1)?.request).toMatchObject({ input: { objective: '分析仓库' } });
  });

  it('test definition sets satisfy the shared Schema', () => {
    expect(validate(PinnedDefinitionSetSchema, definitions()).ok).toBe(true);
    expect(validate(PinnedDefinitionSetSchema, definitions('code-viewer', false)).ok).toBe(true);
  });

  it('stops business actions after an escalated fault', async () => {
    const reportSystemFault = vi.fn<(fault: SystemFault) => void>();
    const { module, gateway, catalog } = setup({ reportSystemFault });
    const envelope = startEvent();
    await module.start();
    await module.inbox.deliver({
      ...envelope,
      event: {
        type: 'RunClosed',
        closeReason: 'CANCELLED',
        unknownEffects: [],
        finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
      },
    });
    await module.inbox.deliver(startEvent());
    await module.stop();
    expect(reportSystemFault).toHaveBeenCalledTimes(1);
    expect(gateway.calls).toEqual([]);
    expect(catalog.requests).toEqual([]);
  });

  it('escalates a port deadline at once and still records queued closure', async () => {
    const persistence = new MemoryPersistence();
    const reportSystemFault = vi.fn<(fault: SystemFault) => void>();
    const { module, gateway } = setup({ persistence, reportSystemFault });
    gateway.scripts.push(() => Promise.reject(timedOut('workflow-register')));
    const envelope = startEvent();
    await module.start();
    await module.inbox.deliver(envelope);
    await module.inbox.deliver({
      ...envelope,
      eventId: newId('evt'),
      seq: 2,
      event: {
        type: 'RunClosed',
        closeReason: 'CANCELLED',
        unknownEffects: [],
        finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
      },
    });
    await module.stop();
    expect(reportSystemFault).toHaveBeenCalledTimes(1);
    expect(gateway.calls.map((call) => call.kind)).toEqual(['REGISTER']);
    expect(persistence.writes).toHaveLength(1);
    // A deadline is escalated, not closed through a diagnostic and closeRun.
    expect(persistence.entries).toEqual([]);
  });

  it('persists safe diagnostics when an internal failure can be closed', async () => {
    const persistence = new MemoryPersistence();
    const { module, gateway } = setup({ persistence });
    gateway.scripts.push(() => Promise.reject(new Error('secret-source-content')));
    await module.start();
    await module.inbox.deliver(startEvent());
    await module.stop();
    expect(persistence.entries).toMatchObject([{ operation: 'REGISTER', code: 'PORT_FAILURE' }]);
    expect(JSON.stringify(persistence.entries)).not.toContain('secret-source-content');
    expect(gateway.calls.map((call) => call.kind)).toEqual(['REGISTER', 'CLOSE']);
  });

  it('escalates a catalog deadline without starting business requests', async () => {
    const catalog = new FixedCatalog([definitions()]);
    vi.spyOn(catalog, 'pinAgent').mockRejectedValue(timedOut('catalog.pinAgent'));
    const reportSystemFault = vi.fn<(fault: SystemFault) => void>();
    const { module, gateway } = setup({ catalog, reportSystemFault });
    await module.start();
    await module.inbox.deliver(startEvent());
    await module.stop();
    expect(reportSystemFault).toHaveBeenCalledTimes(1);
    expect(gateway.calls).toEqual([]);
  });

  it('escalates a terminal record write deadline without reopening the run', async () => {
    const persistence = new MemoryPersistence();
    vi.spyOn(persistence, 'repository').mockImplementation(() => ({
      get: () => Promise.resolve(undefined),
      put: () => Promise.reject(timedOut('persistence.repository.put')),
    }));
    const reportSystemFault = vi.fn<(fault: SystemFault) => void>();
    const { module, gateway } = setup({ persistence, reportSystemFault });
    const envelope = startEvent();
    await module.start();
    await module.inbox.deliver(envelope);
    await module.inbox.deliver({
      ...envelope,
      eventId: newId('evt'),
      seq: 2,
      event: {
        type: 'RunClosed',
        closeReason: 'CANCELLED',
        unknownEffects: [],
        finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
      },
    });
    await module.stop();
    expect(reportSystemFault).toHaveBeenCalledTimes(1);
    expect(gateway.calls.map((call) => call.kind)).toEqual(['REGISTER', 'SUBMIT']);
  });
});
