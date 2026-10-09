import type {
  ContextPack,
  ExecutorEnvironment,
  ExecutorInputByKind,
  ExecutorKind,
  ExecutionScope,
} from '@multiagentos/contracts';
import { cannedAssemble } from '../fixtures/canned.js';
import { createFakeExecutorRegistry } from '../fakes/fake-executors.js';
import { describeExecutorContract } from './executor-contract.js';

const SCOPES: { readonly [K in ExecutorKind]: ExecutionScope } = {
  REPOSITORY_ORIENT: { kind: 'REPOSITORY', repositoryRoot: '/repository', exclusions: [] },
  REPOSITORY_SEARCH: { kind: 'REPOSITORY', repositoryRoot: '/repository', exclusions: [] },
  FILE_READ: { kind: 'REPOSITORY', repositoryRoot: '/repository', exclusions: [] },
  CONTEXT_ASSEMBLE: { kind: 'NONE' },
  MODEL: {
    kind: 'MODEL',
    provider: 'fake',
    apiModelId: 'fake-model',
    apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
    baseUrl: 'https://example.invalid',
    thinking: 'DISABLED',
  },
};
const status = { roundsUsed: 0, maxRounds: 1, final: false, budgetState: 'NORMAL' } as const;
const assembleInput: ExecutorInputByKind['CONTEXT_ASSEMBLE'] = {
  objective: 'Explain the README.',
  final: false,
  tokenBudget: 64_000,
  instructions: 'CANNED INSTRUCTIONS',
  toolSpecs: [],
  history: [],
  status,
};
const INPUTS: ExecutorInputByKind = {
  REPOSITORY_ORIENT: { objective: 'Explain the README.', tokenBudget: 4_000 },
  REPOSITORY_SEARCH: { query: 'README', mode: 'AUTO', maxItems: 20, tokenBudget: 4_000 },
  FILE_READ: { path: 'README.md' },
  CONTEXT_ASSEMBLE: assembleInput,
  MODEL: {
    contextPack: JSON.parse(cannedAssemble(assembleInput).artifact?.text ?? '{}') as ContextPack,
    final: false,
  },
};

function environmentFor(kind: ExecutorKind): ExecutorEnvironment {
  return {
    scope: SCOPES[kind],
    limits: {
      deadline: '2099-01-01T00:00:00.000Z',
      maxOutputBytes: 1_048_576,
      maxOutputTokens: 8_192,
      maxFiles: 20_000,
    },
    signal: new AbortController().signal,
    subprocess: {
      run: () => Promise.resolve({ exitCode: 1, signal: null, stdout: '', truncated: false }),
    },
    credentials: { apiKeyFor: () => undefined },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };
}

describeExecutorContract('fake registry', {
  create: () => createFakeExecutorRegistry(),
  caseFor: (kind) => ({ input: INPUTS[kind], environment: environmentFor(kind) }),
});
