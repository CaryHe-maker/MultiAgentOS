import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnalysisReportSchema,
  ContextPackSchema,
  MEDIA_TYPES,
  RunSummarySchema,
  newId,
  validate,
  type PersistencePort,
} from '@multiagentos/contracts';
import {
  createFakeExecutorRegistry,
  createFakeGateway,
  createFakeKernelCore,
  createFakeSupervisor,
  createFakeTerminal,
  createFakeUserInteraction,
  createFakeWorkflow,
  type FakeKernelOptions,
  type FakeUserInteractionModule,
  type FakeWorkflowModule,
} from '@multiagentos/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSystemConfig } from '../config/system-config.js';
import { composeSystem } from './compose-system.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The whole system with every Module and the ExecutorSet replaced by its fake. */
async function fakeSystem(kernel: FakeKernelOptions = {}, answer: 'YES' | 'NO' = 'YES') {
  const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-'));
  roots.push(dataDir);
  let workflow: FakeWorkflowModule | undefined;
  let interaction: FakeUserInteractionModule | undefined;
  const system = await composeSystem({
    config: { ...defaultSystemConfig(), dataDir },
    terminal: createFakeTerminal(),
    credentials: { apiKeyFor: () => 'offline-fake-placeholder' },
    parts: {
      createGateway: createFakeGateway(),
      createKernelCore: createFakeKernelCore(kernel),
      createSupervisor: createFakeSupervisor(),
      createExecutorRegistry: () => createFakeExecutorRegistry(),
      createWorkflow: (deps) => (workflow = createFakeWorkflow()(deps)),
      createUserInteraction: (deps) => (interaction = createFakeUserInteraction({ answer })(deps)),
    },
  });
  if (workflow === undefined || interaction === undefined) throw new Error('parts were not built');
  return { system, workflow, interaction, dataDir };
}

const command = { goal: 'Explain the README.', repositoryPath: tmpdir(), details: false };

