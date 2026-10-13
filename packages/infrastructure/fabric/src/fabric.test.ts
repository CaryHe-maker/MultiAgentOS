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

  it('allows only Gateway to handle malformed syscall bodies with a valid requestId', async () => {
    const fabric = await started();
    let handled = false;
    fabric.client('gateway').register(
      SCHEMA_IDS.shutdown,
      () => {
        handled = true;
        return Promise.resolve(undefined);
      },
      (envelope) =>
        Promise.resolve({
          requestId: (envelope.payload as { requestId: string }).requestId,
          outcome: 'REJECTED',
          issuer: 'GATEWAY',
          reasonCode: 'INVALID_REQUEST',
        }),
    );
    const caller = fabric.client('user-interaction');
    await expect(
      caller.request(SCHEMA_IDS.shutdown, { requestId: request.requestId, extra: true }, context),
    ).resolves.toMatchObject({ reasonCode: 'INVALID_REQUEST' });
    await expect(
      caller.request(SCHEMA_IDS.shutdown, { requestId: 'bad' }, context),
    ).rejects.toThrow(ContractValidationError);
    await expect(
      caller.request(SCHEMA_IDS.shutdown, Object.create({ requestId: request.requestId }), context),
    ).rejects.toThrow(ContractValidationError);
    expect(handled).toBe(false);
    await expect(
      caller.request(
        SCHEMA_IDS.shutdown,
        { requestId: request.requestId, extra: true },
        { ...context, correlationId: 'bad' },
      ),
    ).rejects.toThrow(ContractValidationError);
    expect(() =>
      fabric.client('workflow').register(
        SCHEMA_IDS.createRun,
        () => Promise.resolve(),
        () => Promise.resolve(),
      ),
    ).toThrow('INVALID_REGISTRATION');
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

  it('serializes concurrent sends to one address and still delivers after a failed subscriber', async () => {
    const fabric = await started();
    const seen: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    fabric
      .client('gateway')
      .subscribe<{ runState: string }>('gateway.admission', async (envelope) => {
        seen.push(envelope.payload.runState);
        if (envelope.payload.runState === 'RUNNING') {
          markStarted();
          await firstGate;
          throw new Error('subscriber failed');
        }
      });
    const client = fabric.client('kernel-core');
    const first = client.send(
      'gateway.admission',
      SCHEMA_IDS.admissionProjection,
      { workflowRunId: 'wfr_123456', runState: 'RUNNING' },
      context,
    );
    const firstResult = first.catch((error: unknown) => error);
    const second = client.send(
      'gateway.admission',
      SCHEMA_IDS.admissionProjection,
      { workflowRunId: 'wfr_123456', runState: 'CLOSED', closeReason: 'COMPLETED' },
      context,
    );
    await firstStarted;
    expect(seen).toEqual(['RUNNING']);
    releaseFirst();
    await expect(firstResult).resolves.toMatchObject({ message: 'subscriber failed' });
    await second;
    expect(seen).toEqual(['RUNNING', 'CLOSED']);
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
    expect(() => inbox.start(() => Promise.resolve(0))).toThrow('Inbox already started');
  });

  it('drains after an error observer throws and reports that observer failure at idle', async () => {
    const handled: number[] = [];
    const inbox = new Inbox<number>({
      channels: ['default'],
      onError: () => {
        throw new Error('observer failed');
      },
    });
    inbox.enqueue(1);
    inbox.enqueue(2);
    inbox.start((message) => {
      if (message === 1) return Promise.reject(new Error('handler failed'));
      handled.push(message);
      return Promise.resolve();
    });
    await expect(inbox.idle()).rejects.toThrow('observer failed');
    expect(handled).toEqual([2]);
  });

  it('rejects a duplicate request promptly and does not consume a key on invalid channel', async () => {
    const inbox = new Inbox<{ id: string }, string, 'control' | 'work'>({
      channels: ['control', 'work'],
      dedupeKey: (message) => message.id,
    });
    expect(() => inbox.enqueue({ id: 'first' }, 'missing' as 'work')).toThrow(
      'Unknown inbox channel',
    );
    const first = inbox.request({ id: 'first' }, 'work');
    await expect(inbox.request({ id: 'first' }, 'work')).rejects.toThrow('Duplicate inbox request');
    let idle = false;
    const waiting = inbox.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    inbox.start((message) => Promise.resolve(message.id));
    expect(await first).toBe('first');
    await waiting;
    expect(idle).toBe(true);
  });

  it('defers an actor outbox until handling ends while control messages take priority', async () => {
    const inbox = new Inbox<string, void, 'control' | 'work'>({
      channels: ['control', 'work'],
    });
    const trace: string[] = [];
    const sender = new OrderedSender<string>(
      (item) => {
        trace.push(`sent:${item}`);
        return Promise.resolve();
      },
      () => undefined,
    );
    inbox.enqueue('work-1', 'work');
    inbox.enqueue('work-2', 'work');
    inbox.enqueue('cancel', 'control');
    inbox.start(async (message) => {
      trace.push(`begin:${message}`);
      const pending = [message];
      await Promise.resolve();
      trace.push(`end:${message}`);
      for (const item of pending) sender.enqueue(item);
    });
    await inbox.idle();
    await sender.flushed();
    expect(trace).toEqual([
      'begin:cancel',
      'end:cancel',
      'sent:cancel',
      'begin:work-1',
      'end:work-1',
      'sent:work-1',
      'begin:work-2',
      'end:work-2',
      'sent:work-2',
    ]);
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

  it('can send an undefined item without losing the rest of its queue', async () => {
    const sent: (number | undefined)[] = [];
    const sender = new OrderedSender<number | undefined>(
      (item) => {
        sent.push(item);
        return Promise.resolve();
      },
      () => undefined,
    );
    sender.enqueue(undefined);
    sender.enqueue(2);
    await sender.flushed();
    expect(sent).toEqual([undefined, 2]);
  });

  it('continues sending after failure reporting itself fails and exposes that failure', async () => {
    const sent: number[] = [];
    const sender = new OrderedSender<number>(
      (item) => {
        if (item === 1) return Promise.reject(new Error('delivery failed'));
        sent.push(item);
        return Promise.resolve();
      },
      () => {
        throw new Error('audit failed');
      },
    );
    sender.enqueue(1);
    sender.enqueue(2);
    await expect(sender.flushed()).rejects.toThrow('audit failed');
    expect(sent).toEqual([2]);
  });
});
