import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  SandboxRunner,
  SubprocessRunner,
} from '@multiagentos/contracts';
import { afterAll } from 'vitest';
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
const realRunner = createSubprocessRunner();
/** `git` answers with a fixed status, so the fixture need not be a repository. */
const runner: SubprocessRunner = {
  run: (command, args, options) =>
    command === 'git'
      ? Promise.resolve({ exitCode: 0, signal: null, stdout: '## main', truncated: false })
      : realRunner.run(command, args, options),
};
const gitOnly: SubprocessRunner = {
  run: (command, args, options) =>
    command === 'git'
      ? runner.run(command, args, options)
      : Promise.resolve({ exitCode: null, signal: null, stdout: '', truncated: false }),
};
const sandbox: SandboxRunner = {
  run: () =>
    Promise.resolve({
      kind: 'RAN',
      exitCode: 0,
      signal: null,
      output: 'hello',
      truncated: false,
      timedOut: false,
      denials: 0,
      backend: 'BWRAP',
    }),
};

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
    budget: { agentRun: 'NORMAL', input: 'NORMAL', run: 'NORMAL' },
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

/** DeepSeek's search and fetch interface, faked at the HTTP layer. */
const fakeWeb: typeof fetch = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = url.endsWith('/v1/tools/search')
    ? { results: [{ title: 'Contract', url: 'https://example.com/a', summary: 'A page.' }] }
    : { title: 'Page', content: '# Page\n\nText.' };
  return Promise.resolve(Response.json(body));
};

/** A page of this process's own: this program fetches first, so the contract reads a real one. */
const pageServer = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(
    '<html><head><title>Page</title></head><body><h1>Page</h1><p>Text.</p></body></html>',
  );
});
await new Promise<void>((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
afterAll(() => {
  pageServer.close();
});
const pageUrl = `http://contract.example:${String((pageServer.address() as AddressInfo).port)}/page`;

/** The real registry with the providers faked at the HTTP layer. */
function registryUnderTest(): ExecutorRegistry {
  return {
    ...createExecutorRegistry({
      web: {
        fetch: fakeWeb,
        resolve: () => Promise.resolve(['127.0.0.1']),
        // Only the address of the page server is let through.
        policy: { forbids: (address) => address !== '127.0.0.1' },
      },
    }),
    MODEL: createModelCallExecutor({ fetch: fakeProvider }),
  };
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
  COMMAND: { command: 'echo hello', timeoutMs: 1_000 },
  GIT_INSPECT: { action: 'status' },
  WEB_SEARCH: { queries: ['executor contract'] },
  WEB_FETCH: { url: pageUrl },
  CONTEXT_PRUNE: {
    headBytes: 8,
    tailBytes: 4,
    items: [{ toolCallId: 'call_1', text: 'x'.repeat(100) }],
  },
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
    : kind === 'CONTEXT_ASSEMBLE' ||
        kind === 'OUTPUT_READ' ||
        kind === 'WEB_SEARCH' ||
        kind === 'WEB_FETCH'
      ? ({ kind: 'NONE' } as const)
      : kind === 'FILE_WRITE' || kind === 'FILE_EDIT'
        ? {
            kind: 'WORKSPACE' as const,
            repositoryRoot: repository.root,
            writableRoots: ['.'],
            exclusions: [],
          }
        : kind === 'COMMAND'
          ? {
              kind: 'SANDBOX' as const,
              backend: 'BWRAP' as const,
              approvalDigest: 'a'.repeat(64),
              profile: {
                repositoryRoot: repository.root,
                workdir: '',
                writableRoots: ['.'],
                network: false,
                homeReadOnly: [],
                homeMaskedFiles: [],
                maskedFiles: [],
                maskedDirs: [],
                protectedExisting: [],
              },
            }
          : repositoryScope(repository.root);

describeExecutorContract('ExecutorSet', {
  create: registryUnderTest,
  caseFor: (kind) => ({
    input: inputFor(kind),
    environment: environmentFor(kind, scopeOf(kind), { subprocess: runner, sandbox }),
  }),
  expectations: repositoryGuardExpectations(repository, (kind, scope) =>
    environmentFor(kind, scope, { subprocess: runner, sandbox }),
  ),
});

describeExecutorContract('ExecutorSet registry without rg', {
  create: registryUnderTest,
  caseFor: (kind) => ({
    input: inputFor(kind),
    environment: environmentFor(kind, scopeOf(kind), { subprocess: gitOnly, sandbox }),
  }),
  expectations: repositoryGuardExpectations(repository, (kind, scope) =>
    environmentFor(kind, scope, { subprocess: gitOnly, sandbox }),
  ),
});