describe('fake vertical chain', () => {
  it('runs fake Workflow and UserInteraction through the real Kernel core and Supervisor', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-'));
    const repository = await mkdtemp(join(tmpdir(), 'multiagentos-repo-'));
    roots.push(dataDir, repository);
    const system = await composeSystem({
      config: { ...defaultSystemConfig(), dataDir },
      terminal: createFakeTerminal(),
      credentials: { apiKeyFor: () => 'offline-fake-placeholder' },
      parts: {
        createExecutorRegistry: () => createFakeExecutorRegistry(),
        createWorkflow: createFakeWorkflow(),
        createUserInteraction: createFakeUserInteraction(),
      },
    });
    await system.start();
    expect(await system.userInteraction.analyze({ ...command, repositoryPath: repository })).toBe(
      0,
    );
    await system.whenStopped();

    const [run] = await readdir(join(dataDir, 'runs'));
    const audit = await readFile(
      join(dataDir, 'runs', run ?? '', 'kernel-core', 'audit.jsonl'),
      'utf8',
    );
    const auditTypes = audit
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(auditTypes).toEqual(
      expect.arrayContaining(['RUN_STARTED', 'UNIT_ACCEPTED', 'UNIT_REPORTED', 'RUN_CLOSED']),
    );
  }, 60_000);

  it('rolls back real infrastructure when an external module fails to start', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-'));
    roots.push(dataDir);
    const system = await composeSystem({
      config: { ...defaultSystemConfig(), dataDir },
      terminal: createFakeTerminal(),
      credentials: { apiKeyFor: () => 'offline-fake-placeholder' },
      log: () => undefined,
      parts: {
        createWorkflow: (deps) => ({
          ...createFakeWorkflow()(deps),
          start: () => Promise.reject(new Error('workflow start failed')),
        }),
        createUserInteraction: createFakeUserInteraction(),
        createExecutorRegistry: () => createFakeExecutorRegistry(),
      },
    });

    await expect(system.start()).rejects.toThrow('workflow start failed');
    await expect(system.whenStopped()).resolves.toBeUndefined();
    await expect(access(join(dataDir, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('continues stopping real infrastructure after an external module fails to stop', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-'));
    roots.push(dataDir);
    const system = await composeSystem({
      config: { ...defaultSystemConfig(), dataDir },
      terminal: createFakeTerminal(),
      credentials: { apiKeyFor: () => 'offline-fake-placeholder' },
      log: () => undefined,
      parts: {
        createWorkflow: (deps) => ({
          ...createFakeWorkflow()(deps),
          stop: () => Promise.reject(new Error('workflow stop failed')),
        }),
        createUserInteraction: createFakeUserInteraction(),
        createExecutorRegistry: () => createFakeExecutorRegistry(),
      },
    });

    await system.start();
    const report = await system.shutdown();
    expect(report.intent).toBe('FAULT');
    expect(report.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ moduleId: 'workflow', state: 'STOP_FAILED' }),
        expect.objectContaining({ moduleId: 'fabric', state: 'STOPPED' }),
      ]),
    );
  });

  it('gives Core and Workflow distinct namespace-limited persistence ports', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-'));
    roots.push(dataDir);
    let corePersistence: PersistencePort | undefined;
    let workflowPersistence: PersistencePort | undefined;
    await composeSystem({
      config: { ...defaultSystemConfig(), dataDir },
      terminal: createFakeTerminal(),
      credentials: { apiKeyFor: () => 'offline-fake-placeholder' },
      parts: {
        createGateway: createFakeGateway(),
        createKernelCore: (deps) => {
          corePersistence = deps.persistence;
          return createFakeKernelCore()(deps);
        },
        createSupervisor: createFakeSupervisor(),
        createExecutorRegistry: () => createFakeExecutorRegistry(),
        createWorkflow: (deps) => {
          workflowPersistence = deps.persistence;
          return createFakeWorkflow()(deps);
        },
        createUserInteraction: createFakeUserInteraction(),
      },
    });
    expect(corePersistence).toBeDefined();
    expect(workflowPersistence).toBeDefined();
    expect(corePersistence).not.toBe(workflowPersistence);
    expect(() => corePersistence?.repository('workflow', 'wfr_123456')).toThrow(
      'Namespace is not owned',
    );
    expect(() => workflowPersistence?.auditLog('kernel-core', 'wfr_123456')).toThrow(
      'Namespace is not owned',
    );
  });

  it('runs createRun to RunFinished through every Unit and shuts down', async () => {
    const { system, workflow, interaction, dataDir } = await fakeSystem();
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(0);
    await system.whenStopped();

    expect(workflow.events.map((event) => event.type)).toEqual([
      'RunStart',
      ...Array.from({ length: 6 }, () => 'UnitReport'),
      'RunClosed',
    ]);
    expect(
      workflow.events.flatMap((event) =>
        event.type === 'UnitReport' ? [event.executionKind] : [],
      ),
    ).toEqual([
      'REPOSITORY_ORIENT',
      'REPOSITORY_SEARCH',
      'FILE_READ',
      'CONTEXT_ASSEMBLE',
      'MODEL',
      'REPORT_PUBLISH',
    ]);
    expect(interaction.events.map((event) => event.type)).toEqual(['RunFinished']);
    const report: unknown = JSON.parse(interaction.reportText ?? 'null');
    expect(validate(AnalysisReportSchema, report)).toMatchObject({ ok: true });

    const [run] = await readdir(join(dataDir, 'runs'));
    // Five Unit artifacts (search and orient differ), the report and the RunSummary.
    const artifacts = join(dataDir, 'runs', run ?? '', 'artifacts');
    expect(await readdir(artifacts)).toHaveLength(7);

    const contextRefs = workflow.events.flatMap((event) =>
      event.type === 'UnitReport' &&
      event.status === 'OK' &&
      event.outputRef?.mediaType === MEDIA_TYPES.contextPack
        ? [event.outputRef]
        : [],
    );
    expect(contextRefs).toHaveLength(3);
    const packs: unknown[] = await Promise.all(
      contextRefs.map(
        async (ref) => JSON.parse(await readFile(join(artifacts, ref.sha256), 'utf8')) as unknown,
      ),
    );
    for (const pack of packs) expect(validate(ContextPackSchema, pack)).toMatchObject({ ok: true });
    expect(packs.map((pack) => (pack as { operation: string }).operation).sort()).toEqual([
      'ASSEMBLE',
      'ORIENT',
      'SEARCH',
    ]);

    const finished = interaction.events.at(-1);
    expect(finished).toMatchObject({ type: 'RunFinished', closeReason: 'COMPLETED' });
    if (finished?.type !== 'RunFinished' || finished.closeReason !== 'COMPLETED') return;
    expect(finished.reportRef).toMatchObject({ mediaType: MEDIA_TYPES.analysisReport });
    if (!('runSummaryRef' in finished)) throw new Error('Expected a persisted RunSummary');
    expect(finished.runSummaryRef).toMatchObject({ mediaType: MEDIA_TYPES.runSummary });
    const summary: unknown = JSON.parse(
      await readFile(join(artifacts, finished.runSummaryRef.sha256), 'utf8'),
    );
    expect(validate(RunSummarySchema, summary)).toMatchObject({ ok: true });
    expect(summary).toMatchObject({ units: { submitted: 6, ok: 6, notDelivered: 0 } });
  });

  it('asks for authorization once and continues after YES', async () => {
    const { system, workflow, interaction } = await fakeSystem({ authorization: 'ASK' });
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(0);
    await system.whenStopped();
    expect(interaction.events.map((event) => event.type)).toEqual([
      'AuthorizationRequest',
      'AuthorizationResolved',
      'RunFinished',
    ]);
    expect(workflow.events.at(-1)).toMatchObject({ type: 'RunClosed', closeReason: 'COMPLETED' });
  });

  it('ends as FAILED with USER_DECLINED after NO', async () => {
    const { system, workflow } = await fakeSystem({ authorization: 'ASK' }, 'NO');
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(1);
    await system.whenStopped();
    expect(workflow.events.at(-1)).toMatchObject({
      type: 'RunClosed',
      closeReason: 'FAILED',
      failure: { code: 'USER_DECLINED', source: 'WORKFLOW' },
    });
  });

  it('resolves the question as TIMED_OUT, which counts as a refusal', async () => {
    const { system, workflow, interaction } = await fakeSystem({ authorization: 'TIMEOUT' });
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(1);
    await system.whenStopped();
    expect(interaction.events.slice(0, 2)).toMatchObject([
      { type: 'AuthorizationRequest' },
      { type: 'AuthorizationResolved', resolution: 'TIMED_OUT' },
    ]);
    expect(workflow.events.at(-1)).toMatchObject({
      type: 'RunClosed',
      failure: { code: 'USER_DECLINED' },
    });
  });

  it('rejects createRun when scripted, so that no run exists', async () => {
    const { system, workflow, interaction } = await fakeSystem({
      rejectCreateRun: 'REPOSITORY_INVALID',
    });
    await system.start();
    expect(await system.userInteraction.analyze(command)).toBe(4);
    await system.whenStopped();
    expect(workflow.events).toEqual([]);
    expect(interaction.events).toEqual([]);
  });

  it('ends the run by itself as RUN_TIMEOUT or VIOLATION', async () => {
    const timedOut = await fakeSystem({
      unitScript: ({ index }) => (index === 2 ? { end: 'RUN_TIMEOUT' } : undefined),
    });
    await timedOut.system.start();
    expect(await timedOut.system.userInteraction.analyze(command)).toBe(2);
    await timedOut.system.whenStopped();
    const closed = timedOut.workflow.events.at(-1);
    expect(closed).toMatchObject({ type: 'RunClosed', closeReason: 'RUN_TIMEOUT' });
    expect(closed).not.toHaveProperty('failure');
    expect(timedOut.workflow.events.filter((event) => event.type === 'UnitReport')).toHaveLength(2);

    const violated = await fakeSystem({
      unitScript: ({ executionKind }) =>
        executionKind === 'FILE_READ' ? { end: 'PATH_ESCAPE' } : undefined,
    });
    await violated.system.start();
    expect(await violated.system.userInteraction.analyze(command)).toBe(3);
    await violated.system.whenStopped();
    expect(violated.interaction.events.at(-1)).toMatchObject({
      type: 'RunFinished',
      closeReason: 'VIOLATION',
      failure: { code: 'PATH_ESCAPE', category: 'INTEGRITY', source: 'KERNEL' },
    });
  });

  it('reports a RunSummary that could not be saved, and unknown effects', async () => {
    const unknownEffects = [
      {
        unitAttemptId: newId('una'),
        executionId: newId('exe'),
        executionKind: 'MODEL',
        effect: 'MODEL_REQUEST_UNCONFIRMED',
      },
    ] as const;
    const { system, workflow, interaction } = await fakeSystem({
      summaryWriteFails: true,
      unknownEffects,
    });
    await system.start();
    // The run completed, but the exit code is at least 1 (UserInteraction 3).
    expect(await system.userInteraction.analyze(command)).toBe(1);
    await system.whenStopped();
    for (const end of [workflow.events.at(-1), interaction.events.at(-1)]) {
      expect(end).toMatchObject({
        closeReason: 'COMPLETED',
        finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
        unknownEffects,
      });
      expect(end).not.toHaveProperty('runSummaryRef');
    }
    expect(interaction.reportText).toBeDefined();
  });

  it('fails fast while a product part is not implemented', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-'));
    roots.push(dataDir);
    await expect(
      composeSystem({
        config: { ...defaultSystemConfig(), dataDir },
        terminal: createFakeTerminal(),
        credentials: { apiKeyFor: () => 'offline-fake-placeholder' },
      }),
    ).rejects.toThrow('NOT_IMPLEMENTED');
  });

  it('kills the injected runner when composition fails after creating it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-'));
    roots.push(dataDir);
    const killed: string[] = [];
    const subprocess = {
      run: () => Promise.resolve({ exitCode: 0, signal: null, stdout: '', truncated: false }),
      killAll: () => void killed.push('kill'),
    };

    await expect(
      composeSystem({
        config: { ...defaultSystemConfig(), dataDir },
        terminal: createFakeTerminal(),
        credentials: { apiKeyFor: () => 'offline-fake-placeholder' },
        subprocess,
        parts: {
          createKernelCore: () => {
            throw new Error('factory failed');
          },
        },
      }),
    ).rejects.toThrow('factory failed');
    expect(killed).toEqual(['kill']);
  });

  it('rejects invalid bootMs after construction and kills the runner', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-'));
    roots.push(dataDir);
    const killed: string[] = [];
    const subprocess = {
      run: () => Promise.resolve({ exitCode: 0, signal: null, stdout: '', truncated: false }),
      killAll: () => void killed.push('kill'),
    };

    await expect(
      composeSystem({
        config: { ...defaultSystemConfig(), dataDir },
        terminal: createFakeTerminal(),
        credentials: { apiKeyFor: () => 'offline-fake-placeholder' },
        subprocess,
        timeouts: { bootMs: 0 },
        parts: {
          createGateway: createFakeGateway(),
          createKernelCore: createFakeKernelCore(),
          createSupervisor: createFakeSupervisor(),
          createExecutorRegistry: () => createFakeExecutorRegistry(),
          createWorkflow: createFakeWorkflow(),
          createUserInteraction: createFakeUserInteraction(),
        },
      }),
    ).rejects.toThrow('bootMs');
    expect(killed).toEqual(['kill']);
  });
});
