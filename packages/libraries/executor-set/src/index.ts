/**
 * ExecutorSet static library (docs/M2/Library/ExecutorSet.md). One directory per Executor, and
 * `repository-access/` is shared by the repository Executors. Provider SDKs may be imported only
 * under `model-call/`.
 */
import type { ExecutionScope, ExecutorRegistry } from '@multiagentos/contracts';
import { createAssembleExecutor } from './context-assemble/assemble-executor.js';
import { createFileReadExecutor } from './file-read/file-read-executor.js';
import { createModelCallExecutor } from './model-call/model-call-executor.js';
import { FileDigestCache } from './repository-access/file-set.js';
import { readGuardedFile } from './repository-access/guarded-file.js';
import { resolveRepositoryScope } from './repository-access/repository-scope.js';
import { createOrientExecutor } from './repository-orient/orient-executor.js';
import { createSearchExecutor } from './repository-search/search-executor.js';
import { createListExecutor } from './repository-list/list-executor.js';

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
    REPOSITORY_LIST: createListExecutor(cache),
    FILE_READ: createFileReadExecutor(),
    CONTEXT_ASSEMBLE: createAssembleExecutor(),
    MODEL: createModelCallExecutor(),
  };
}

/**
 * `readProjectFile` reads `AGENTS.md` through the same guard as `file-read` (Kernel/Execution
 * 5): undefined when the scope is invalid or the file cannot be read under its checks.
 */
export async function readRepositoryText(
  path: string,
  scope: ExecutionScope,
): Promise<string | undefined> {
  const resolved = await resolveRepositoryScope(scope);
  if (resolved === undefined) return undefined;
  const read = await readGuardedFile(resolved, path);
  return read.ok ? read.file.content.toString('utf8') : undefined;
}
