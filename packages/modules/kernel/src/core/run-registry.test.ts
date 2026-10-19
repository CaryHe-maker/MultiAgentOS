import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BoundaryContext,
  ExecutionFact,
  GatewayForward,
  SyscallAck,
} from '@multiagentos/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreAuditEntry } from './audit.js';
import { RunRegistry, type RunRequestHandler, type RunResponse } from './run-registry.js';
import type { RunState } from './run-state.js';

const roots: string[] = [];
const context: BoundaryContext = {
  tenantId: 'local',
  projectId: 'local',
  correlationId: 'cor_123456',
};

interface HandlerCall {
  readonly forward: GatewayForward;
  readonly run: RunState;
}

function handler(): {
  readonly impl: RunRequestHandler;
  readonly calls: HandlerCall[];
  readonly reports: ExecutionFact[];
} {
  const calls: HandlerCall[] = [];
  const reports: ExecutionFact[] = [];
  return {
    calls,
    reports,
    impl: {
      handleForward: (forward, _context, run): Promise<RunResponse> => {
        calls.push({ forward, run });
        const requestId = 'requestId' in forward.request ? forward.request.requestId : 'req_123456';
        return Promise.resolve({ requestId, outcome: 'ACCEPTED' } satisfies SyscallAck);
      },
      report: (fact): Promise<void> => {
        reports.push(fact);
        return Promise.resolve();
      },
    },
  };
}

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

function createForward(
  requestId: string,
  repositoryPath: string,
  workflowRunId = 'wfr_123456',
): Extract<GatewayForward, { requestType: 'createRun' }> {
  return {
    caller: 'user-interaction',
    requestType: 'createRun',
    request: { requestId, goal: 'explain the repository', repositoryPath },
    workflowRunId,
  };
}

