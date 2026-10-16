import {
  createM1ProtocolRegistry,
  newId,
  type CatalogPort,
  type InteractionGatewayPort,
  type InteractionInboxEvent,
  type PersistencePort,
  type WorkflowGatewayPort,
  type WorkflowInboxEvent,
} from '@multiagentos/contracts';
import {
  createUserInteraction,
  type UserInteractionDeps,
  type UserInteractionModule,
} from '@multiagentos/user-interaction';
import {
  DEFAULT_WORKFLOW_CONFIG,
  createWorkflow,
  type WorkflowDeps,
  type WorkflowModule,
} from '@multiagentos/workflow';
import { SCHEMA_IDS, serveInteractionInbox, serveWorkflowInbox } from '@multiagentos/fabric';
import { createFakeUserInteraction } from '../fakes/fake-user-interaction.js';
import { createFakeWorkflow } from '../fakes/fake-workflow.js';
import { createFakeTerminal } from '../fakes/fake-terminal.js';
import { FakeCatalogPort } from '../fakes/fake-catalog-port.js';
import { describeInboxPortContract } from './inbox-port-contract.js';

const now = () => new Date('2026-10-15T00:00:00.000Z');
const ack = (request: { requestId: string }) =>
  Promise.resolve({ requestId: request.requestId, outcome: 'ACCEPTED' as const });

/** In-memory storage stays behind the public PersistencePort used by each implementation. */
function persistence(): PersistencePort {
  const records = new Map<string, { readonly id: string }>();
  return {
    repository: <T extends { readonly id: string }>() => ({
      get: (id: string) => Promise.resolve(records.get(id) as T | undefined),
      put: (record: T) => {
        records.set(record.id, record);
        return Promise.resolve();
      },
    }),
    auditLog: () => ({ append: () => Promise.resolve() }),
    capabilities: () => [],
  };
}

for (const [name, factory] of [
  ['Workflow', createWorkflow],
  ['FakeWorkflow', createFakeWorkflow()],
] satisfies [string, (deps: WorkflowDeps) => WorkflowModule][]) {
  describeInboxPortContract<WorkflowInboxEvent>(name, {
    channel: 'inbox.workflow',
    schemaId: SCHEMA_IDS.workflowInboxEvent,
    receiver: 'workflow',
    serve: (fabric, deliver) => serveWorkflowInbox(fabric, { deliver }),
    create: () => {
      const observed: string[] = [];
      const runIds = [newId('wfr'), newId('wfr')];
      const unavailable = new FakeCatalogPort([]);
      const catalog: CatalogPort = {
        pinAgent: (request, context) => {
          observed.push(context.workflowRunId ?? '');
          return unavailable.pinAgent(request, context);
        },
        getDefinition: (request, context) => unavailable.getDefinition(request, context),
        capabilities: () => unavailable.capabilities(),
      };
      const gateway: WorkflowGatewayPort = {
        registerAgentRun: ack,
        submitUnit: ack,
        endAgentRun: ack,
        closeRun: ack,
      };
      const module = factory({
        catalog,
        gateway,
        persistence: persistence(),
        registry: createM1ProtocolRegistry(),
        config: DEFAULT_WORKFLOW_CONFIG,
        now,
      });
      return Promise.resolve({
        deliver: (event) => module.inbox.deliver(event),
        start: () => module.start(),
        stop: () => module.stop(),
        event: (index) => ({
          eventId: newId('evt'),
          workflowRunId: runIds[index] ?? '',
          seq: index + 1,
          occurredAt: now().toISOString(),
          event: { type: 'RunStart', goal: '分析仓库' },
        }),
        observed: () => observed,
        expected: (index) => runIds[index] ?? '',
        dispose: () => module.stop(),
      });
    },
  });
}

for (const [name, factory] of [
  ['UserInteraction', createUserInteraction],
  ['FakeUserInteraction', createFakeUserInteraction()],
] satisfies [string, (deps: UserInteractionDeps) => UserInteractionModule][]) {
  describeInboxPortContract<InteractionInboxEvent>(name, {
    channel: 'inbox.user-interaction',
    schemaId: SCHEMA_IDS.interactionInboxEvent,
    receiver: 'user-interaction',
    serve: (fabric, deliver) => serveInteractionInbox(fabric, { deliver }),
    create: async () => {
      const workflowRunId = newId('wfr');
      const observed: string[] = [];
      const resolutions = ['TIMED_OUT', 'CANCELLED'] as const;
      const gateway: InteractionGatewayPort = {
        createRun: (request) =>
          Promise.resolve({ requestId: request.requestId, outcome: 'ACCEPTED', workflowRunId }),
        answerAuthorization: ack,
        cancelRun: ack,
        shutdown: ack,
        readArtifact: (request) =>
          Promise.resolve({
            requestId: request.requestId,
            outcome: 'REJECTED',
            issuer: 'CORE',
            reasonCode: 'INVALID_ARTIFACT_REF',
          }),
      };
      const terminal = createFakeTerminal();
      terminal.write = (text) => {
        if (text.includes('授权询问已超时')) observed.push('TIMED_OUT');
        if (text.includes('授权询问已取消')) observed.push('CANCELLED');
      };
      const module = factory({ gateway, terminal, now });
      const analysis = module.analyze({
        goal: '分析仓库',
        repositoryPath: '/repository',
        details: false,
      });
      // Product stop rejects an unfinished command; always observe that rejection.
      void analysis.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const trace = () => {
        if ('events' in module) {
          const fake = module as ReturnType<ReturnType<typeof createFakeUserInteraction>>;
          return fake.events.flatMap((event) =>
            event.type === 'AuthorizationResolved' ? [event.resolution] : [],
          );
        }
        return observed;
      };
      return {
        deliver: (event) => module.inbox.deliver(event),
        start: () => module.start(),
        stop: () => module.stop(),
        event: (index) => ({
          eventId: newId('evt'),
          workflowRunId,
          seq: index + 1,
          occurredAt: now().toISOString(),
          event: {
            type: 'AuthorizationResolved',
            questionId: newId('qst'),
            resolution: resolutions[index] ?? 'CANCELLED',
          },
        }),
        observed: trace,
        expected: (index) => resolutions[index] ?? '',
        dispose: async () => {
          await module.stop();
          // The fake exposes an uncompleted analyze promise; it owns no active resources.
        },
      };
    },
  });
}
