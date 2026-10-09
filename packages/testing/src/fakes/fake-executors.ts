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
  type ModelScript,
} from '../fixtures/canned.js';

/**
 * ExecutorSet stand-in for Kernel work: every Executor completes at once with a canned,
 * Schema-valid result. It reads no repository and calls no provider.
 */
export function createFakeExecutorRegistry(
  modelScript: ModelScript = defaultModelScript,
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
    CONTEXT_ASSEMBLE: executor('CONTEXT_ASSEMBLE', (input) =>
      completed(cannedAssemble(input.objective, input.tokenBudget)),
    ),
    MODEL: executor('MODEL', (input) => {
      const calls = modelScript({ agentId: undefined, callIndex: modelCalls, final: input.final });
      modelCalls += 1;
      return Promise.resolve<ExecutorOutcome>({
        outcome: 'COMPLETED',
        result: cannedModelCall(calls),
        requestState: 'SENT',
        usage: { inputTokens: 100, outputTokens: 10 },
      });
    }),
  };
}
