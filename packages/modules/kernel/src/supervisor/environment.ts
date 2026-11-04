import {
  DENY_SANDBOX,
  type ExecutionRequest,
  type ExecutorEnvironment,
  type ProviderCredentials,
  type SandboxRunner,
  type SubprocessRunner,
} from '@multiagentos/contracts';

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
 * only MODEL receives credentials, REPOSITORY_SEARCH and GIT_INSPECT receive the real runner of
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
      request.executionKind === 'REPOSITORY_SEARCH' || request.executionKind === 'GIT_INSPECT'
        ? deps.subprocess
        : DENY_SUBPROCESS,
    sandbox: request.executionKind === 'COMMAND' ? deps.sandbox : DENY_SANDBOX,
    credentials: request.executionKind === 'MODEL' ? deps.credentials : DENY_CREDENTIALS,
    now: deps.now,
  };
}
