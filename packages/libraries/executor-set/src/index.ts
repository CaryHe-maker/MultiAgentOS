/**
 * ExecutorSet static library (docs/M2/Library/ExecutorSet.md). One directory per Executor, and
 * `repository-access/` is shared by the repository Executors. Provider SDKs may be imported only
 * under `model-call/`.
 */
import { createRunCommandExecutor } from './command/run-command-executor.js';
import { createGitInspectExecutor } from './git/git-inspect-executor.js';
import type { ExecutionScope, ExecutorRegistry } from '@multiagentos/contracts';
import { createAssembleExecutor } from './context-assemble/assemble-executor.js';
import { createFileReadExecutor } from './file-read/file-read-executor.js';
import { createFileEditExecutor, createFileWriteExecutor } from './fs/file-write-executor.js';
import { PathLocks } from './fs/guarded-write.js';
export { createShadowFiles, createWorkspaceFiles } from './fs/workspace-files.js';
import { createOutputReadExecutor } from './output-read/output-read-executor.js';
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
  const locks = new PathLocks();
  return {
    REPOSITORY_ORIENT: createOrientExecutor(cache),
    REPOSITORY_SEARCH: createSearchExecutor({ cache }),
    REPOSITORY_LIST: createListExecutor(cache),
    FILE_READ: createFileReadExecutor(),
    FILE_WRITE: createFileWriteExecutor(locks),
    FILE_EDIT: createFileEditExecutor(locks),
    OUTPUT_READ: createOutputReadExecutor(),
    COMMAND: createRunCommandExecutor(),
    GIT_INSPECT: createGitInspectExecutor(),
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

export { createCommandParser, prefixOf } from './command/parse/command-parser.js';
export type {
  CommandParser,
  ParsedCommand,
  SubCommand,
  UnreusableReason,
} from './command/parse/command-parser.js';
export { firstMatchingPattern, matchesCommandPattern } from './command/parse/command-match.js';
export { ARITY, commandPrefix } from './command/parse/arity.js';

export { createRunCommandExecutor } from './command/run-command-executor.js';
export { createGitInspectExecutor, gitArguments } from './git/git-inspect-executor.js';
