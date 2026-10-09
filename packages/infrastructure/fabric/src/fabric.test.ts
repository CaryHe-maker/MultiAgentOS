import {
  ContractValidationError,
  createM1ProtocolRegistry,
  type BoundaryContext,
  type ShutdownRequest,
  type SyscallAck,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import {
  FabricError,
  InProcessFabric,
  Inbox,
  OrderedSender,
  SCHEMA_IDS,
  createInteractionGatewayPort,
} from './index.js';

const context: BoundaryContext = {
  correlationId: 'cor_123456',
  tenantId: 'local',
  projectId: 'local',
};
const request: ShutdownRequest = { requestId: 'req_123456' };

async function started(): Promise<InProcessFabric> {
  const fabric = new InProcessFabric(createM1ProtocolRegistry());
  await fabric.start();
  return fabric;
}

describe('InProcessFabric', () => {
  it('routes a request, fixes the producer and copies payload and response', async () => {
    const fabric = await started();
    const response: SyscallAck = { requestId: request.requestId, outcome: 'ACCEPTED' };
    let received: unknown;
    fabric
      .client('gateway')
      .register<ShutdownRequest, SyscallAck>(SCHEMA_IDS.shutdown, (envelope) => {
        received = envelope;
        return Promise.resolve(response);
      });
    const port = createInteractionGatewayPort(fabric.client('user-interaction'));
    const result = await port.shutdown(request, context);
    expect(result).toEqual(response);
    expect(result).not.toBe(response);
    expect(received).toMatchObject({
      schemaName: 'kernel.control.ShutdownRequest',
      schemaVersion: 0,
      producer: 'user-interaction',
      correlationId: context.correlationId,
      payload: request,
    });
    expect((received as { payload: unknown }).payload).not.toBe(request);
  });

  it('rejects payloads that break the Schema and unknown Schema IDs', async () => {
    const fabric = await started();
    const client = fabric.client('user-interaction');
    fabric.client('gateway').register(SCHEMA_IDS.shutdown, () => Promise.resolve(undefined));
    await expect(
      client.request(SCHEMA_IDS.shutdown, { requestId: 'bad' }, context),
    ).rejects.toThrow(ContractValidationError);
    await expect(client.request('kernel.control.Missing.v0', {}, context)).rejects.toThrow(
      'UNKNOWN_SCHEMA_MAJOR',
    );
  });

  it('reports missing handlers, double registration and use while stopped', async () => {
    const fabric = await started();
    const client = fabric.client('user-interaction');
    await expect(client.request(SCHEMA_IDS.shutdown, request, context)).rejects.toThrow(
      FabricError,
    );
    const gateway = fabric.client('gateway');
    gateway.register(SCHEMA_IDS.shutdown, () => Promise.resolve(undefined));
    expect(() => gateway.register(SCHEMA_IDS.shutdown, () => Promise.resolve(undefined))).toThrow(
      'ALREADY_REGISTERED',
    );
    await fabric.stop();
    await expect(client.request(SCHEMA_IDS.shutdown, request, context)).rejects.toThrow(
      'NOT_RUNNING',
    );
    expect((await fabric.health()).status).toBe('DOWN');
  });
});

describe('Inbox', () => {
  it('handles one message at a time and takes the control channel first', async () => {
    const inbox = new Inbox<string, void, 'control' | 'work'>({ channels: ['control', 'work'] });
    const handled: string[] = [];
    let active = 0;
    inbox.enqueue('work-1', 'work');
    inbox.enqueue('work-2', 'work');
    inbox.enqueue('control-1', 'control');
    inbox.start(async (message) => {
      active += 1;
      expect(active).toBe(1);
      if (message === 'control-1') inbox.enqueue('control-2', 'control');
      await Promise.resolve();
      handled.push(message);
      active -= 1;
    });
    await inbox.idle();
    expect(handled).toEqual(['control-1', 'control-2', 'work-1', 'work-2']);
  });

  it('drops duplicates by key and keeps going after a handler error', async () => {
    const errors: unknown[] = [];
    const inbox = new Inbox<{ id: string }>({
      channels: ['default'],
      dedupeKey: (message) => message.id,
      onError: (error) => errors.push(error),
    });
    const handled: string[] = [];
    inbox.start((message) => {
      if (message.id === 'b') return Promise.reject(new Error('boom'));
      handled.push(message.id);
      return Promise.resolve();
    });
    expect(inbox.enqueue({ id: 'a' })).toBe(true);
    expect(inbox.enqueue({ id: 'a' })).toBe(false);
    inbox.enqueue({ id: 'b' });
    inbox.enqueue({ id: 'c' });
    await inbox.idle();
    expect(handled).toEqual(['a', 'c']);
    expect(errors).toHaveLength(1);
  });

  it('returns the handler result to a requester', async () => {
    const inbox = new Inbox<number, number>({ channels: ['default'] });
    inbox.start((message) => Promise.resolve(message * 2));
    expect(await inbox.request(21)).toBe(42);
  });
});

describe('OrderedSender', () => {
  it('sends in registration order, one at a time, and skips failures', async () => {
    const sent: number[] = [];
    const failed: number[] = [];
    const sender = new OrderedSender<number>(
      async (item) => {
        await Promise.resolve();
        if (item === 2) throw new Error('contract defect');
        sent.push(item);
      },
      (_error, item) => failed.push(item),
    );
    for (const item of [1, 2, 3]) sender.enqueue(item);
    await sender.flushed();
    expect(sent).toEqual([1, 3]);
    expect(failed).toEqual([2]);
  });
});
