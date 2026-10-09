import {
  ContextAssembleOutputSchema,
  FileReadOutputSchema,
  MEDIA_TYPES,
  ModelCallOutputSchema,
  REASON_CODES,
  RepositoryOrientOutputSchema,
  RepositorySearchOutputSchema,
  validate,
  type Executor,
  type ExecutorEnvironment,
  type ExecutorInputByKind,
  type ExecutorKind,
  type ExecutorOutcome,
  type ExecutorRegistry,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';

export interface ExecutorContractFixture {
  /** Builds the registry under test. */
  readonly create: () => ExecutorRegistry | Promise<ExecutorRegistry>;
  /** An input and environment for which the Executor of `kind` must complete. */
  readonly caseFor: <K extends ExecutorKind>(
    kind: K,
  ) => { readonly input: ExecutorInputByKind[K]; readonly environment: ExecutorEnvironment };
}

const EXPECTED = {
  REPOSITORY_ORIENT: { output: RepositoryOrientOutputSchema, mediaType: MEDIA_TYPES.contextPack },
  REPOSITORY_SEARCH: { output: RepositorySearchOutputSchema, mediaType: MEDIA_TYPES.contextPack },
  FILE_READ: { output: FileReadOutputSchema, mediaType: MEDIA_TYPES.fileText },
  CONTEXT_ASSEMBLE: { output: ContextAssembleOutputSchema, mediaType: MEDIA_TYPES.contextPack },
  MODEL: { output: ModelCallOutputSchema, mediaType: MEDIA_TYPES.modelOutput },
} as const;
const KINDS = Object.keys(EXPECTED) as ExecutorKind[];

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
 * What the Supervisor relies on from every Executor (M1Interface 8): the registry covers the
 * five kinds, an Executor never throws, and a completed execution carries an output that is
 * valid for its kind and an artifact of the matching media type.
 */
export function describeExecutorContract(name: string, fixture: ExecutorContractFixture): void {
  describe(`Executor contract: ${name}`, () => {
    it('has one Executor per kind, each declaring its own kind', async () => {
      const registry = await fixture.create();
      expect(Object.keys(registry).sort()).toEqual([...KINDS].sort());
      for (const kind of KINDS) expect(registry[kind].executionKind).toBe(kind);
    });

    it.each(KINDS)('%s completes with a Schema-valid output and artifact', async (kind) => {
      const registry = await fixture.create();
      const { input, environment } = fixture.caseFor(kind);
      const outcome = await run(registry, kind, input, environment);
      expect(outcome.outcome).toBe('COMPLETED');
      if (outcome.outcome !== 'COMPLETED') return;
      expect(validate(EXPECTED[kind].output, outcome.result.output)).toMatchObject({ ok: true });
      expect(outcome.result.artifact?.mediaType).toBe(EXPECTED[kind].mediaType);
      if (kind === 'MODEL') expect(outcome.requestState).toBe('SENT');
    });

    it('reports failures as outcomes with a known reason code, never as exceptions', async () => {
      const registry = await fixture.create();
      for (const kind of KINDS) {
        const { input, environment } = fixture.caseFor(kind);
        const aborted = { ...environment, signal: AbortSignal.abort() };
        const outcome = await run(registry, kind, input, aborted);
        if (outcome.outcome !== 'COMPLETED') expect(REASON_CODES).toContain(outcome.reasonCode);
      }
    });
  });
}
