import type {
  ExecutionRequestV1,
  ExecutorEnvironmentV1,
  ProviderCredentials,
  SubprocessRunner,
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
  readonly now: () => Date;
}

/**
 * Builds the smallest environment an Executor needs (docs/M1/Kernel/Supervisor.md 4):
 * only MODEL receives credentials and only REPOSITORY_SEARCH receives the real runner.
 */
export function createExecutorEnvironment(
  request: ExecutionRequestV1,
  signal: AbortSignal,
  deps: ExecutorEnvironmentDeps,
): ExecutorEnvironmentV1 {
  return {
    scope: request.scope,
    limits: request.limits,
    signal,
    subprocess: request.executionKind === 'REPOSITORY_SEARCH' ? deps.subprocess : DENY_SUBPROCESS,
    credentials: request.executionKind === 'MODEL' ? deps.credentials : DENY_CREDENTIALS,
    now: deps.now,
  };
}
