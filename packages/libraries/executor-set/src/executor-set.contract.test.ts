import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ExecutorInputByKind,
  ExecutorKind,
  ExecutorRegistry,
  AssembleContextPack,
} from '@multiagentos/contracts';
import { createSubprocessRunner } from '@multiagentos/kernel';
import {
  createFixtureRepository,
  describeExecutorContract,
  repositoryGuardExpectations,
} from '@multiagentos/testing';
import { createAssembleExecutor } from './context-assemble/assemble-executor.js';
import { createFileReadExecutor } from './file-read/file-read-executor.js';
import { createExecutorRegistry } from './index.js';
import { createModelCallExecutor } from './model-call/model-call-executor.js';
import { FileDigestCache } from './repository-access/file-set.js';
import { createOrientExecutor } from './repository-orient/orient-executor.js';
import { createSearchExecutor } from './repository-search/search-executor.js';
import {
  MODEL_SCOPE,
  chatCompletion,
  emptyDirectory,
  environmentFor,
  repositoryScope,
} from './test-support/environments.js';

const base = await emptyDirectory('executor-set-contract');
const root = join(base, 'repository');
await mkdir(root);
const repository = await createFixtureRepository(root, join(base, 'outside.txt'));
const runner = createSubprocessRunner();

const assembleInput: ExecutorInputByKind['CONTEXT_ASSEMBLE'] = {
  objective: 'Explain what add does.',
  final: false,
  tokenBudget: 64_000,
  instructions: 'You analyse repositories.',
  toolSpecs: [
    {
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      purpose: 'UNIT',
    },
  ],
  history: [],
  status: { roundsUsed: 0, maxRounds: 5, final: false, budgetState: 'NORMAL' },
};

async function assembledPack(): Promise<AssembleContextPack> {
  const outcome = await createAssembleExecutor().execute(
    assembleInput,
    environmentFor('CONTEXT_ASSEMBLE', { kind: 'NONE' }),
  );
  if (outcome.outcome !== 'COMPLETED') throw new Error('assemble failed');
  return JSON.parse(outcome.result.artifact.text) as AssembleContextPack;
}
const pack = await assembledPack();

const fakeProvider: typeof fetch = () =>
  Promise.resolve(
    chatCompletion([{ id: 'call_1', name: 'read_file', arguments: '{"path":"src/math.ts"}' }]),
  );

/** The real registry with the provider faked at the HTTP layer. */
function registryUnderTest(): ExecutorRegistry {
  const cache = new FileDigestCache();
  return {
    REPOSITORY_ORIENT: createOrientExecutor(cache),
    REPOSITORY_SEARCH: createSearchExecutor({ cache }),
    FILE_READ: createFileReadExecutor(),
    CONTEXT_ASSEMBLE: createAssembleExecutor(),
    MODEL: createModelCallExecutor({ fetch: fakeProvider }),
  };
}

const INPUTS: ExecutorInputByKind = {
  REPOSITORY_ORIENT: { objective: 'Explain the fixture.', tokenBudget: 4_000 },
  REPOSITORY_SEARCH: { query: 'add', mode: 'AUTO', maxItems: 20, tokenBudget: 4_000 },
  FILE_READ: { path: 'src/math.ts' },
  CONTEXT_ASSEMBLE: assembleInput,
  MODEL: { contextPack: pack, final: false },
};

const scopeOf = (kind: ExecutorKind) =>
  kind === 'MODEL'
    ? MODEL_SCOPE
    : kind === 'CONTEXT_ASSEMBLE'
      ? ({ kind: 'NONE' } as const)
      : repositoryScope(repository.root);

describeExecutorContract('ExecutorSet', {
  create: registryUnderTest,
  caseFor: (kind) => ({
    input: INPUTS[kind],
    environment: environmentFor(kind, scopeOf(kind), { subprocess: runner }),
  }),
  expectations: repositoryGuardExpectations(repository, (kind, scope) =>
    environmentFor(kind, scope, { subprocess: runner }),
  ),
});

describeExecutorContract('ExecutorSet registry without rg', {
  create: () => {
    const real = createExecutorRegistry();
    return { ...real, MODEL: createModelCallExecutor({ fetch: fakeProvider }) };
  },
  caseFor: (kind) => ({ input: INPUTS[kind], environment: environmentFor(kind, scopeOf(kind)) }),
  expectations: repositoryGuardExpectations(repository, (kind, scope) =>
    environmentFor(kind, scope),
  ),
});
