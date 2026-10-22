import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnalysisReportSchema,
  MEDIA_TYPES,
  RunSummarySchema,
  newId,
  validate,
  type BoundaryContext,
  type InteractionInboxEvent,
  type KernelToInteractionEvent,
} from '@multiagentos/contracts';
import {
  EXIT_CODES,
  type UserInteractionDeps,
  type UserInteractionModule,
} from '@multiagentos/user-interaction';
import {
  createFakeExecutorRegistry,
  createFakeTerminal,
  createFakeUserInteraction,
  createFakeWorkflow,
  type FakeUserInteractionModule,
  type FakeWorkflowModule,
} from '@multiagentos/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSystemConfig } from '../config/system-config.js';
import { composeSystem, type System } from './compose-system.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const goal = 'Explain the acceptance fixture.';

interface Acceptance {
  readonly system: System;
  readonly dataDir: string;
  readonly repository: string;
  readonly command: { goal: string; repositoryPath: string; details: boolean };
  readonly workflow?: FakeWorkflowModule;
  readonly interaction?: FakeUserInteractionModule;
}

async function realSystem(
  options: {
    answer?: 'YES' | 'NO';
    userInteraction?: (deps: UserInteractionDeps) => UserInteractionModule;
    executors?: () => ReturnType<typeof createFakeExecutorRegistry>;
    authorizationTimeoutMs?: number;
    runTimeoutMs?: number;
    cancelGraceMs?: number;
  } = {},
): Promise<Acceptance> {
  const dataDir = await mkdtemp(join(tmpdir(), 'stage6-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'stage6-repository-'));
  roots.push(dataDir, repository);
  const base = defaultSystemConfig();
  const kernel = {
    ...base.kernel,
    ...(options.authorizationTimeoutMs === undefined
      ? {}
      : { authorizationTimeoutMs: options.authorizationTimeoutMs }),
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
    ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
  };
  let workflow: FakeWorkflowModule | undefined;
  let interaction: FakeUserInteractionModule | undefined;
  const system = await composeSystem({
    config: { ...base, dataDir, kernel },
    terminal: createFakeTerminal(),
    credentials: { apiKeyFor: () => 'offline-acceptance' },
    parts: {
      createExecutorRegistry: options.executors ?? (() => createFakeExecutorRegistry()),
      createWorkflow: (deps) => (workflow = createFakeWorkflow()(deps)),
      createUserInteraction:
        options.userInteraction ??
        ((deps) =>
          (interaction = createFakeUserInteraction(
            options.answer === undefined ? {} : { answer: options.answer },
          )(deps))),
    },
  });
  return {
    system,
    dataDir,
    repository,
    command: { goal, repositoryPath: repository, details: false },
    ...(workflow === undefined ? {} : { workflow }),
    ...(interaction === undefined ? {} : { interaction }),
  };
}

function timeoutUserInteraction(): (deps: UserInteractionDeps) => UserInteractionModule {
  return (deps) => {
    let resolveFinished: (event: KernelToInteractionEvent) => void = () => undefined;
    const finished = new Promise<KernelToInteractionEvent>((resolve) => {
      resolveFinished = resolve;
    });
    const context = (workflowRunId?: string): BoundaryContext => ({
      correlationId: newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      ...(workflowRunId === undefined ? {} : { workflowRunId }),
    });
    return {
      manifest: {
        moduleId: 'user-interaction',
        version: '0.0.0-acceptance',
        dependencies: ['gateway'],
      },
      inbox: {
        deliver: (event: InteractionInboxEvent) => {
          if (event.event.type === 'RunFinished') resolveFinished(event.event);
          return Promise.resolve();
        },
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      health: () =>
        Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: [] }),
      analyze: async (command) => {
        const created = await deps.gateway.createRun(
          {
            requestId: newId('req'),
            goal: command.goal,
            repositoryPath: command.repositoryPath,
          },
          context(),
        );
        if (created.outcome === 'REJECTED') return 4;
        const end = await finished;
        await deps.gateway.shutdown({ requestId: newId('req') }, context());
        return EXIT_CODES[end.type === 'RunFinished' ? end.closeReason : 'FAILED'];
      },
    };
  };
}

function cancelUserInteraction(): (deps: UserInteractionDeps) => UserInteractionModule {
  return (deps) => {
    let resolveFinished: (event: KernelToInteractionEvent) => void = () => undefined;
    const finished = new Promise<KernelToInteractionEvent>((resolve) => {
      resolveFinished = resolve;
    });
    const context = (workflowRunId?: string): BoundaryContext => ({
      correlationId: newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      ...(workflowRunId === undefined ? {} : { workflowRunId }),
    });
    return {
      manifest: {
        moduleId: 'user-interaction',
        version: '0.0.0-acceptance',
        dependencies: ['gateway'],
      },
      inbox: {
        deliver: (event: InteractionInboxEvent) => {
          if (event.event.type === 'RunFinished') resolveFinished(event.event);
          return Promise.resolve();
        },
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      health: () =>
        Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: [] }),
      analyze: async (command) => {
        const created = await deps.gateway.createRun(
          {
            requestId: newId('req'),
            goal: command.goal,
            repositoryPath: command.repositoryPath,
          },
          context(),
        );
        if (created.outcome === 'REJECTED') return 4;
        await deps.gateway.cancelRun(
          { requestId: newId('req'), workflowRunId: created.workflowRunId },
          context(created.workflowRunId),
        );
        const end = await finished;
        await deps.gateway.shutdown({ requestId: newId('req') }, context());
        return EXIT_CODES[end.type === 'RunFinished' ? end.closeReason : 'FAILED'];
      },
    };
  };
}

