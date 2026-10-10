import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalysisReportSchema, RunSummarySchema, validate } from '@multiagentos/contracts';
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
    credentials: { apiKeyFor: () => undefined },
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
    const finished = interaction.events.at(-1);
    expect(finished).toMatchObject({ type: 'RunFinished', closeReason: 'COMPLETED' });
    if (finished?.type !== 'RunFinished') return;
    if (!('runSummaryRef' in finished)) throw new Error('Expected a persisted RunSummary');
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

  it('fails fast while a product part is not implemented', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-'));
    roots.push(dataDir);
    await expect(
      composeSystem({
        config: { ...defaultSystemConfig(), dataDir },
        terminal: createFakeTerminal(),
        credentials: { apiKeyFor: () => undefined },
      }),
    ).rejects.toThrow('NOT_IMPLEMENTED');
  });
});
