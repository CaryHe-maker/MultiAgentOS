import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '@multiagentos/contracts';
import type {
  ExecutionScope,
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
import { createExecutorRegistry } from './index.js';
import { createModelCallExecutor } from './model-call/model-call-executor.js';
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
  history: [{ seq: 1, category: 'PINNED', kind: 'HUMAN', text: 'Explain what add does.' }],
  status: {
    round: 1,
    maxRounds: 5,
    final: false,
    budget: { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' },
  },
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
  return { ...createExecutorRegistry(), MODEL: createModelCallExecutor({ fetch: fakeProvider }) };
}

const INPUTS: ExecutorInputByKind = {
  REPOSITORY_ORIENT: { objective: 'Explain the fixture.', tokenBudget: 4_000 },
  REPOSITORY_SEARCH: { query: 'add', mode: 'AUTO', maxItems: 20, tokenBudget: 4_000 },
  REPOSITORY_LIST: { depth: 2 },
  FILE_READ: { path: 'src/math.ts' },
  FILE_WRITE: { path: 'unused', content: '', expectAbsent: true },
  FILE_EDIT: { path: 'unused', oldString: 'x', newString: '', baseSha: sha256Hex('') },
  OUTPUT_READ: { toolCallId: 'call_1', content: 'one\ntwo\n' },
  CONTEXT_ASSEMBLE: assembleInput,
  MODEL: { contextPack: pack, final: false },
};

/** The cases share one repository, so each write has a file of its own. */
let writes = 0;
function inputFor<K extends ExecutorKind>(kind: K): ExecutorInputByKind[K];
function inputFor(kind: ExecutorKind): ExecutorInputByKind[ExecutorKind] {
  writes += 1;
  const path = `written-${String(writes)}.txt`;
  if (kind === 'FILE_WRITE') return { path, content: 'written\n', expectAbsent: true };
  if (kind !== 'FILE_EDIT') return INPUTS[kind];
  writeFileSync(join(repository.root, path), 'left + right\n');
  return {
    path,
    oldString: 'left + right',
    newString: 'right + left',
    baseSha: sha256Hex('left + right\n'),
  };
}

const scopeOf = (kind: ExecutorKind): ExecutionScope =>
  kind === 'MODEL'
    ? MODEL_SCOPE
    : kind === 'CONTEXT_ASSEMBLE' || kind === 'OUTPUT_READ'
      ? ({ kind: 'NONE' } as const)
      : kind === 'FILE_WRITE' || kind === 'FILE_EDIT'
        ? {
            kind: 'WORKSPACE' as const,
            repositoryRoot: repository.root,
            writableRoots: ['.'],
            exclusions: [],
          }
        : repositoryScope(repository.root);

describeExecutorContract('ExecutorSet', {
  create: registryUnderTest,
  caseFor: (kind) => ({
    input: inputFor(kind),
    environment: environmentFor(kind, scopeOf(kind), { subprocess: runner }),
  }),
  expectations: repositoryGuardExpectations(repository, (kind, scope) =>
    environmentFor(kind, scope, { subprocess: runner }),
  ),
});

describeExecutorContract('ExecutorSet registry without rg', {
  create: registryUnderTest,
  caseFor: (kind) => ({ input: inputFor(kind), environment: environmentFor(kind, scopeOf(kind)) }),
  expectations: repositoryGuardExpectations(repository, (kind, scope) =>
    environmentFor(kind, scope),
  ),
});
