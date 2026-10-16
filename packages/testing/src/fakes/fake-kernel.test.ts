import { createM1ProtocolRegistry, newId } from '@multiagentos/contracts';
import type {
  ExecutionFact,
  ExecutionRequest,
  Executor,
  ExecutorOutcome,
} from '@multiagentos/contracts';
import { InProcessFabric, createSupervisorPort, serveExecutionFacts } from '@multiagentos/fabric';
import { DEFAULT_KERNEL_CONFIG } from '@multiagentos/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeExecutorRegistry } from './fake-executors.js';
import { createFakeSupervisor } from './fake-kernel.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const failed = (): ExecutorOutcome => ({
  outcome: 'FAILED',
  reasonCode: 'INTERNAL',
  retryable: false,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(
  execute: Executor<'FILE_READ'>['execute'] = () => Promise.resolve(failed()),
) {
  const fabric = new InProcessFabric(createM1ProtocolRegistry());
  await fabric.start();
  const report = vi.fn<(fact: ExecutionFact) => Promise<void>>(() => Promise.resolve());
  serveExecutionFacts(fabric.client('kernel-core'), { report });
  const client = fabric.client('supervisor');
  const send = vi.spyOn(client, 'send');
  const stopHost = vi.fn(() => fabric.stop());
  const supervisor = createFakeSupervisor()({
    fabric: client,
    moduleHost: { start: () => Promise.resolve(), stop: stopHost },
    executors: createFakeExecutorRegistry(undefined, {
      FILE_READ: { executionKind: 'FILE_READ', execute },
    }),
    credentials: { apiKeyFor: () => undefined },
    config: DEFAULT_KERNEL_CONFIG,
    dataDir: '/unused-supervisor-test',
  });
  cleanups.push(async () => {
    await supervisor.stop().catch(() => undefined);
    await fabric.stop();
  });
  await supervisor.start();
  const port = createSupervisorPort(fabric.client('kernel-core'), (workflowRunId) => ({
    correlationId: newId('cor'),
    tenantId: 'local',
    projectId: 'supervisor-test',
    ...(workflowRunId === undefined ? {} : { workflowRunId }),
  }));
  const request: ExecutionRequest = {
    workflowRunId: newId('wfr'),
    unitAttemptId: newId('una'),
    executionId: newId('exe'),
    runEpoch: 1,
    executionKind: 'FILE_READ',
    input: { path: 'Readme.md' },
    scope: { kind: 'REPOSITORY', repositoryRoot: '/repository', exclusions: [] },
    limits: { deadline: '2099-01-01T00:00:00.000Z', maxOutputBytes: 1000 },
  };
  return { supervisor, report, send, stopHost, port, request };
}

describe('FakeSupervisor execution shutdown', () => {
  it.each(['RESOLVE', 'REJECT'] as const)(
    'does not send a late fact after stopping an active execution: %s',
    async (ending) => {
      let finish: () => void = () => {};
      let enter: () => void = () => {};
      let signal: AbortSignal | undefined;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<ExecutorOutcome>((resolve, reject) => {
        finish = () =>
          ending === 'RESOLVE' ? resolve(failed()) : reject(new Error('Late Executor failure'));
      });
      const test = await fixture((_input, environment) => {
        signal = environment.signal;
        enter();
        return held;
      });
      await test.port.execute(test.request);
      await entered;
      await test.supervisor.stop();
      finish();
      await tick();
      await tick();
      expect(test.send).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(true);
      expect(test.report).not.toHaveBeenCalled();
      expect(test.supervisor.stop()).toBe(test.supervisor.stop());
    },
  );

  it('does not start an accepted queued execution after stop', async () => {
    const execute = vi.fn<Executor<'FILE_READ'>['execute']>(() => new Promise(() => {}));
    const test = await fixture(execute);
    await test.port.execute(test.request);
    await test.supervisor.stop();
    await tick();
    expect(execute).not.toHaveBeenCalled();
    expect(test.send).not.toHaveBeenCalled();
  });

  it('drains a fact already being delivered before stopping Fabric', async () => {
    const test = await fixture();
    let release: () => void = () => {};
    let enter: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    test.report.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          enter();
        }),
    );
    await test.port.execute(test.request);
    await entered;
    const stopping = test.supervisor.stop();
    await tick();
    expect(test.stopHost).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(test.stopHost).toHaveBeenCalledTimes(1);
    expect(test.report).toHaveBeenCalledTimes(1);
  });

  it('exposes a running fact delivery failure and still stops the modules', async () => {
    const test = await fixture();
    const failure = new Error('Fact delivery failed');
    test.report.mockRejectedValue(failure);
    const observed = expect(test.supervisor.whenStopped()).rejects.toMatchObject({
      errors: [failure],
    });
    await test.port.execute(test.request);
    await observed;
    await expect(test.supervisor.stop()).rejects.toMatchObject({ errors: [failure] });
    expect(test.stopHost).toHaveBeenCalledTimes(1);
  });

  it('keeps an Executor exception as a single INTERNAL fact while running', async () => {
    const test = await fixture(() => Promise.reject(new Error('Executor failed')));
    await test.port.execute(test.request);
    await tick();
    await tick();
    expect(test.report).toHaveBeenCalledTimes(1);
    expect(test.report.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
      retryable: false,
    });
    await test.supervisor.stop();
    await expect(test.supervisor.whenStopped()).resolves.toBeUndefined();
  });
});
