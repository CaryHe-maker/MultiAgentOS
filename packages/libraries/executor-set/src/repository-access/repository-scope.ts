import { realpath } from 'node:fs/promises';
import { isAbsolute, posix } from 'node:path';
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
   * The default rules followed by the scope's own. Core already puts the
   * defaults into every scope; they are added here again because the Executor is the last line
   * of defence and must not depend on that.
   */
  readonly rules: readonly string[];
  /** A folder outside the workspace that the user allowed: the call stays below `below`. */
  readonly external?: { readonly below: string };
}

/** The path as the model reads it: in full for an external root, where it asked with a full path. */
export const shownPath = (scope: RepositoryScope, path: string): string =>
  scope.external === undefined ? path : path === '' ? scope.root : posix.join(scope.root, path);

/** True when an external call may touch `path` (relative to the root); a workspace call always may. */
export function isWithinScope(scope: RepositoryScope, path: string): boolean {
  if (scope.external === undefined) return true;
  const { below } = scope.external;
  return below === '' || path === below || path.startsWith(`${below}/`);
}

/**
 * Step 1 of ExecutorSet. Undefined means the scope is missing or malformed (including an
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
  return {
    root,
    rules: [...new Set([...DEFAULT_REPOSITORY_EXCLUSIONS, ...scope.exclusions])],
    ...(scope.external === undefined ? {} : { external: scope.external }),
  };
}
