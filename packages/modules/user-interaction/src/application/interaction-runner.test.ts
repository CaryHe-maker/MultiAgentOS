import { newId, validate, InteractionInboxEventSchema } from '@multiagentos/contracts';
import type {
  ArtifactRef,
  InteractionGatewayPort,
  InteractionInboxEvent,
  RunFinished,
  SystemFault,
} from '@multiagentos/contracts';
import { FabricError } from '@multiagentos/fabric';
import { describe, expect, it, vi } from 'vitest';
import { createUserInteraction } from '../index.js';
import type { TerminalPort } from '../index.js';

const now = () => new Date('2026-10-14T00:00:00.000Z');
/** What the module's Fabric client rejects with once the port deadline passes. */
const timedOut = (detail: string) => new FabricError('REQUEST_TIMEOUT', detail);

/** A Gateway response that stays pending until `expire` gives the deadline's rejection. */
function heldUntilDeadline(operation: string) {
  let expire: () => void = () => {};
  const held = () =>
    new Promise<never>((_resolve, reject) => {
      expire = () => reject(timedOut(operation));
    });
  return { held, expire: () => expire() };
}
const command = { goal: '分析仓库', repositoryPath: '/repo', details: false };
const ref: ArtifactRef = {
  artifactId: 'art_' + 'a'.repeat(64),
  mediaType: 'application/vnd.multiagentos.run-summary+json',
  sha256: 'a'.repeat(64),
  size: 1,
};

function setup(hasReporter = true) {
  const workflowRunId = newId('wfr');
  const output: string[] = [];
  let interrupt: () => void = () => {};
  let questionSignal: AbortSignal | undefined;
  const terminal = {
    write: vi.fn((text: string) => {
      output.push(text);
    }),
    askYesNo: vi.fn((_text: string, signal: AbortSignal) => {
      questionSignal = signal;
      return new Promise<'YES' | 'NO' | undefined>((resolve) => {
        signal.addEventListener('abort', () => resolve(undefined), { once: true });
      });
    }),
    onInterrupt: vi.fn((handler: () => void) => {
      interrupt = handler;
      return vi.fn();
    }),
  } satisfies TerminalPort;
  const ack = (request: { requestId: string }) =>
    Promise.resolve({ requestId: request.requestId, outcome: 'ACCEPTED' as const });
  const gateway = {
    createRun: vi.fn<InteractionGatewayPort['createRun']>((request) =>
      Promise.resolve({ requestId: request.requestId, outcome: 'ACCEPTED', workflowRunId }),
    ),
    cancelRun: vi.fn(ack),
    answerAuthorization: vi.fn(ack),
    shutdown: vi.fn(ack),
    readArtifact: vi.fn<InteractionGatewayPort['readArtifact']>((request) =>
      Promise.resolve({
        requestId: request.requestId,
        outcome: 'REJECTED',
        issuer: 'CORE',
        reasonCode: 'INVALID_ARTIFACT_REF',
      }),
    ),
  } satisfies InteractionGatewayPort;
  const reportSystemFault = vi.fn<(fault: SystemFault) => void>();
  const module = createUserInteraction({
    gateway,
    terminal,
    now,
    ...(hasReporter ? { reportSystemFault } : {}),
  });
  let seq = 0;
  const deliver = (event: InteractionInboxEvent['event']) => {
    const envelope = {
      eventId: newId('evt'),
      workflowRunId,
      seq: ++seq,
      occurredAt: now().toISOString(),
      event,
    };
    expect(validate(InteractionInboxEventSchema, envelope).ok).toBe(true);
    return module.inbox.deliver(envelope);
  };
  async function begin(details = false) {
    await module.start();
    const result = module.analyze({ ...command, details });
    void result.catch(() => undefined);
    await vi.waitFor(() => expect(gateway.createRun).toHaveBeenCalledTimes(1));
    // The call being made is earlier than the wrapped acknowledgement reaching analyze.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { result };
  }
  return {
    module,
    gateway,
    terminal,
    output,
    reportSystemFault,
    deliver,
    begin,
    workflowRunId,
    interrupt: () => interrupt(),
    signal: () => questionSignal,
  };
}

const stopped = (closeReason: 'CANCELLED' | 'RUN_TIMEOUT' = 'CANCELLED'): RunFinished => ({
  type: 'RunFinished',
  closeReason,
  unknownEffects: [],
  finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
});

