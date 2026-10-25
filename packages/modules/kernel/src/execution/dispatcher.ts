import type { ExecutionRequest } from '@multiagentos/contracts';

/**
 * The one place Execution hands a request to the execution carrier. Stage 2.3 supplies the
 * request; stage 2.4 adds retry/back-off. The Supervisor registration happens outside Execution.
 */
export interface AttemptDispatcher {
  dispatch(request: ExecutionRequest): Promise<void> | void;
}
