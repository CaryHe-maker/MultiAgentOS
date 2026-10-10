/**
 * ExecutorSet static library (docs/M1/Library/ExecutorSet.md). One directory per Executor, and
 * `repository-access/` is shared by the three repository Executors. Provider SDKs may be
 * imported only under `model-call/`.
 */
import type { ExecutorRegistry } from '@multiagentos/contracts';

export { DEFAULT_EXCLUSIONS } from './repository-access/default-exclusions.js';

/** Called by the composition root, which injects the result into the Supervisor. */
export function createExecutorRegistry(): ExecutorRegistry {
  throw new Error('NOT_IMPLEMENTED: ExecutorSet');
}
