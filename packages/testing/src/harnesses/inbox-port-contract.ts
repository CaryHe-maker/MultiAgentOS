import {
  createM1ProtocolRegistry,
  newId,
  type BoundaryContext,
  type FabricPort,
  type InteractionInboxEvent,
  type WorkflowInboxEvent,
} from '@multiagentos/contracts';
import { InProcessFabric, SCHEMA_IDS } from '@multiagentos/fabric';
import { describe, expect, it } from 'vitest';

type InboxEvent = InteractionInboxEvent | WorkflowInboxEvent;

/** Observations must come from public effects or a fake's documented event trace. */
export interface InboxPortContractFixture<Event extends InboxEvent> {
  readonly channel: 'inbox.workflow' | 'inbox.user-interaction';
  readonly schemaId: string;
  readonly receiver: 'workflow' | 'user-interaction';
  serve(fabric: FabricPort, deliver: (event: Event) => Promise<void>): void;
  create(): Promise<{
    deliver(event: Event): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    event(index: number): Event;
    observed(): readonly string[];
    expected(index: number): string;
    dispose(): Promise<void>;
  }>;
}

/**
 * Runs the common asynchronous acceptance, deduplication, arrival order and drain contract.
 * Domain-specific failure policies and lifecycle reuse are intentionally separate suites.
 */
export function describeInboxPortContract<Event extends InboxEvent>(
  name: string,
  fixture: InboxPortContractFixture<Event>,
): void {
  describe(`${name} Inbox port contract`, () => {
    it.each(['EXTRA_FIELD', 'MISSING_EVENT', 'UNSUPPORTED_EVENT'] as const)(
      'rejects direct %s delivery before effects or queue contamination',
      async (kind) => {
        const test = await fixture.create();
        await test.start();
        try {
          const event = test.event(0);
          const invalid: unknown =
            kind === 'EXTRA_FIELD'
              ? { ...event, extra: true }
              : {
                  ...event,
                  event:
                    kind === 'MISSING_EVENT'
                      ? undefined
                      : {
                          type: 'UnsupportedInboxAction',
                        },
                };
          await expect(test.deliver(invalid as Event)).rejects.toThrow(
            'Inbox event violates its contract',
          );
          expect(test.observed()).toEqual([]);
          // Rejection must not reserve eventId or prevent the next legal message.
          await test.deliver(event);
          await test.stop();
          expect(test.observed()).toEqual([test.expected(0)]);
        } finally {
          await test.dispose();
        }
      },
    );

    it('copies a direct delivery before the caller can change the queued event', async () => {
      const test = await fixture.create();
      try {
        const event = test.event(0);
        await test.deliver(event);
        event.workflowRunId = newId('wfr');
        if (event.event.type === 'AuthorizationResolved') event.event.resolution = 'GRANTED';
        await test.start();
        await test.stop();
        expect(test.observed()).toEqual([test.expected(0)]);
      } finally {
        await test.dispose();
      }
    });

    it('rejects a foreign event even when Fabric accepts its declared schema', async () => {
      const test = await fixture.create();
      const fabric = new InProcessFabric(createM1ProtocolRegistry());
      try {
        await fabric.start();
        await test.start();
        fixture.serve(fabric.client(fixture.receiver), (event) => test.deliver(event));
        const event = test.event(0);
        const isWorkflow = fixture.channel === 'inbox.workflow';
        const foreign = {
          ...event,
          event: isWorkflow
            ? { type: 'AuthorizationResolved', questionId: newId('qst'), resolution: 'CANCELLED' }
            : { type: 'RunStart', goal: '分析仓库' },
        };
        await expect(
          fabric
            .client('kernel-core')
            .send(
              fixture.channel,
              isWorkflow ? SCHEMA_IDS.interactionInboxEvent : SCHEMA_IDS.workflowInboxEvent,
              foreign,
              {
                correlationId: newId('cor'),
                tenantId: 'local',
                projectId: 'contract',
                workflowRunId: event.workflowRunId,
              },
            ),
        ).rejects.toThrow('Inbox event violates its contract');
        await test.stop();
        expect(test.observed()).toEqual([]);
      } finally {
        await test.dispose();
        await fabric.stop();
      }
    });

    it('acknowledges a queued event without waiting for its consumer', async () => {
      const test = await fixture.create();
      try {
        await test.deliver(test.event(0));
        expect(test.observed()).toEqual([]);
        await test.start();
        await test.stop();
        expect(test.observed()).toEqual([test.expected(0)]);
      } finally {
        await test.dispose();
      }
    });

    it('processes a repeated eventId once', async () => {
      const test = await fixture.create();
      try {
        const event = test.event(0);
        await test.deliver(event);
        await test.deliver(structuredClone(event));
        await test.start();
        await test.stop();
        expect(test.observed()).toEqual([test.expected(0)]);
      } finally {
        await test.dispose();
      }
    });

    it('processes accepted events by arrival instead of numeric sequence', async () => {
      const test = await fixture.create();
      try {
        const first = test.event(0);
        const second = test.event(1);
        first.seq = 2;
        second.seq = 1;
        await test.deliver(first);
        await test.deliver(second);
        await test.start();
        await test.stop();
        expect(test.observed()).toEqual([test.expected(0), test.expected(1)]);
      } finally {
        await test.dispose();
      }
    });

    it('drains all accepted events before stop resolves', async () => {
      const test = await fixture.create();
      try {
        await test.start();
        await test.deliver(test.event(0));
        await test.deliver(test.event(1));
        await test.stop();
        expect(test.observed()).toEqual([test.expected(0), test.expected(1)]);
      } finally {
        await test.dispose();
      }
    });

    it('rejects extra fields and unknown major before side effects', async () => {
      const test = await fixture.create();
      const fabric = new InProcessFabric(createM1ProtocolRegistry());
      try {
        await fabric.start();
        fixture.serve(fabric.client(fixture.receiver), (event) => test.deliver(event));
        const sender = fabric.client('kernel-core');
        const event = test.event(0);
        const context: BoundaryContext = {
          correlationId: newId('cor'),
          tenantId: 'local',
          projectId: 'contract',
          workflowRunId: event.workflowRunId,
        };
        await expect(
          sender.send(fixture.channel, fixture.schemaId, { ...event, extra: true }, context),
        ).rejects.toThrow('Contract validation failed');
        await expect(
          sender.send(fixture.channel, fixture.schemaId.replace('.v0', '.v99'), event, context),
        ).rejects.toThrow('UNKNOWN_SCHEMA_MAJOR');
        await test.start();
        await test.stop();
        expect(test.observed()).toEqual([]);
      } finally {
        await test.dispose();
        await fabric.stop();
      }
    });

    it('copies the published event before the sender can mutate it', async () => {
      const test = await fixture.create();
      const fabric = new InProcessFabric(createM1ProtocolRegistry());
      try {
        await fabric.start();
        fixture.serve(fabric.client(fixture.receiver), (event) => test.deliver(event));
        const event = test.event(0);
        await fabric.client('kernel-core').send(fixture.channel, fixture.schemaId, event, {
          correlationId: newId('cor'),
          tenantId: 'local',
          projectId: 'contract',
          workflowRunId: event.workflowRunId,
        });
        event.workflowRunId = newId('wfr');
        if (event.event.type === 'AuthorizationResolved') event.event.resolution = 'GRANTED';
        await test.start();
        await test.stop();
        expect(test.observed()).toEqual([test.expected(0)]);
      } finally {
        await test.dispose();
        await fabric.stop();
      }
    });
  });
}
