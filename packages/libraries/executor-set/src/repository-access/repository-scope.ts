import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ExecutionScope } from '@multiagentos/contracts';
import { DEFAULT_EXCLUSIONS } from './default-exclusions.js';

/** The repository an execution may read, with the rules that apply to it. */
export interface RepositoryScope {
  /** `scope.repositoryRoot` resolved with `realpath`; every real path must stay inside it. */
  readonly root: string;
  /** DEFAULT_EXCLUSIONS followed by the rules Core appended; Core can never remove a default. */
  readonly rules: readonly string[];
}

/**
 * Step 1 of ExecutorSet 3.2. Undefined means the scope is missing or malformed, which is a
 * security violation (SCOPE_MISSING) rather than a normal rejection: the Kernel must always
 * derive a repository scope for these kinds.
 */
export async function resolveRepositoryScope(
  scope: ExecutionScope,
): Promise<RepositoryScope | undefined> {
  if (scope.kind !== 'REPOSITORY' || !isAbsolute(scope.repositoryRoot)) return undefined;
  let root: string;
  try {
    root = await realpath(scope.repositoryRoot);
  } catch {
    return undefined;
  }
  return { root, rules: [...DEFAULT_EXCLUSIONS, ...scope.exclusions] };
}