function registerForward(workflowRunId: string, requestId = 'req_reg123'): GatewayForward {
  return {
    caller: 'workflow',
    requestType: 'registerAgentRun',
    request: {
      requestId,
      workflowRunId,
      agentRunId: 'agr_123456',
      agentRef: { kind: 'AGENT', id: 'planner', version: 'v0.1.0', digest: 'a'.repeat(64) },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RunRegistry createRun', () => {
  it('creates the single run, records RUN_STARTED and routes run-scoped messages', async () => {
    const repository = await tempDir('kernel-repo-');
    const dataDir = await tempDir('kernel-data-');
    const fake = handler();
    const entries: CoreAuditEntry[] = [];
    const registry = new RunRegistry({
      dataDir,
      handler: fake.impl,
      audit: {
        append: (entry) => {
          entries.push(entry);
          return Promise.resolve();
        },
      },
      now: () => new Date('2026-10-19T00:00:00.000Z'),
    });

    await expect(
      registry.handleForward(createForward('req_create1', repository), context),
    ).resolves.toEqual({
      requestId: 'req_create1',
      outcome: 'ACCEPTED',
      workflowRunId: 'wfr_123456',
    });
    expect(registry.hasCreatedRun).toBe(true);
    expect(entries).toEqual([
      {
        at: '2026-10-19T00:00:00.000Z',
        workflowRunId: 'wfr_123456',
        type: 'RUN_STARTED',
      },
    ]);

    await registry.handleForward(registerForward('wfr_123456'), context);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.run).toMatchObject({
      workflowRunId: 'wfr_123456',
      correlationId: 'cor_123456',
      runState: 'RUNNING',
      runEpoch: 1,
      startedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(fake.calls[0]?.run.repositoryRoot).toBe(repository);
  });

  it('replays the original response for the same requestId and rejects different content', async () => {
    const repository = await tempDir('kernel-repo-');
    const dataDir = await tempDir('kernel-data-');
    const fake = handler();
    const registry = new RunRegistry({ dataDir, handler: fake.impl });

    await registry.handleForward(createForward('req_replay1', repository, 'wfr_111111'), context);
    await expect(
      registry.handleForward(createForward('req_replay1', repository, 'wfr_222222'), context),
    ).resolves.toEqual({
      requestId: 'req_replay1',
      outcome: 'ACCEPTED',
      workflowRunId: 'wfr_111111',
    });
    await expect(
      registry.handleForward(
        {
          ...createForward('req_replay1', repository, 'wfr_333333'),
          request: {
            requestId: 'req_replay1',
            goal: 'a different goal',
            repositoryPath: repository,
          },
        },
        context,
      ),
    ).resolves.toMatchObject({
      requestId: 'req_replay1',
      outcome: 'REJECTED',
      issuer: 'CORE',
      reasonCode: 'REQUEST_CONFLICT',
    });
    expect(registry.hasCreatedRun).toBe(true);
  });

  it('allows only one run in the process and remembers a rejected create request', async () => {
    const repository = await tempDir('kernel-repo-');
    const dataDir = await tempDir('kernel-data-');
    const registry = new RunRegistry({ dataDir, handler: handler().impl });

    await registry.handleForward(createForward('req_first1', repository, 'wfr_111111'), context);
    const second = createForward('req_second', repository, 'wfr_222222');
    await expect(registry.handleForward(second, context)).resolves.toMatchObject({
      reasonCode: 'RUN_LIMIT',
      issuer: 'CORE',
    });
    await expect(registry.handleForward(second, context)).resolves.toMatchObject({
      reasonCode: 'RUN_LIMIT',
    });
  });

  it.each([
    ['a relative path', 'relative/repository', 'relative'],
    ['a missing path', '/does/not/exist/multiagentos', 'missing'],
  ])('rejects %s', async (_label, repositoryPath) => {
    const dataDir = await tempDir('kernel-data-');
    const registry = new RunRegistry({ dataDir, handler: handler().impl });
    await expect(
      registry.handleForward(createForward('req_invalid1', repositoryPath), context),
    ).resolves.toMatchObject({
      outcome: 'REJECTED',
      issuer: 'CORE',
      reasonCode: 'REPOSITORY_INVALID',
    });
  });

  it('resolves repository symlinks and rejects a link that resolves inside dataDir', async () => {
    const dataDir = await tempDir('kernel-data-');
    const repository = await tempDir('kernel-repo-');
    const linkRoot = await tempDir('kernel-link-');
    const link = join(linkRoot, 'repository-link');
    await symlink(repository, link, 'dir');

    const registry = new RunRegistry({ dataDir, handler: handler().impl });
    await expect(
      registry.handleForward(createForward('req_link001', link), context),
    ).resolves.toMatchObject({ outcome: 'ACCEPTED', workflowRunId: 'wfr_123456' });

    const inner = join(dataDir, 'inner');
    await mkdir(inner);
    const innerLink = join(linkRoot, 'inner-link');
    await symlink(inner, innerLink, 'dir');
    const second = new RunRegistry({ dataDir, handler: handler().impl });
    await expect(
      second.handleForward(createForward('req_link002', innerLink), context),
    ).resolves.toMatchObject({ reasonCode: 'REPOSITORY_INVALID' });
  });

  it('rejects a regular file and both dataDir containment directions', async () => {
    const dataDir = await tempDir('kernel-data-');
    const file = join(await tempDir('kernel-file-'), 'file.txt');
    await writeFile(file, 'content');

    const registry = new RunRegistry({ dataDir, handler: handler().impl });
    await expect(
      registry.handleForward(createForward('req_file123', file), context),
    ).resolves.toMatchObject({ reasonCode: 'REPOSITORY_INVALID' });

    const repository = await tempDir('kernel-repo-');
    const nestedDataDir = join(repository, '.data');
    await mkdir(nestedDataDir);
    const dataInsideRepository = new RunRegistry({
      dataDir: nestedDataDir,
      handler: handler().impl,
    });
    await expect(
      dataInsideRepository.handleForward(createForward('req_nested1', repository), context),
    ).resolves.toMatchObject({ reasonCode: 'REPOSITORY_INVALID' });

    const repositoryInsideDataDir = join(dataDir, 'repository');
    await mkdir(repositoryInsideDataDir);
    const repositoryInData = new RunRegistry({
      dataDir,
      handler: handler().impl,
    });
    await expect(
      repositoryInData.handleForward(
        createForward('req_nested2', repositoryInsideDataDir),
        context,
      ),
    ).resolves.toMatchObject({ reasonCode: 'REPOSITORY_INVALID' });
  });
});

describe('RunRegistry shutdown and tombstone', () => {
  const shutdown = (requestId: string): GatewayForward => ({
    caller: 'user-interaction',
    requestType: 'shutdown',
    request: { requestId },
  });

  it('marks the registry as closing and rejects later createRun requests', async () => {
    const repository = await tempDir('kernel-repo-');
    const dataDir = await tempDir('kernel-data-');
    const registry = new RunRegistry({ dataDir, handler: handler().impl });

    await registry.handleForward(createForward('req_before1', repository), context);
    await expect(registry.handleForward(shutdown('req_shut01'), context)).resolves.toEqual({
      requestId: 'req_shut01',
      outcome: 'ACCEPTED',
    });
    expect(registry.isClosing).toBe(true);
    await expect(
      registry.handleForward(createForward('req_after01', repository, 'wfr_999999'), context),
    ).resolves.toMatchObject({ reasonCode: 'RUN_LIMIT' });
  });

  it('replays shutdown and answers a different shutdown requestId', async () => {
    const dataDir = await tempDir('kernel-data-');
    const registry = new RunRegistry({ dataDir, handler: handler().impl });

    await registry.handleForward(shutdown('req_shut02'), context);
    await expect(registry.handleForward(shutdown('req_shut02'), context)).resolves.toMatchObject({
      requestId: 'req_shut02',
      outcome: 'ACCEPTED',
    });
    await expect(registry.handleForward(shutdown('req_shut03'), context)).resolves.toMatchObject({
      requestId: 'req_shut03',
      outcome: 'ACCEPTED',
    });
  });

  it('starts the handler shutdown and resolves whenClosed', async () => {
    const repository = await tempDir('kernel-repo-');
    const dataDir = await tempDir('kernel-data-');
    const fake = handler();
    let closedRun: RunState | undefined;
    const registry = new RunRegistry({
      dataDir,
      handler: {
        ...fake.impl,
        shutdownRun: (run) => {
          closedRun = run;
          run.runState = 'CLOSED';
          run.closeReason = 'CANCELLED';
          return Promise.resolve();
        },
      },
    });

    await registry.handleForward(createForward('req_shut04', repository), context);
    await expect(registry.handleForward(shutdown('req_shut05'), context)).resolves.toEqual({
      requestId: 'req_shut05',
      outcome: 'ACCEPTED',
    });
    await registry.whenClosed();
    expect(closedRun?.runState).toBe('CLOSED');
    expect(closedRun?.closeReason).toBe('CANCELLED');
  });

  it('aborts the run through the handler with the faultId', async () => {
    const repository = await tempDir('kernel-repo-');
    const dataDir = await tempDir('kernel-data-');
    const fake = handler();
    let abortedFault: string | undefined;
    const registry = new RunRegistry({
      dataDir,
      handler: {
        ...fake.impl,
        abortRun: (run, faultId) => {
          abortedFault = faultId;
          run.runState = 'CLOSED';
          run.closeReason = 'FAILED';
          return Promise.resolve();
        },
      },
    });

    await registry.handleForward(createForward('req_abort01', repository), context);
    await registry.abortAllRuns({ faultId: 'fault-001', deadlineMs: 1_000 });
    expect(abortedFault).toBe('fault-001');
    await expect(
      registry.handleForward(createForward('req_after02', repository, 'wfr_999998'), context),
    ).resolves.toMatchObject({ reasonCode: 'RUN_LIMIT' });
  });

  it('routes unknown runs as RUN_NOT_FOUND and delegates a closed run to the handler', async () => {
    const repository = await tempDir('kernel-repo-');
    const dataDir = await tempDir('kernel-data-');
    const fake = handler();
    const registry = new RunRegistry({ dataDir, handler: fake.impl });

    await expect(
      registry.handleForward(registerForward('wfr_404404'), context),
    ).resolves.toMatchObject({ reasonCode: 'RUN_NOT_FOUND' });

    await registry.handleForward(createForward('req_tomb01', repository), context);
    registry.markClosed('wfr_123456', 'COMPLETED');
    await expect(
      registry.handleForward(registerForward('wfr_123456'), context),
    ).resolves.toMatchObject({
      requestId: 'req_reg123',
      outcome: 'ACCEPTED',
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.run.runState).toBe('CLOSED');
  });
});

describe('RunRegistry execution facts', () => {
  it('routes facts for the live run and ignores them after the run is closed', async () => {
    const repository = await tempDir('kernel-repo-');
    const dataDir = await tempDir('kernel-data-');
    const fake = handler();
    const registry = new RunRegistry({ dataDir, handler: fake.impl });
    await registry.handleForward(createForward('req_facts1', repository), context);

    const fact: ExecutionFact = {
      workflowRunId: 'wfr_123456',
      unitAttemptId: 'una_123456',
      executionId: 'exe_123456',
      runEpoch: 1,
      executionKind: 'MODEL',
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
      retryable: false,
      requestState: 'NOT_SENT',
      startedAt: '2026-10-19T00:00:00.500Z',
      endedAt: '2026-10-19T00:00:01.000Z',
    };
    await registry.report(fact);
    expect(fake.reports).toEqual([fact]);

    registry.markClosed('wfr_123456', 'FAILED');
    await registry.report(fact);
    expect(fake.reports).toEqual([fact]);
  });
});
