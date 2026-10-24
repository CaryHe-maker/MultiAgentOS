import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  DEFAULT_REPOSITORY_EXCLUSIONS,
  isValidExclusionRule,
  type ExecutionScope,
} from '@multiagentos/contracts';

/** The repository an execution may read, with the rules that apply to it. */
export interface RepositoryScope {
  /** `scope.repositoryRoot` resolved with `realpath`; every real path must stay inside it. */
  readonly root: string;
  /**
   * The default rules of M1Interface 3.5 followed by the scope's own. Core already puts the
   * defaults into every scope; they are added here again because the Executor is the last line
   * of defence and must not depend on that.
   */
  readonly rules: readonly string[];
}

/**
 * Step 1 of ExecutorSet 3.2. Undefined means the scope is missing or malformed (including an
 * exclusion rule the shared matcher cannot apply), which is a security violation
 * (SCOPE_MISSING) rather than a normal rejection: the Kernel must always derive a valid
 * repository scope for these kinds.
 */
export async function resolveRepositoryScope(
  scope: ExecutionScope,
): Promise<RepositoryScope | undefined> {
  if (scope.kind !== 'REPOSITORY' || !isAbsolute(scope.repositoryRoot)) return undefined;
  if (!scope.exclusions.every(isValidExclusionRule)) return undefined;
  let root: string;
  try {
    root = await realpath(scope.repositoryRoot);
  } catch {
    return undefined;
  }
  return { root, rules: [...new Set([...DEFAULT_REPOSITORY_EXCLUSIONS, ...scope.exclusions])] };
}
