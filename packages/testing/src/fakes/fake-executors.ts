import type {
  ExecutionResult,
  Executor,
  ExecutorKind,
  ExecutorOutcome,
  ExecutorRegistry,
} from '@multiagentos/contracts';
import {
  cannedAssemble,
  cannedFileRead,
  cannedModelCall,
  cannedOrient,
  cannedSearch,
  defaultModelScript,
  describePack,
  type ModelScript,
} from '../fixtures/canned.js';

/**
 * ExecutorSet stand-in: every Executor completes at once with a canned, Schema-valid result.
 * It reads no repository and calls no provider. Pass `overrides` to run a real Executor for
 * some kinds next to the fakes for the others.
 */
export function createFakeExecutorRegistry(
  modelScript: ModelScript = defaultModelScript,
  overrides: Partial<ExecutorRegistry> = {},
): ExecutorRegistry {
  let modelCalls = 0;
  const completed = (result: ExecutionResult) =>
    Promise.resolve<ExecutorOutcome>({ outcome: 'COMPLETED', result });
  const executor = <K extends ExecutorKind>(
    executionKind: K,
    execute: Executor<K>['execute'],
  ): Executor<K> => ({ executionKind, execute });
  return {
    REPOSITORY_ORIENT: executor('REPOSITORY_ORIENT', (input) =>
      completed(cannedOrient(input.tokenBudget)),
    ),
    REPOSITORY_SEARCH: executor('REPOSITORY_SEARCH', (input) =>
      completed(cannedSearch(input.tokenBudget)),
    ),
    FILE_READ: executor('FILE_READ', (input) => completed(cannedFileRead(input))),
    CONTEXT_ASSEMBLE: executor('CONTEXT_ASSEMBLE', (input) => completed(cannedAssemble(input))),
    MODEL: executor('MODEL', (input) => {
      const calls = modelScript({
        ...describePack(input.contextPack),
        final: input.final,
        callIndex: modelCalls,
      });
      modelCalls += 1;
      return Promise.resolve<ExecutorOutcome>({
        outcome: 'COMPLETED',
        result: cannedModelCall(calls),
        requestState: 'SENT',
        usage: { inputTokens: 100, outputTokens: 10 },
      });
    }),
    ...overrides,
  };
}