describe('UserInteraction session and fault boundaries', () => {
  it.each([
    ['cancelRun', 'ACK'],
    ['cancelRun', 'REJECTION'],
    ['answerAuthorization', 'ACK'],
    ['answerAuthorization', 'REJECTION'],
  ] as const)('ends the local %s wait on fault stop before late %s', async (operation, late) => {
    vi.useFakeTimers();
    try {
      const test = setup();
      let finishLate: () => void = () => {};
      test.gateway[operation].mockImplementation(
        (request) =>
          new Promise((resolve, reject) => {
            finishLate = () =>
              late === 'ACK'
                ? resolve({ requestId: request.requestId, outcome: 'ACCEPTED' })
                : reject(new Error('Late control rejection'));
          }),
      );
      test.terminal.askYesNo.mockResolvedValue('YES');
      await test.module.start();
      const result = test.module.analyze(command);
      const observed = expect(result).rejects.toThrow('Independent terminal failure');
      await vi.advanceTimersByTimeAsync(0);
      if (operation === 'cancelRun') test.interrupt();
      else
        await test.deliver({
          type: 'AuthorizationRequest',
          questionId: newId('qst'),
          capability: 'repo.read',
          repositoryPath: '/repo',
          exclusions: [],
          provider: '服务商',
          expiresAt: '2026-10-14T00:01:00.000Z',
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(test.gateway[operation]).toHaveBeenCalledTimes(1);
      test.terminal.write.mockImplementation(() => {
        throw new Error('Independent terminal failure');
      });
      await test.deliver({
        type: 'AuthorizationResolved',
        questionId: newId('qst'),
        resolution: 'CANCELLED',
      });
      await observed;
      await test.module.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(test.reportSystemFault).toHaveBeenCalledTimes(1);
      finishLate();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(test.reportSystemFault).toHaveBeenCalledTimes(1);
      expect(test.gateway.shutdown).not.toHaveBeenCalled();
      expect(test.gateway[operation]).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a finished result when external shutdown ends a pending control wait', async () => {
    vi.useFakeTimers();
    try {
      const test = setup();
      test.gateway.cancelRun.mockImplementation(() => new Promise<never>(() => {}));
      await test.module.start();
      const result = test.module.analyze(command);
      await vi.advanceTimersByTimeAsync(0);
      test.interrupt();
      await test.deliver(stopped());
      await vi.advanceTimersByTimeAsync(0);
      await test.module.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(await result).toBe(130);
      expect(test.gateway.shutdown).not.toHaveBeenCalled();
      expect(test.reportSystemFault).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['cancelRun', 'answerAuthorization'] as const)(
    'observes a pending %s before completing a finished command',
    async (operation) => {
      vi.useFakeTimers();
      try {
        const test = setup();
        const deadline = heldUntilDeadline(operation);
        test.gateway[operation].mockImplementation(deadline.held);
        test.terminal.askYesNo.mockResolvedValue('YES');
        await test.module.start();
        let hasReturned = false;
        const result = test.module.analyze(command).then((code) => {
          hasReturned = true;
          return code;
        });
        void result.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        if (operation === 'cancelRun') test.interrupt();
        else
          await test.deliver({
            type: 'AuthorizationRequest',
            questionId: newId('qst'),
            capability: 'repo.read',
            repositoryPath: '/repo',
            exclusions: [],
            provider: '服务商',
            expiresAt: '2026-10-14T00:01:00.000Z',
          });
        await vi.advanceTimersByTimeAsync(0);
        expect(test.gateway[operation]).toHaveBeenCalledTimes(1);
        await test.deliver(stopped());
        await vi.advanceTimersByTimeAsync(0);
        expect(hasReturned).toBe(false);
        expect(test.gateway.shutdown).not.toHaveBeenCalled();
        deadline.expire();
        await vi.advanceTimersByTimeAsync(0);
        expect(await result).toBe(130);
        expect(test.reportSystemFault).toHaveBeenCalledTimes(1);
        expect(test.gateway.shutdown).not.toHaveBeenCalled();
        await test.module.stop();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('continues normal shutdown after an outstanding cancel acknowledgement arrives', async () => {
    vi.useFakeTimers();
    try {
      const test = setup();
      let acknowledge: () => void = () => {};
      test.gateway.cancelRun.mockImplementation(
        (request) =>
          new Promise((resolve) => {
            acknowledge = () => resolve({ requestId: request.requestId, outcome: 'ACCEPTED' });
          }),
      );
      await test.module.start();
      const result = test.module.analyze(command);
      await vi.advanceTimersByTimeAsync(0);
      test.interrupt();
      await test.deliver(stopped());
      await vi.advanceTimersByTimeAsync(0);
      expect(test.gateway.shutdown).not.toHaveBeenCalled();
      acknowledge();
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toBe(130);
      expect(test.gateway.shutdown).toHaveBeenCalledTimes(1);
      expect(test.reportSystemFault).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await test.module.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a post-finish control timeout observable without a fault reporter', async () => {
    vi.useFakeTimers();
    try {
      const test = setup(false);
      const deadline = heldUntilDeadline('cancelRun');
      test.gateway.cancelRun.mockImplementation(deadline.held);
      await test.module.start();
      const result = test.module.analyze(command);
      void result.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      test.interrupt();
      await test.deliver(stopped());
      deadline.expire();
      await vi.advanceTimersByTimeAsync(0);
      await expect(result).rejects.toThrow('REQUEST_TIMEOUT');
      await expect(test.module.stop()).rejects.toThrow('REQUEST_TIMEOUT');
      expect(test.gateway.shutdown).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects extra fields and unsupported events before starting a session', async () => {
    const test = setup();
    const envelope = {
      eventId: newId('evt'),
      workflowRunId: test.workflowRunId,
      seq: 1,
      occurredAt: now().toISOString(),
      event: { type: 'AuthorizationResolved', questionId: newId('qst'), resolution: 'TIMED_OUT' },
    };
    for (const invalid of [
      { ...envelope, extra: true },
      { ...envelope, event: { type: 'ReviewRequested' } },
    ])
      await expect(
        test.module.inbox.deliver(invalid as unknown as InteractionInboxEvent),
      ).rejects.toThrow('Inbox event violates its contract');
    await test.module.stop();
    expect(test.gateway.createRun).not.toHaveBeenCalled();
    expect(test.gateway.answerAuthorization).not.toHaveBeenCalled();
    expect(test.reportSystemFault).not.toHaveBeenCalled();
    expect(test.output).toEqual([]);
  });

  it('copies an accepted event before the caller can change its resolution', async () => {
    const test = setup();
    const { result } = await test.begin();
    const envelope: InteractionInboxEvent = {
      eventId: newId('evt'),
      workflowRunId: test.workflowRunId,
      seq: 1,
      occurredAt: now().toISOString(),
      event: { type: 'AuthorizationResolved', questionId: newId('qst'), resolution: 'TIMED_OUT' },
    };
    const accepted = test.module.inbox.deliver(envelope);
    if (envelope.event.type !== 'AuthorizationResolved') throw new Error('Expected a resolution');
    envelope.event.resolution = 'GRANTED';
    await accepted;
    await test.deliver(stopped());
    expect(await result).toBe(130);
    expect(test.output.join('')).toContain('授权询问已超时');
    expect(test.reportSystemFault).not.toHaveBeenCalled();
    await test.module.stop();
  });

  it.each(['createRun', 'cancelRun', 'answerAuthorization', 'readArtifact', 'shutdown'] as const)(
    'reports a %s that reaches the port deadline at its capture boundary',
    async (operation) => {
      vi.useFakeTimers();
      try {
        const test = setup();
        const deadline = heldUntilDeadline(operation);
        test.gateway[operation].mockImplementation(deadline.held);
        test.terminal.askYesNo.mockResolvedValue('YES');
        await test.module.start();
        const result = test.module.analyze(command);
        void result.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        if (operation === 'cancelRun') test.interrupt();
        if (operation === 'answerAuthorization')
          await test.deliver({
            type: 'AuthorizationRequest',
            questionId: newId('qst'),
            capability: 'repo.read',
            repositoryPath: '/repo',
            exclusions: [],
            provider: '服务商',
            expiresAt: '2026-10-14T00:01:00.000Z',
          });
        if (operation === 'readArtifact')
          await test.deliver({
            type: 'RunFinished',
            closeReason: 'COMPLETED',
            unknownEffects: [],
            reportRef: { ...ref, mediaType: 'application/vnd.multiagentos.analysis-report+json' },
            runSummaryRef: ref,
          });
        if (operation === 'shutdown') await test.deliver(stopped());
        await vi.advanceTimersByTimeAsync(0);
        expect(test.gateway[operation]).toHaveBeenCalledTimes(1);
        deadline.expire();
        await vi.advanceTimersByTimeAsync(0);
        if (operation === 'shutdown') expect(await result).toBe(130);
        else await expect(result).rejects.toThrow('REQUEST_TIMEOUT');
        expect(test.reportSystemFault).toHaveBeenCalledTimes(operation === 'createRun' ? 0 : 1);
        await test.module.stop();
        expect(test.reportSystemFault).toHaveBeenCalledTimes(operation === 'createRun' ? 0 : 1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('acquires no resources in the factory and stop is repeatable', async () => {
    const { module, terminal } = setup();
    expect(terminal.onInterrupt).not.toHaveBeenCalled();
    const stopping = module.stop();
    expect(module.stop()).toBe(stopping);
    await stopping;
    await expect(module.start()).rejects.toThrow('after stop');
  });

  it('reports terminal cleanup failure while preserving the recorded nonzero code', async () => {
    const test = setup();
    const release = vi.fn(() => {
      throw new Error('Terminal release failed');
    });
    test.terminal.onInterrupt.mockReturnValue(release);
    const { result } = await test.begin();
    await test.deliver(stopped());
    expect(await result).toBe(130);
    expect(test.reportSystemFault).toHaveBeenCalledTimes(1);
    expect(test.reportSystemFault.mock.calls[0]?.[0].source).toBe('user-interaction');
    expect(test.reportSystemFault.mock.calls[0]?.[0].error).toBeInstanceOf(Error);
    await test.module.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('still drains its Inbox when removing the terminal listener fails during stop', async () => {
    const test = setup();
    const release = vi.fn(() => {
      throw new Error('Terminal release failed');
    });
    test.terminal.onInterrupt.mockReturnValue(release);
    const { result } = await test.begin();
    await test.deliver(stopped());
    const stopping = test.module.stop();
    const observed = expect(stopping).rejects.toThrow('Terminal release failed');
    expect(test.module.stop()).toBe(stopping);
    await observed;
    expect(await result).toBe(130);
    expect(test.output.join('')).toContain('运行已取消');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('preserves the command failure when terminal cleanup also fails', async () => {
    const test = setup(false);
    const commandError = new Error('Create transport failed');
    const cleanupError = new Error('Terminal release failed');
    test.gateway.createRun.mockRejectedValue(commandError);
    const release = vi.fn(() => {
      throw cleanupError;
    });
    test.terminal.onInterrupt.mockReturnValue(release);
    await test.module.start();
    const failure: unknown = await test.module.analyze(command).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ errors: [commandError, cleanupError] });
    await expect(test.module.stop()).rejects.toThrow('Terminal release failed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['CANCELLED', 130],
    ['RUN_TIMEOUT', 2],
  ] as const)('shows %s without replacing a nonzero exit code', async (reason, code) => {
    const test = setup();
    const { result } = await test.begin();
    await test.deliver(stopped(reason));
    expect(await result).toBe(code);
    expect(test.gateway.shutdown).toHaveBeenCalledTimes(1);
    expect(test.output.join('')).toContain('运行摘要保存失败');
    await test.module.stop();
  });

  it('shows a failed run without exposing failure.detail', async () => {
    const test = setup();
    const { result } = await test.begin();
    await test.deliver({
      ...stopped(),
      closeReason: 'FAILED',
      failure: {
        code: 'PROVIDER_AUTH',
        category: 'DEPENDENCY',
        source: 'WORKFLOW',
        detail: 'secret',
      },
    });
    expect(await result).toBe(1);
    expect(test.output.join('')).toContain('模型服务认证失败');
    expect(test.output.join('')).not.toContain('secret');
    await test.module.stop();
  });

  it('handles create rejection as user input failure rather than a system fault', async () => {
    const test = setup();
    vi.mocked(test.gateway.createRun).mockImplementation((request) =>
      Promise.resolve({
        requestId: request.requestId,
        outcome: 'REJECTED',
        issuer: 'CORE',
        reasonCode: 'REPOSITORY_INVALID',
      }),
    );
    const { result } = await test.begin();
    expect(await result).toBe(4);
    expect(test.reportSystemFault).not.toHaveBeenCalled();
    expect(test.output.join('')).toContain('仓库路径');
    await test.module.stop();
  });

  it('escalates cancel rejection once and never retries or invents completion', async () => {
    const test = setup();
    vi.mocked(test.gateway.cancelRun).mockImplementation((request) =>
      Promise.resolve({
        requestId: request.requestId,
        outcome: 'REJECTED',
        issuer: 'CORE',
        reasonCode: 'RUN_NOT_FOUND',
      }),
    );
    const { result } = await test.begin();
    test.interrupt();
    test.interrupt();
    await expect(result).rejects.toThrow('cancelRun rejected');
    expect(test.gateway.cancelRun).toHaveBeenCalledTimes(1);
    expect(test.reportSystemFault).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'user-interaction',
        phase: 'RUN',
        workflowRunId: test.workflowRunId,
      }),
    );
    expect(test.gateway.shutdown).not.toHaveBeenCalled();
    await test.module.stop();
  });

  it('reports shutdown rejection while preserving the recorded nonzero code', async () => {
    const test = setup();
    vi.mocked(test.gateway.shutdown).mockImplementation((request) =>
      Promise.resolve({
        requestId: request.requestId,
        outcome: 'REJECTED',
        issuer: 'GATEWAY',
        reasonCode: 'CALLER_FORBIDDEN',
      }),
    );
    const { result } = await test.begin();
    await test.deliver(stopped());
    expect(await result).toBe(130);
    expect(test.gateway.shutdown).toHaveBeenCalledTimes(1);
    expect(test.reportSystemFault).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'user-interaction',
      }),
    );
    expect(test.reportSystemFault.mock.calls[0]?.[0].error).toBeInstanceOf(Error);
    await test.module.stop();
  });

  it('never blocks RunFinished behind an unanswered question', async () => {
    const test = setup();
    const { result } = await test.begin();
    await test.deliver({
      type: 'AuthorizationRequest',
      questionId: newId('qst'),
      capability: 'repo.read',
      repositoryPath: '/repo',
      exclusions: ['.git/**'],
      provider: '服务商',
      expiresAt: '2026-10-14T00:01:00.000Z',
    });
    await vi.waitFor(() => expect(test.terminal.askYesNo).toHaveBeenCalledTimes(1));
    await test.deliver(stopped());
    expect(await result).toBe(130);
    expect(test.signal()?.aborted).toBe(true);
    expect(test.gateway.answerAuthorization).not.toHaveBeenCalled();
    await test.module.stop();
  });

  it('ignores a QUESTION_NOT_PENDING authorization response', async () => {
    const test = setup();
    vi.mocked(test.terminal.askYesNo).mockResolvedValue('YES');
    vi.mocked(test.gateway.answerAuthorization).mockImplementation((request) =>
      Promise.resolve({
        requestId: request.requestId,
        outcome: 'REJECTED',
        issuer: 'CORE',
        reasonCode: 'QUESTION_NOT_PENDING',
      }),
    );
    const { result } = await test.begin();
    await test.deliver({
      type: 'AuthorizationRequest',
      questionId: newId('qst'),
      capability: 'repo.read',
      repositoryPath: '/repo',
      exclusions: [],
      provider: '服务商',
      expiresAt: '2026-10-14T00:01:00.000Z',
    });
    await vi.waitFor(() => expect(test.gateway.answerAuthorization).toHaveBeenCalledTimes(1));
    await test.deliver(stopped());
    await result;
    expect(test.reportSystemFault).not.toHaveBeenCalled();
    await test.module.stop();
  });

  it('reports a detached question failure to the injected root callback', async () => {
    const test = setup();
    vi.mocked(test.terminal.askYesNo).mockRejectedValue(new Error('Terminal read failed'));
    const { result } = await test.begin();
    await test.deliver({
      type: 'AuthorizationRequest',
      questionId: newId('qst'),
      capability: 'repo.read',
      repositoryPath: '/repo',
      exclusions: [],
      provider: '服务商',
      expiresAt: '2026-10-14T00:01:00.000Z',
    });
    await expect(result).rejects.toThrow('Terminal read failed');
    expect(test.reportSystemFault).toHaveBeenCalledTimes(1);
    await test.module.stop();
  });

  it('observes Inbox exceptions and rejects stop without a reporter', async () => {
    const test = setup(false);
    vi.mocked(test.terminal.write).mockImplementation(() => {
      throw new Error('Terminal write failed');
    });
    const { result } = await test.begin();
    await test.deliver(stopped());
    await expect(test.module.stop()).rejects.toThrow('Terminal write failed');
    void result;
  });

  it('floors a completed run to failure when report reading is rejected', async () => {
    const test = setup();
    const { result } = await test.begin();
    await test.deliver({
      type: 'RunFinished',
      closeReason: 'COMPLETED',
      unknownEffects: [],
      reportRef: { ...ref, mediaType: 'application/vnd.multiagentos.analysis-report+json' },
      runSummaryRef: ref,
    });
    expect(await result).toBe(1);
    expect(test.output.join('')).toContain('报告无法读取');
    expect(test.reportSystemFault).not.toHaveBeenCalled();
    await test.module.stop();
  });

  it('displays a valid completed report and returns zero', async () => {
    const test = setup();
    vi.mocked(test.gateway.readArtifact).mockImplementation((request) =>
      Promise.resolve({
        requestId: request.requestId,
        outcome: 'ACCEPTED',
        ref: request.ref,
        text: JSON.stringify({
          workflowRunId: test.workflowRunId,
          goal: command.goal,
          summary: '已完成分析。',
          degraded: false,
          conclusions: [],
          unconfirmed: [],
          readSources: [],
          agentRounds: [],
          createdAt: now().toISOString(),
        }),
      }),
    );
    const { result } = await test.begin();
    await test.deliver({
      type: 'RunFinished',
      closeReason: 'COMPLETED',
      unknownEffects: [],
      reportRef: { ...ref, mediaType: 'application/vnd.multiagentos.analysis-report+json' },
      runSummaryRef: ref,
    });
    expect(await result).toBe(0);
    expect(test.output.join('')).toContain('分析报告\n\n回答\n  已完成分析。');
    expect(test.gateway.readArtifact).toHaveBeenCalledTimes(1);
    await test.module.stop();
  });

  it('preserves violation exit code and reports unknown effects', async () => {
    const test = setup();
    const { result } = await test.begin(true);
    await test.deliver({
      ...stopped(),
      closeReason: 'VIOLATION',
      failure: {
        code: 'PATH_ESCAPE',
        category: 'INTEGRITY',
        source: 'KERNEL',
      },
      unknownEffects: [
        {
          effect: 'MODEL_REQUEST_UNCONFIRMED',
          executionKind: 'MODEL',
          unitAttemptId: newId('una'),
          executionId: newId('exe'),
        },
      ],
    });
    expect(await result).toBe(3);
    expect(test.output.join('')).toContain('部分操作无法确认是否完成');
    expect(test.gateway.readArtifact).not.toHaveBeenCalled();
    await test.module.stop();
  });

  it('reports an Inbox exception through the root callback', async () => {
    const test = setup();
    vi.mocked(test.terminal.write).mockImplementation(() => {
      throw new Error('Terminal write failed');
    });
    const { result } = await test.begin();
    await test.deliver(stopped());
    await expect(result).rejects.toThrow('Terminal write failed');
    expect(test.reportSystemFault).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'user-interaction',
        workflowRunId: test.workflowRunId,
      }),
    );
    await test.module.stop();
  });

  it('keeps detached cancellation failures observable without a reporter', async () => {
    const test = setup(false);
    vi.mocked(test.gateway.cancelRun).mockRejectedValue(new Error('Cancel transport failed'));
    const { result } = await test.begin();
    test.interrupt();
    await expect(result).rejects.toThrow('Cancel transport failed');
    await expect(test.module.stop()).rejects.toThrow('Cancel transport failed');
  });

  it('keeps an undefined detached rejection observable during stop', async () => {
    const test = setup(false);
    test.gateway.cancelRun.mockRejectedValue(undefined);
    const { result } = await test.begin();
    test.interrupt();
    await expect(result).rejects.toBeUndefined();
    await expect(test.module.stop()).rejects.toMatchObject({ cause: undefined });
  });

  it('expires an unanswered question without sending authorization', async () => {
    vi.useFakeTimers();
    try {
      const test = setup();
      await test.module.start();
      const result = test.module.analyze(command);
      await test.deliver({
        type: 'AuthorizationRequest',
        questionId: newId('qst'),
        capability: 'repo.read',
        repositoryPath: '/repo',
        exclusions: [],
        provider: '服务商',
        expiresAt: '2026-10-14T00:00:01.000Z',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(test.signal()?.aborted).toBe(true);
      expect(test.gateway.answerAuthorization).not.toHaveBeenCalled();
      expect(test.output.join('')).toContain('授权询问已超时');
      await test.deliver(stopped());
      await vi.advanceTimersByTimeAsync(0);
      await result;
      await test.module.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1_000, -1_000])(
    'shows one timeout notice when local expiry precedes Core resolution: %s',
    async (delayMs) => {
      vi.useFakeTimers();
      try {
        const test = setup();
        const questionId = newId('qst');
        await test.module.start();
        const result = test.module.analyze(command);
        await test.deliver({
          type: 'AuthorizationRequest',
          questionId,
          capability: 'repo.read',
          repositoryPath: '/repo',
          exclusions: [],
          provider: '服务商',
          expiresAt: new Date(now().getTime() + delayMs).toISOString(),
        });
        await vi.advanceTimersByTimeAsync(Math.max(0, delayMs));
        expect(test.output.join('').split('授权询问已超时')).toHaveLength(2);
        await test.deliver({ type: 'AuthorizationResolved', questionId, resolution: 'TIMED_OUT' });
        await vi.advanceTimersByTimeAsync(0);
        expect(test.output.join('').split('授权询问已超时')).toHaveLength(2);
        expect(test.gateway.answerAuthorization).not.toHaveBeenCalled();
        await test.deliver(stopped());
        await vi.advanceTimersByTimeAsync(0);
        expect(await result).toBe(130);
        await test.module.stop();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not expire a long authorization deadline after timer overflow', async () => {
    vi.useFakeTimers();
    try {
      const test = setup();
      await test.module.start();
      const result = test.module.analyze(command);
      const delayMs = 2_147_483_647 + 1_000;
      await test.deliver({
        type: 'AuthorizationRequest',
        questionId: newId('qst'),
        capability: 'repo.read',
        repositoryPath: '/repo',
        exclusions: [],
        provider: '服务商',
        expiresAt: new Date(now().getTime() + delayMs).toISOString(),
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(test.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(delayMs - 2);
      expect(test.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(test.signal()?.aborted).toBe(true);
      expect(test.gateway.answerAuthorization).not.toHaveBeenCalled();
      await test.deliver(stopped());
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toBe(130);
      await test.module.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['GRANTED', 'DECLINED', 'TIMED_OUT', 'CANCELLED'] as const)(
    'ends the pending question on AuthorizationResolved %s',
    async (resolution) => {
      const test = setup();
      const { result } = await test.begin();
      const questionId = newId('qst');
      await test.deliver({
        type: 'AuthorizationRequest',
        questionId,
        capability: 'repo.read',
        repositoryPath: '/repo',
        exclusions: [],
        provider: '服务商',
        expiresAt: '2026-10-14T00:01:00.000Z',
      });
      await vi.waitFor(() => expect(test.terminal.askYesNo).toHaveBeenCalledTimes(1));
      await test.deliver({ type: 'AuthorizationResolved', questionId, resolution });
      await test.deliver(stopped());
      await result;
      expect(test.signal()?.aborted).toBe(true);
      expect(test.gateway.answerAuthorization).not.toHaveBeenCalled();
      await test.module.stop();
    },
  );

  it.each(['{', '{}'])(
    'treats malformed or invalid artifact content %s as a display failure',
    async (text) => {
      const test = setup();
      test.gateway.readArtifact.mockImplementation((request) =>
        Promise.resolve({
          requestId: request.requestId,
          outcome: 'ACCEPTED',
          ref: request.ref,
          text,
        }),
      );
      const { result } = await test.begin(true);
      await test.deliver({
        type: 'RunFinished',
        closeReason: 'COMPLETED',
        unknownEffects: [],
        reportRef: { ...ref, mediaType: 'application/vnd.multiagentos.analysis-report+json' },
        runSummaryRef: ref,
      });
      expect(await result).toBe(1);
      expect(test.output.join('')).toContain('报告无法读取');
      expect(test.output.join('')).toContain('运行摘要无法读取');
      expect(test.reportSystemFault).not.toHaveBeenCalled();
      await test.module.stop();
    },
  );

  it('shows summary rejection and preserves cancellation', async () => {
    const test = setup();
    const { result } = await test.begin(true);
    await test.deliver({
      type: 'RunFinished',
      closeReason: 'CANCELLED',
      unknownEffects: [],
      runSummaryRef: ref,
    });
    expect(await result).toBe(130);
    expect(test.output.join('')).toContain('运行摘要无法读取');
    expect(test.gateway.shutdown).toHaveBeenCalledTimes(1);
    await test.module.stop();
  });
});
