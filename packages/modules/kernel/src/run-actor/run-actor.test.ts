import type { BoundaryContext, ExecutionFact, GatewayForward } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import {
  RunActor,
  runChannelOf,
  type RunMessage,
  type RunProcessor,
  type RunResponse,
} from './index.js';

const context: BoundaryContext = {
  correlationId: 'cor_123456',
  tenantId: 'local',
  projectId: 'local',
  workflowRunId: 'wfr_123456',
};

const submit: GatewayForward = {
  caller: 'workflow',
  requestType: 'submitUnit',
  request: {
    requestId: 'req_123456',
    workflowRunId: 'wfr_123456',
    agentRunId: 'agr_123456',
    unitRef: {
      kind: 'UNIT',
      id: 'file-read',
      version: 'v0.1.0',
      digest: 'a'.repeat(64),
    },
    input: { path: 'README.md' },
  },
};

const cancel: GatewayForward = {
  caller: 'user-interaction',
  requestType: 'cancelRun',
  request: { requestId: 'req_654321', workflowRunId: 'wfr_123456' },
};

function ack(requestId: string): RunResponse {
  return { requestId, outcome: 'ACCEPTED' };
}

function fact(outcome: ExecutionFact['outcome']): ExecutionFact {
  return { outcome } as ExecutionFact;
}

function labelOf(message: RunMessage): string {
  if (message.kind === 'FORWARD') return message.forward.requestType;
  if (message.kind === 'EXECUTION_FACT') return message.fact.outcome;
  return message.kind;
}

class RecordingProcessor implements RunProcessor {
  public readonly seen: string[] = [];
  public readonly settled: string[] = [];

  public dispatch(message: RunMessage): Promise<RunResponse | void> {
    this.seen.push(labelOf(message));
    if (message.kind === 'FORWARD') return Promise.resolve(ack(message.forward.request.requestId));
    return Promise.resolve(undefined);
  }

  public settle(): Promise<void> {
    this.settled.push('settle');
    return Promise.resolve();
  }
}

describe('RunActor', () => {
  it('takes a queued control message before queued work', async () => {
    const processor = new RecordingProcessor();
    const actor = new RunActor({ processor });

    const work = actor.forward(submit, context);
    await actor.timer('RUN_TIMEOUT');
    actor.start();

    await expect(work).resolves.toEqual(ack('req_123456'));
    expect(processor.seen).toEqual(['RUN_TIMEOUT', 'submitUnit']);
    expect(processor.settled).toHaveLength(2);
  });

  it('does not let a control message interrupt a message being handled', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const processor: RunProcessor = {
      dispatch: async (message) => {
        const label = labelOf(message);
        order.push(`start:${label}`);
        if (label === 'submitUnit') await gate;
        order.push(`end:${label}`);
        if (message.kind === 'FORWARD') return ack(message.forward.request.requestId);
        return undefined;
      },
    };
    const actor = new RunActor({ processor });
    actor.start();

    const first = actor.forward(submit, context);
    const second = actor.forward(cancel, context);
    await Promise.resolve();
    expect(order).toEqual(['start:submitUnit']);

    release?.();
    await first;
    await second;
    expect(order).toEqual([
      'start:submitUnit',
      'end:submitUnit',
      'start:cancelRun',
      'end:cancelRun',
    ]);
  });

  it('routes execution facts to the channel required by their outcome', () => {
    expect(runChannelOf({ kind: 'EXECUTION_FACT', fact: fact('COMPLETED') })).toBe('work');
    expect(runChannelOf({ kind: 'EXECUTION_FACT', fact: fact('REJECTED') })).toBe('work');
    expect(runChannelOf({ kind: 'EXECUTION_FACT', fact: fact('FAILED') })).toBe('work');
    expect(runChannelOf({ kind: 'EXECUTION_FACT', fact: fact('TERMINATED') })).toBe('control');
    expect(runChannelOf({ kind: 'EXECUTION_FACT', fact: fact('VIOLATION') })).toBe('control');
    expect(runChannelOf({ kind: 'EXECUTION_FACT', fact: fact('STOP_UNCONFIRMED') })).toBe(
      'control',
    );
    expect(runChannelOf({ kind: 'FORWARD', forward: submit, context })).toBe('work');
    expect(runChannelOf({ kind: 'FORWARD', forward: cancel, context })).toBe('control');
    expect(runChannelOf({ kind: 'RUN_INIT' })).toBe('control');
    expect(runChannelOf({ kind: 'CANCEL_RUN' })).toBe('control');
    expect(runChannelOf({ kind: 'KERNEL_FAULT', faultId: 'flt_123456' })).toBe('control');
  });

  it('settles after every dispatch', async () => {
    const processor = new RecordingProcessor();
    const actor = new RunActor({ processor });
    actor.start();

    await actor.forward(submit, context);

    expect(processor.seen).toEqual(['submitUnit']);
    expect(processor.settled).toEqual(['settle']);
  });

  it('rejects a forwarded request when its processor throws', async () => {
    const actor = new RunActor({
      processor: {
        dispatch: () => Promise.reject(new Error('processor failed')),
      },
    });
    actor.start();

    await expect(actor.forward(submit, context)).rejects.toThrow('processor failed');
  });

  it('queues execution facts and aborts through the control channel', async () => {
    const processor = new RecordingProcessor();
    const actor = new RunActor({ processor });
    actor.start();

    await actor.reportFact(fact('COMPLETED'));
    await actor.drain();
    expect(processor.seen).toEqual(['COMPLETED']);

    await actor.abort('flt_123456');
    await actor.drain();
    expect(processor.seen).toEqual(['COMPLETED', 'KERNEL_FAULT']);
  });

  it('rejects a forwarded request when the processor returns no response', async () => {
    const actor = new RunActor({
      processor: { dispatch: () => Promise.resolve(undefined) },
    });
    actor.start();

    await expect(actor.forward(submit, context)).rejects.toThrow('without a response');
  });

  it('marks the run closed and stops accepting messages after stop', async () => {
    const processor = new RecordingProcessor();
    const actor = new RunActor({ processor });
    actor.start();

    const closed = actor.whenClosed();
    actor.markClosed();
    await expect(closed).resolves.toBeUndefined();

    await actor.timer('RUN_TIMEOUT');
    await actor.stop();
    expect(processor.seen).toEqual(['RUN_TIMEOUT']);
    expect(() => actor.timer('RUN_TIMEOUT')).toThrow('stopped');
    expect(() => actor.start()).toThrow('stopped');
    await actor.stop();
  });
});
