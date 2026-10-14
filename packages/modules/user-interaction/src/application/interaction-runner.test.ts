import { newId, validate, InteractionInboxEventSchema } from '@multiagentos/contracts';
import type {
  ArtifactRef,
  InteractionGatewayPort,
  InteractionInboxEvent,
  RunFinished,
  SystemFault,
} from '@multiagentos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createUserInteraction } from '../index.js';
import type { TerminalPort } from '../index.js';

const now = () => new Date('2026-10-14T00:00:00.000Z');
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
  it.each(['createRun', 'cancelRun', 'answerAuthorization', 'readArtifact', 'shutdown'] as const)(
    'bounds a held %s response and observes late rejection',
    async (operation) => {
      vi.useFakeTimers();
      try {
        const test = setup();
        let rejectLate: (error: Error) => void = () => {};
        test.gateway[operation].mockImplementation(
          () =>
            new Promise<never>((_resolve, reject) => {
              rejectLate = reject;
            }),
        );
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
        await vi.advanceTimersByTimeAsync(30_000);
        if (operation === 'shutdown') expect(await result).toBe(130);
        else await expect(result).rejects.toThrow('Interaction port return deadline exceeded');
        expect(test.reportSystemFault).toHaveBeenCalledTimes(operation === 'createRun' ? 0 : 1);
        await test.module.stop();
        rejectLate(new Error('Late gateway failure'));
        await vi.advanceTimersByTimeAsync(1);
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
    expect(test.output.join('')).toContain('分析报告\n已完成分析。');
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