function neverExecutor(): () => ReturnType<typeof createFakeExecutorRegistry> {
  return () => ({
    ...createFakeExecutorRegistry(),
    REPOSITORY_ORIENT: {
      executionKind: 'REPOSITORY_ORIENT',
      execute: () => new Promise(() => undefined),
    },
  });
}

function violationExecutor(): () => ReturnType<typeof createFakeExecutorRegistry> {
  return () => ({
    ...createFakeExecutorRegistry(),
    FILE_READ: {
      executionKind: 'FILE_READ',
      execute: () => Promise.resolve({ outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' }),
    },
  });
}

describe('Stage6 Kernel and infrastructure acceptance', () => {
  it('runs the real Kernel and infrastructure through the full read-only path', async () => {
    const { system, dataDir, command, workflow, interaction } = await realSystem();
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(EXIT_CODES.COMPLETED);
    await system.whenStopped();

    expect(workflow?.events.map((event) => event.type)).toEqual([
      'RunStart',
      ...Array.from({ length: 6 }, () => 'UnitReport'),
      'RunClosed',
    ]);
    expect(interaction?.events.map((event) => event.type)).toEqual([
      'AuthorizationRequest',
      'AuthorizationResolved',
      'RunFinished',
    ]);

    const [run] = await readdir(join(dataDir, 'runs'));
    expect(run).toBeDefined();
    const runDir = join(dataDir, 'runs', run ?? '');
    const artifacts = join(runDir, 'artifacts');
    expect(await readdir(artifacts)).toHaveLength(7);
    const audit = await readFile(join(runDir, 'kernel-core', 'audit.jsonl'), 'utf8');
    const auditTypes = audit
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(auditTypes).toEqual(
      expect.arrayContaining(['RUN_STARTED', 'UNIT_ACCEPTED', 'UNIT_REPORTED', 'RUN_CLOSED']),
    );

    const finished = interaction?.events.at(-1);
    if (finished?.type !== 'RunFinished' || finished.closeReason !== 'COMPLETED')
      throw new Error('Expected a completed RunFinished');
    expect(finished.reportRef).toMatchObject({ mediaType: MEDIA_TYPES.analysisReport });
    if (!('runSummaryRef' in finished)) throw new Error('Expected a persisted RunSummary');
    expect(finished.runSummaryRef).toMatchObject({ mediaType: MEDIA_TYPES.runSummary });

    const report: unknown = JSON.parse(interaction?.reportText ?? 'null');
    expect(validate(AnalysisReportSchema, report)).toMatchObject({ ok: true });
    const summary: unknown = JSON.parse(
      await readFile(join(artifacts, finished.runSummaryRef.sha256), 'utf8'),
    );
    expect(validate(RunSummarySchema, summary)).toMatchObject({ ok: true });
    expect(summary).toMatchObject({
      closeReason: 'COMPLETED',
      units: { submitted: 6, ok: 6, rejected: 0, failed: 0, notDelivered: 0 },
      model: { requests: 1, finalCallUsed: false },
      unknownEffects: [],
    });
  });

  it('records authorization refusal as a failed run', async () => {
    const { system, command } = await realSystem({ answer: 'NO' });
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(EXIT_CODES.FAILED);
    await system.whenStopped();
  });

  it('times out an unanswered authorization and treats it as refusal', async () => {
    const { system, command } = await realSystem({
      authorizationTimeoutMs: 20,
      userInteraction: timeoutUserInteraction(),
    });
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(EXIT_CODES.FAILED);
    await system.whenStopped();
  });

  it('closes a run on cancellation with the real Kernel and infrastructure', async () => {
    const { system, command } = await realSystem({
      userInteraction: cancelUserInteraction(),
    });
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(EXIT_CODES.CANCELLED);
    await system.whenStopped();
  });

  it('closes a run on run timeout with the real Kernel and infrastructure', async () => {
    const { system, command } = await realSystem({
      runTimeoutMs: 20,
      cancelGraceMs: 20,
      executors: neverExecutor(),
    });
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(EXIT_CODES.RUN_TIMEOUT);
    await system.whenStopped();
  });

  it('closes a run on a violation from a real execution fact', async () => {
    const { system, command } = await realSystem({ executors: violationExecutor() });
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(EXIT_CODES.VIOLATION);
    await system.whenStopped();
  });
});
