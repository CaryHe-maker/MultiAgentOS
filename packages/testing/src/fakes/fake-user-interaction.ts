import {
  newId,
  type BoundaryContext,
  type InteractionInboxEvent,
  type KernelToInteractionEvent,
  type RunFinished,
} from '@multiagentos/contracts';
import { Inbox } from '@multiagentos/fabric';
import {
  EXIT_CODES,
  EXIT_CODE_RUN_REJECTED,
  type UserInteractionDeps,
  type UserInteractionModule,
} from '@multiagentos/user-interaction';

/**
 * UserInteraction stand-in for Kernel and Workflow work. It creates the run, answers an
 * authorization question with a fixed answer, waits for RunFinished, reads the report, asks
 * for shutdown and returns the exit code. It formats nothing and reads no terminal input.
 */
export interface FakeUserInteractionOptions {
  /** How to answer an AuthorizationRequest; default YES. */
  readonly answer?: 'YES' | 'NO';
}

export interface FakeUserInteractionModule extends UserInteractionModule {
  /** Every event received so far, in order. */
  readonly events: readonly KernelToInteractionEvent[];
  /** Text of the report artifact of the finished run, when it had one. */
  readonly reportText: string | undefined;
}

export function createFakeUserInteraction(
  options: FakeUserInteractionOptions = {},
): (deps: UserInteractionDeps) => FakeUserInteractionModule {
  return (deps) => {
    const events: KernelToInteractionEvent[] = [];
    const inbox = new Inbox<InteractionInboxEvent>({
      channels: ['default'],
      dedupeKey: (event) => event.eventId,
    });
    let reportText: string | undefined;
    let resolveFinished: (event: RunFinished) => void = () => undefined;
    const finished = new Promise<RunFinished>((resolve) => {
      resolveFinished = resolve;
    });
    const contextOf = (workflowRunId?: string): BoundaryContext => ({
      correlationId: newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      ...(workflowRunId === undefined ? {} : { workflowRunId }),
    });

    return {
      manifest: { moduleId: 'user-interaction', version: '0.0.0-fake', dependencies: ['gateway'] },
      events,
      get reportText() {
        return reportText;
      },
      inbox: {
        deliver: (event) => {
          inbox.enqueue(event);
          return Promise.resolve();
        },
      },
      start: () => {
        inbox.start(async ({ workflowRunId, event }) => {
          events.push(event);
          if (event.type === 'AuthorizationRequest')
            await deps.gateway.answerAuthorization(
              {
                requestId: newId('req'),
                workflowRunId,
                questionId: event.questionId,
                answer: options.answer ?? 'YES',
              },
              contextOf(workflowRunId),
            );
          if (event.type === 'RunFinished') resolveFinished(event);
        });
        return Promise.resolve();
      },
      stop: () => inbox.idle(),
      health: () =>
        Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: ['fake'] }),
      analyze: async (command) => {
        const created = await deps.gateway.createRun(
          { requestId: newId('req'), goal: command.goal, repositoryPath: command.repositoryPath },
          contextOf(),
        );
        if (created.outcome === 'REJECTED') {
          deps.terminal.write(`rejected: ${created.reasonCode}\n`);
          await deps.gateway.shutdown({ requestId: newId('req') }, contextOf());
          return EXIT_CODE_RUN_REJECTED;
        }
        const { workflowRunId } = created;
        const end = await finished;
        if (end.closeReason === 'COMPLETED') {
          const content = await deps.gateway.readArtifact(
            { requestId: newId('req'), workflowRunId, ref: end.reportRef },
            contextOf(workflowRunId),
          );
          if (content.outcome === 'ACCEPTED') reportText = content.text;
        }
        deps.terminal.write(`${end.closeReason}\n`);
        await deps.gateway.shutdown({ requestId: newId('req') }, contextOf());
        return EXIT_CODES[end.closeReason];
      },
    };
  };
}
