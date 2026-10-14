import {
  AnalysisReportSchema,
  InteractionInboxEventSchema,
  RunSummarySchema,
  newId,
  validate,
} from '@multiagentos/contracts';
import type {
  AnalysisReport,
  ArtifactRef,
  AuthorizationRequest,
  BoundaryContext,
  InteractionInboxEvent,
  RunFinished,
  RunSummary,
  SyscallAck,
  SyscallRejected,
} from '@multiagentos/contracts';
import { Inbox } from '@multiagentos/fabric';
import type { AnalyzeCommand, UserInteractionDeps, UserInteractionModule } from '../index.js';
import { EXIT_CODES, EXIT_CODE_RUN_REJECTED } from '../domain/exit-codes.js';
import { InteractionMessages as messages, describeReason } from '../domain/interaction-messages.js';
import { renderQuestion, renderReport, renderSummary } from '../domain/report-view.js';
import { awaitPort } from './port-deadline.js';

/** Converts unexpected rejection of a locally valid control request into an invariant error. */
function requireControlAck(operation: string, result: SyscallAck | SyscallRejected): void {
  if (result.outcome === 'REJECTED')
    throw new Error(
      `Interaction control invariant failed: ${operation} rejected (${result.reasonCode})`,
    );
}

/** Builds one interaction session without acquiring terminal resources until start. */
export function createInteractionRunner(deps: UserInteractionDeps): UserInteractionModule {
  const now = deps.now ?? (() => new Date());
  const questions = new Map<
    string,
    { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  >();
  let isStarted = false;
  let isStopping = false;
  let isAnalyzing = false;
  let isFinished = false;
  let hasInterrupted = false;
  let hasFault = false;
  let workflowRunId: string | undefined;
  let removeInterrupt: (() => void) | undefined;
  let stopTask: Promise<void> | undefined;
  let detachedError: unknown;
  let command: AnalyzeCommand | undefined;
  let resolveCreated: () => void = () => {};
  const created = new Promise<void>((resolve) => {
    resolveCreated = resolve;
  });
  let resolveFinished: (code: number) => void = () => {};
  let rejectFinished: (error: unknown) => void = () => {};
  const finished = new Promise<number>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // A detached boundary can fail before analyze starts awaiting the terminal event.
  void finished.catch(() => undefined);

  function context(): BoundaryContext {
    return {
      correlationId: newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      ...(workflowRunId === undefined ? {} : { workflowRunId }),
    };
  }

  function endQuestion(id: string): void {
    const question = questions.get(id);
    if (question === undefined) return;
    questions.delete(id);
    clearTimeout(question.timer);
    question.controller.abort();
  }

  function endQuestions(): void {
    for (const id of questions.keys()) endQuestion(id);
  }

  function reportFault(error: unknown): void {
    hasFault = true;
    endQuestions();
    rejectFinished(error);
    if (deps.reportSystemFault === undefined) detachedError ??= error;
    else
      deps.reportSystemFault({
        source: 'user-interaction',
        phase: 'RUN',
        error,
        ...(workflowRunId === undefined ? {} : { workflowRunId }),
      });
  }

  async function ask(question: AuthorizationRequest, signal: AbortSignal): Promise<void> {
    let answer: 'YES' | 'NO' | undefined;
    try {
      answer = await deps.terminal.askYesNo(messages.authorize, signal);
    } catch (error) {
      if (signal.aborted && error instanceof Error && error.name === 'AbortError') return;
      throw error;
    }
    if (answer === undefined || signal.aborted || isFinished || hasFault || isStopping) return;
    // Release the timer before awaiting the response; a late answer is still checked by Core.
    endQuestion(question.questionId);
    if (workflowRunId === undefined) throw new Error('Authorization has no active run');
    const result = await awaitPort(
      'answerAuthorization',
      deps.gateway.answerAuthorization(
        { requestId: newId('req'), workflowRunId, questionId: question.questionId, answer },
        context(),
      ),
    );
    if (result.outcome === 'REJECTED' && result.reasonCode === 'QUESTION_NOT_PENDING') return;
    requireControlAck('answerAuthorization', result);
  }

  function beginQuestion(question: AuthorizationRequest): void {
    if (questions.has(question.questionId)) return;
    deps.terminal.write(renderQuestion(question));
    const remainingMs = Date.parse(question.expiresAt) - now().getTime();
    if (remainingMs <= 0) {
      deps.terminal.write(messages.questionExpired + '\n');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      endQuestion(question.questionId);
      try {
        deps.terminal.write(messages.questionExpired + '\n');
      } catch (error) {
        reportFault(error);
      }
    }, remainingMs);
    questions.set(question.questionId, { controller, timer });
    void ask(question, controller.signal).catch(reportFault);
  }

  async function readJson(ref: ArtifactRef): Promise<unknown> {
    if (workflowRunId === undefined) throw new Error('Artifact read has no active run');
    const result = await awaitPort(
      'readArtifact',
      deps.gateway.readArtifact({ requestId: newId('req'), workflowRunId, ref }, context()),
    );
    if (result.outcome === 'REJECTED') return undefined;
    try {
      return JSON.parse(result.text) as unknown;
    } catch {
      return undefined;
    }
  }

  async function showFinished(event: RunFinished): Promise<number> {
    let exitCode = EXIT_CODES[event.closeReason];
    if ('reportRef' in event && event.reportRef !== undefined) {
      const checked = validate<AnalysisReport>(
        AnalysisReportSchema,
        await readJson(event.reportRef),
      );
      if (checked.ok && checked.value.workflowRunId === workflowRunId)
        deps.terminal.write(renderReport(checked.value));
      else {
        deps.terminal.write(messages.reportUnreadable + '\n');
        if (exitCode === 0) exitCode = 1;
      }
    }
    deps.terminal.write(messages.close[event.closeReason] + '\n');
    if ('failure' in event && event.failure !== undefined)
      deps.terminal.write(describeReason(event.failure.code) + '\n');
    if (event.unknownEffects.length > 0) deps.terminal.write(messages.unknownEffects + '\n');
    if ('finalizationError' in event && event.finalizationError !== undefined) {
      deps.terminal.write(messages.summaryWriteFailed + '\n');
      if (exitCode === 0) exitCode = 1;
    } else if (command?.details && 'runSummaryRef' in event) {
      const checked = validate<RunSummary>(RunSummarySchema, await readJson(event.runSummaryRef));
      deps.terminal.write(
        checked.ok && checked.value.workflowRunId === workflowRunId
          ? renderSummary(checked.value)
          : messages.summaryUnreadable + '\n',
      );
    }
    return exitCode;
  }

  async function handle(envelope: InteractionInboxEvent): Promise<void> {
    if (!isAnalyzing) throw new Error('Interaction event arrived before analyze');
    await created;
    if (envelope.workflowRunId !== workflowRunId)
      throw new Error('Interaction run identity mismatch');
    const event = envelope.event;
    if (event.type === 'RunFinished') {
      if (isFinished) return;
      isFinished = true;
      endQuestions();
      resolveFinished(await showFinished(event));
    } else if (event.type === 'AuthorizationResolved') {
      endQuestion(event.questionId);
      if (event.resolution === 'TIMED_OUT') deps.terminal.write(messages.questionExpired + '\n');
      if (event.resolution === 'CANCELLED') deps.terminal.write(messages.questionCancelled + '\n');
    } else if (!isFinished && !hasFault && !isStopping) beginQuestion(event);
  }

  const inbox = new Inbox<InteractionInboxEvent>({
    channels: ['default'],
    dedupeKey: (event) => event.eventId,
    ...(deps.reportSystemFault === undefined ? {} : { onError: reportFault }),
  });

  async function cancel(): Promise<void> {
    if (workflowRunId === undefined || isFinished || hasFault || isStopping) return;
    const result = await awaitPort(
      'cancelRun',
      deps.gateway.cancelRun({ requestId: newId('req'), workflowRunId }, context()),
    );
    requireControlAck('cancelRun', result);
  }

  function startConsumer(): void {
    if (isStarted) return;
    isStarted = true;
    inbox.start(async (envelope) => {
      try {
        await handle(envelope);
      } catch (error) {
        hasFault = true;
        endQuestions();
        rejectFinished(error);
        throw error;
      }
    });
  }

  async function analyze(input: AnalyzeCommand): Promise<number> {
    if (isAnalyzing || isStopping) throw new Error('Interaction accepts only one analyze command');
    isAnalyzing = true;
    command = { ...input };
    try {
      const result = await awaitPort(
        'createRun',
        deps.gateway.createRun(
          { requestId: newId('req'), goal: input.goal, repositoryPath: input.repositoryPath },
          context(),
        ),
      );
      if (result.outcome === 'REJECTED') {
        isFinished = true;
        deps.terminal.write(describeReason(result.reasonCode) + '\n');
        resolveFinished(EXIT_CODE_RUN_REJECTED);
      } else workflowRunId = result.workflowRunId;
      resolveCreated();
      const code = await finished;
      try {
        const shutdown = await awaitPort(
          'shutdown',
          deps.gateway.shutdown({ requestId: newId('req') }, context()),
        );
        requireControlAck('shutdown', shutdown);
      } catch (error) {
        if (deps.reportSystemFault === undefined) throw error;
        // Return the recorded code so the root can preserve an existing nonzero outcome.
        reportFault(error);
      }
      return code;
    } catch (error) {
      hasFault = true;
      endQuestions();
      resolveCreated();
      throw error;
    } finally {
      endQuestions();
      removeInterrupt?.();
      removeInterrupt = undefined;
    }
  }

  return {
    manifest: Object.freeze({
      moduleId: 'user-interaction',
      version: '0.1.0',
      dependencies: Object.freeze(['gateway'] as const),
    }),
    inbox: {
      deliver: (envelope) => {
        if (isStopping) return Promise.reject(new Error('Interaction stopped accepting events'));
        const checked = validate<InteractionInboxEvent>(InteractionInboxEventSchema, envelope);
        if (!checked.ok)
          return Promise.reject(new Error('Interaction Inbox event violates its contract'));
        inbox.enqueue(structuredClone(checked.value));
        return Promise.resolve();
      },
    },
    analyze,
    start: () => {
      if (isStopping) return Promise.reject(new Error('Interaction cannot start after stop'));
      if (!isStarted) {
        removeInterrupt = deps.terminal.onInterrupt(() => {
          if (hasInterrupted) return;
          hasInterrupted = true;
          void cancel().catch(reportFault);
        });
        startConsumer();
      }
      return Promise.resolve();
    },
    stop: () => {
      if (stopTask !== undefined) return stopTask;
      isStopping = true;
      endQuestions();
      removeInterrupt?.();
      removeInterrupt = undefined;
      resolveCreated();
      if (inbox.size > 0) startConsumer();
      stopTask = inbox.idle().then(() => {
        isStarted = false;
        rejectFinished(new Error('Interaction stopped before command completion'));
        if (detachedError !== undefined)
          throw detachedError instanceof Error
            ? detachedError
            : new Error('Detached interaction task failed', { cause: detachedError });
      });
      return stopTask;
    },
    health: () =>
      Promise.resolve({
        status: hasFault ? 'DEGRADED' : isStarted && !isStopping ? 'UP' : 'DOWN',
        checkedAt: now().toISOString(),
        details: hasFault ? ['Interaction encountered a system fault'] : [],
      }),
  };
}
