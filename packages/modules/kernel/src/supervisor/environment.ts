import {
  DENY_SANDBOX,
  type ExecutionRequest,
  type ExecutorEnvironment,
  type ProviderCredentials,
  type SandboxRunner,
  type SubprocessRunner,
} from '@multiagentos/contracts';
import { createSandboxedGit } from './sandbox/sandboxed-git.js';

/** A capability that refuses without touching a credential or starting a process. */
const DENY_CREDENTIALS: ProviderCredentials = {
  apiKeyFor: () => undefined,
};

const NOT_RUN: Awaited<ReturnType<SubprocessRunner['run']>> = {
  exitCode: null,
  signal: null,
  stdout: '',
  truncated: false,
};

const DENY_SUBPROCESS: SubprocessRunner = {
  run: () => Promise.resolve(NOT_RUN),
};

export interface ExecutorEnvironmentDeps {
  readonly credentials: ProviderCredentials;
  readonly subprocess: SubprocessRunner;
  readonly sandbox: SandboxRunner;
  readonly now: () => Date;
}

/**
 * Builds the smallest environment an Executor needs:
 * only MODEL and the web tools receive credentials, REPOSITORY_SEARCH and GIT_INSPECT receive the real runner of
 * `rg` and `git`, and only COMMAND receives the sandbox.
 */
export function createExecutorEnvironment(
  request: ExecutionRequest,
  signal: AbortSignal,
  deps: ExecutorEnvironmentDeps,
): ExecutorEnvironment {
  return {
    scope: request.scope,
    limits: request.limits,
    signal,
    subprocess:
      request.executionKind === 'GIT_INSPECT' && request.scope.kind === 'REPOSITORY'
        ? createSandboxedGit(deps.subprocess, deps.sandbox, request.scope.repositoryRoot)
        : request.executionKind === 'REPOSITORY_SEARCH' || request.executionKind === 'GIT_INSPECT'
          ? deps.subprocess
          : DENY_SUBPROCESS,
    sandbox: request.executionKind === 'COMMAND' ? deps.sandbox : DENY_SANDBOX,
    // The model provider's key also serves the web tools, since DeepSeek's interface takes it.
    credentials:
      request.executionKind === 'MODEL' ||
      request.executionKind === 'WEB_SEARCH' ||
      request.executionKind === 'WEB_FETCH'
        ? deps.credentials
        : DENY_CREDENTIALS,
    now: deps.now,
  };
}
