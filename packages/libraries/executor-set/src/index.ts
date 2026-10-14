/**
 * ExecutorSet static library (docs/M1/Library/ExecutorSet.md). One directory per Executor, and
 * `repository-access/` is shared by the three repository Executors. Provider SDKs may be
 * imported only under `model-call/`.
 */
import type { ExecutorRegistry } from '@multiagentos/contracts';
import { createAssembleExecutor } from './context-assemble/assemble-executor.js';
import { createFileReadExecutor } from './file-read/file-read-executor.js';
import { createModelCallExecutor } from './model-call/model-call-executor.js';
import { FileDigestCache } from './repository-access/file-set.js';
import { createOrientExecutor } from './repository-orient/orient-executor.js';
import { createSearchExecutor } from './repository-search/search-executor.js';

export { DEFAULT_EXCLUSIONS } from './repository-access/default-exclusions.js';

/**
 * Called by the composition root, which injects the result into the Supervisor. The registry
 * owns one digest cache, so the snapshot of a repository is hashed once per process and only
 * changed files are hashed again.
 */
export function createExecutorRegistry(): ExecutorRegistry {
  const cache = new FileDigestCache();
  return {
    REPOSITORY_ORIENT: createOrientExecutor(cache),
    REPOSITORY_SEARCH: createSearchExecutor({ cache }),
    FILE_READ: createFileReadExecutor(),
    CONTEXT_ASSEMBLE: createAssembleExecutor(),
    MODEL: createModelCallExecutor(),
  };
}
