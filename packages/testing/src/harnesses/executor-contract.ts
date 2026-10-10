import {
  ContextPackSchema,
  EXECUTOR_KINDS,
  ExecutionFactSchema,
  ModelRawOutputSchema,
  sha256Hex,
  validate,
  type ContextAssembleOutput,
  type ContextPack,
  type Executor,
  type ExecutorEnvironment,
  type ExecutorInputByKind,
  type ExecutorKind,
  type ExecutorOutcome,
  type ExecutorRegistry,
  type FileReadOutput,
  type ModelCallOutput,
  type ModelRawOutput,
  type ReasonCode,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';

export interface ExecutorCase<K extends ExecutorKind = ExecutorKind> {
  readonly input: ExecutorInputByKind[K];
  readonly environment: ExecutorEnvironment;
}

/** An extra case with the verdict the specification requires for it. */
export interface ExecutorExpectation {
  readonly name: string;
  readonly kind: ExecutorKind;
  readonly input: unknown;
  readonly environment: ExecutorEnvironment;
  readonly expected:
    | { readonly outcome: 'COMPLETED' }
    | { readonly outcome: 'REJECTED' | 'FAILED' | 'VIOLATION'; readonly reasonCode: ReasonCode };
}

export interface ExecutorContractFixture {
  /** Builds the registry under test. */
  readonly create: () => ExecutorRegistry | Promise<ExecutorRegistry>;
  /** An input and environment for which the Executor of `kind` must complete. */
  readonly caseFor: <K extends ExecutorKind>(kind: K) => ExecutorCase<K>;
  /**
   * Further cases, each with its required verdict. A real ExecutorSet passes the guard cases of
   * `repositoryGuardExpectations` here; the fake registry cannot, because it reads nothing.
   */
  readonly expectations?: readonly ExecutorExpectation[];
}

const PACK_OPERATION = {
  REPOSITORY_ORIENT: 'ORIENT',
  REPOSITORY_SEARCH: 'SEARCH',
  CONTEXT_ASSEMBLE: 'ASSEMBLE',
} as const;

/** Calls the Executor of `kind`; the caller pairs the kind with an input of that kind. */
function run(
  registry: ExecutorRegistry,
  kind: ExecutorKind,
  input: unknown,
  environment: ExecutorEnvironment,
): Promise<ExecutorOutcome> {
  const executor = registry[kind] as Executor<ExecutorKind>;
  return executor.execute(input as never, environment);
}

/**
 * The ExecutionFact the Supervisor would report for this outcome (M1Interface 8). Validating it
 * checks everything the Kernel relies on at once: the output type and artifact media type of the
 * kind, the reason codes allowed for the outcome, and the request state of a MODEL execution.
 */
function factOf(kind: ExecutorKind, outcome: ExecutorOutcome): object {
  const { usage, requestState, ...verdict } = {
    usage: undefined,
    requestState: undefined,
    ...outcome,
  };
  return {
    workflowRunId: 'wfr_contract',
    unitAttemptId: 'una_contract',
    executionId: 'exe_contract',
    runEpoch: 1,
    executionKind: kind,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    ...verdict,
    ...(kind === 'MODEL'
      ? { requestState: requestState ?? 'UNKNOWN', ...(usage === undefined ? {} : { usage }) }
      : {}),
  };
}

/** The artifact must be what the output describes, not merely something of the right type. */
function expectConsistentArtifact(kind: ExecutorKind, outcome: ExecutorOutcome): void {
  if (outcome.outcome !== 'COMPLETED') return;
  const { output, artifact } = outcome.result;
  if (kind === 'FILE_READ') {
    expect(sha256Hex(artifact.text)).toBe((output as FileReadOutput).contentSha256);
    expect(artifact.text).not.toContain('\r');
    return;
  }
  const content: unknown = JSON.parse(artifact.text);
  if (kind === 'MODEL') {
    expect(validate(ModelRawOutputSchema, content)).toMatchObject({ ok: true });
    const calls = (output as ModelCallOutput).toolCalls.map((call) => call.toolCallId);
    expect((content as ModelRawOutput).toolCalls.map((call) => call.toolCallId)).toEqual(calls);
    return;
  }
  expect(validate(ContextPackSchema, content)).toMatchObject({ ok: true });
  const pack = content as ContextPack;
  expect(pack.operation).toBe(PACK_OPERATION[kind]);
  expect(pack.tokenCount).toBeLessThanOrEqual(pack.tokenBudget);
  if (pack.operation === 'ASSEMBLE') {
    const assembled = output as ContextAssembleOutput;
    expect(pack).toMatchObject({
      contextPackId: assembled.contextPackId,
      prefixSha256: assembled.prefixSha256,
      tokenCount: assembled.tokenCount,
      tokenBudget: assembled.tokenBudget,
      truncated: assembled.truncated,
      droppedCount: assembled.droppedCount,
    });
  } else expect(pack.snapshotId).toBe((output as { snapshotId: string }).snapshotId);
}

/**
 * What the Supervisor and the Kernel rely on from every Executor (M1Interface 8): the registry
 * covers the five kinds, an Executor never throws, every outcome makes a valid ExecutionFact,
 * and a completed execution carries an artifact that matches its output.
 */
export function describeExecutorContract(name: string, fixture: ExecutorContractFixture): void {
  describe(`Executor contract: ${name}`, () => {
    it('has one Executor per kind, each declaring its own kind', async () => {
      const registry = await fixture.create();
      expect(Object.keys(registry).sort()).toEqual([...EXECUTOR_KINDS].sort());
      for (const kind of EXECUTOR_KINDS) expect(registry[kind].executionKind).toBe(kind);
    });

    it.each(EXECUTOR_KINDS)(
      '%s completes with a valid fact and a matching artifact',
      async (kind) => {
        const registry = await fixture.create();
        const { input, environment } = fixture.caseFor(kind);
        const outcome = await run(registry, kind, input, environment);
        expect(outcome.outcome).toBe('COMPLETED');
        expect(validate(ExecutionFactSchema, factOf(kind, outcome))).toMatchObject({ ok: true });
        if (kind === 'MODEL') expect(outcome).toMatchObject({ requestState: 'SENT' });
        expectConsistentArtifact(kind, outcome);
      },
    );

    it.each(EXECUTOR_KINDS)('%s gives the same output for the same input', async (kind) => {
      if (kind === 'MODEL') return;
      const registry = await fixture.create();
      const { input, environment } = fixture.caseFor(kind);
      const first = await run(registry, kind, input, environment);
      const second = await run(registry, kind, input, environment);
      // Identifiers and timestamps of a ContextPack are fresh each time; the rest is stable.
      const stable = (outcome: ExecutorOutcome) =>
        outcome.outcome === 'COMPLETED'
          ? { ...outcome.result.output, contextPackId: undefined }
          : outcome;
      expect(stable(second)).toEqual(stable(first));
    });

    it.each(EXECUTOR_KINDS)('%s answers an aborted execution with a valid fact', async (kind) => {
      const registry = await fixture.create();
      const { input, environment } = fixture.caseFor(kind);
      const aborted = { ...environment, signal: AbortSignal.abort() };
      const outcome = await run(registry, kind, input, aborted);
      expect(validate(ExecutionFactSchema, factOf(kind, outcome))).toMatchObject({ ok: true });
    });

    for (const expectation of fixture.expectations ?? [])
      it(`${expectation.kind}: ${expectation.name}`, async () => {
        const registry = await fixture.create();
        const { kind, input, environment, expected } = expectation;
        const outcome = await run(registry, kind, input, environment);
        expect(outcome).toMatchObject(expected);
        expect(validate(ExecutionFactSchema, factOf(kind, outcome))).toMatchObject({ ok: true });
        expectConsistentArtifact(kind, outcome);
      });
  });
}

/**
 * The verdicts ExecutorSet 3.2, 3.3 and 4.3 require for the fixture repository of
 * `createFixtureRepository`. `environment` builds the environment of a kind with the given
 * scope, so the same cases can run with any limits, clock and subprocess runner.
 */
export function repositoryGuardExpectations(
  repository: { readonly root: string; readonly escapingLink: string | undefined },
  environment: (kind: ExecutorKind, scope: ExecutorEnvironment['scope']) => ExecutorEnvironment,
): ExecutorExpectation[] {
  const scope: ExecutorEnvironment['scope'] = {
    kind: 'REPOSITORY',
    repositoryRoot: repository.root,
    exclusions: [],
  };
  const read = (
    name: string,
    input: object,
    expected: ExecutorExpectation['expected'],
    withScope: ExecutorEnvironment['scope'] = scope,
  ): ExecutorExpectation => ({
    name,
    kind: 'FILE_READ',
    input,
    environment: environment('FILE_READ', withScope),
    expected,
  });
  const rejected = (reasonCode: ReasonCode) => ({ outcome: 'REJECTED', reasonCode }) as const;
  return [
    read('reads an ordinary file', { path: 'src/math.ts' }, { outcome: 'COMPLETED' }),
    read('reads an empty file as 1..0', { path: 'docs/empty.txt' }, { outcome: 'COMPLETED' }),
    read('rejects a parent segment', { path: '../outside.txt' }, rejected('OUT_OF_SCOPE')),
    read(
      'rejects a hidden parent segment',
      { path: 'src/../../outside.txt' },
      rejected('OUT_OF_SCOPE'),
    ),
    read('rejects an absolute path', { path: '/etc/passwd' }, rejected('OUT_OF_SCOPE')),
    read('rejects a default exclusion', { path: '.env' }, rejected('OUT_OF_SCOPE')),
    read('rejects a key file', { path: 'keys/server.pem' }, rejected('OUT_OF_SCOPE')),
    read(
      'rejects node_modules',
      { path: 'node_modules/dependency/index.js' },
      rejected('OUT_OF_SCOPE'),
    ),
    read('rejects an exclusion added by Core', { path: 'src/math.ts' }, rejected('OUT_OF_SCOPE'), {
      ...scope,
      exclusions: ['src/**'],
    }),
    read('rejects a missing file', { path: 'src/missing.ts' }, rejected('NOT_FOUND')),
    read('rejects a directory', { path: 'src' }, rejected('UNSUPPORTED_FILE')),
    read('rejects a binary file', { path: 'assets/logo.bin' }, rejected('UNSUPPORTED_FILE')),
    read(
      'rejects a range beyond the file',
      { path: 'src/math.ts', startLine: 99 },
      rejected('INVALID_RANGE'),
    ),
    read(
      'reports a missing scope as a violation',
      { path: 'src/math.ts' },
      { outcome: 'VIOLATION', reasonCode: 'SCOPE_MISSING' },
      { kind: 'NONE' },
    ),
    ...(repository.escapingLink === undefined
      ? []
      : [
          read(
            'rejects a link that leaves the repository',
            { path: repository.escapingLink },
            rejected('OUT_OF_SCOPE'),
          ),
        ]),
    {
      name: 'rejects a blank query',
      kind: 'REPOSITORY_SEARCH',
      input: { query: '   ', mode: 'TEXT', maxItems: 20, tokenBudget: 4_000 },
      environment: environment('REPOSITORY_SEARCH', scope),
      expected: rejected('INVALID_QUERY'),
    },
    {
      name: 'rejects a repository with more files than maxFiles',
      kind: 'REPOSITORY_ORIENT',
      input: { objective: 'Explain the fixture.', tokenBudget: 4_000 },
      environment: {
        ...environment('REPOSITORY_ORIENT', scope),
        limits: { deadline: '2099-01-01T00:00:00.000Z', maxOutputBytes: 1_048_576, maxFiles: 1 },
      },
      expected: rejected('LIMIT_EXCEEDED'),
    },
  ];
}
