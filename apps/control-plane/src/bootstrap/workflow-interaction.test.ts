import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createNodeTerminal, parseCli, runParsedCli } from '@multiagentos/cli';
import {
  AnalysisReportSchema,
  RunSummarySchema,
  createM1ProtocolRegistry,
  newId,
  assertValid,
  type AnalysisReport,
  type ArtifactRef,
  type ExecutorRegistry,
  type KernelToInteractionEvent,
  type KernelToWorkflowEvent,
  type SubmitUnitRequest,
  type RunSummary,
} from '@multiagentos/contracts';
import {
  createFakeExecutorRegistry,
  createFakeGateway,
  createFakeKernelCore,
  createFakeSupervisor,
  createFakeTerminal,
  defaultModelScript,
  type FakeKernelOptions,
  type ModelScript,
} from '@multiagentos/testing';
import { createUserInteraction, type TerminalPort } from '@multiagentos/user-interaction';
import { createWorkflow, type WorkflowDeps } from '@multiagentos/workflow';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSystemConfig } from '../config/system-config.js';
import { composeSystem } from './compose-system.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Scenario {
  readonly kernel?: FakeKernelOptions;
  readonly terminal?: TerminalPort;
  readonly executors?: Partial<ExecutorRegistry>;
  readonly workflow?: (deps: WorkflowDeps) => WorkflowDeps;
  readonly details?: boolean;
  readonly modelScript?: ModelScript;
  readonly viaCli?: boolean;
  readonly allowInteractionStopFailure?: boolean;
}

/** Uses real consumers and public ports; fake Core outcomes do not certify Core policy. */
async function runScenario(scenario: Scenario = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-workflow-interaction-'));
  roots.push(dataDir);
  const terminal = scenario.terminal ?? createFakeTerminal('YES');
  const command = {
    goal: '分析仓库并核验来源',
    repositoryPath: tmpdir(),
    details: scenario.details ?? false,
  };
  const parsed = scenario.viaCli
    ? await parseCli(
        [
          'analyze',
          '--repo',
          command.repositoryPath,
          ...(command.details ? ['--details'] : []),
          command.goal,
        ],
        terminal,
      )
    : undefined;
  if (parsed?.ok === false) throw new Error('Expected a valid command in the system fixture');
  const written: string[] = [];
  const workflowEvents: KernelToWorkflowEvent[] = [];
  const interactionEvents: KernelToInteractionEvent[] = [];
  const calls: string[] = [];
  const submissions: SubmitUnitRequest[] = [];
  let workflowRunId = '';
  const system = await composeSystem({
    config: { ...defaultSystemConfig(), dataDir },
    terminal: {
      ...terminal,
      write: (text) => {
        written.push(text);
        terminal.write(text);
      },
    },
    credentials: { apiKeyFor: () => undefined },
    log: () => {},
    parts: {
      createKernelCore: createFakeKernelCore(scenario.kernel),
      createGateway: createFakeGateway(),
      createSupervisor: createFakeSupervisor(),
      createExecutorRegistry: () =>
        createFakeExecutorRegistry(scenario.modelScript, scenario.executors),
      createWorkflow: (original) => {
        const deps = scenario.workflow?.(original) ?? original;
        const workflow = createWorkflow({
          ...deps,
          gateway: {
            ...deps.gateway,
            registerAgentRun: (request, context) => {
              calls.push('register');
              return deps.gateway.registerAgentRun(request, context);
            },
            submitUnit: (request, context) => {
              calls.push(`submit:${request.unitRef.id}`);
              submissions.push(request);
              return deps.gateway.submitUnit(request, context);
            },
            endAgentRun: (request, context) => {
              calls.push('end');
              return deps.gateway.endAgentRun(request, context);
            },
            closeRun: (request, context) => {
              calls.push(`close:${request.outcome}`);
              return deps.gateway.closeRun(request, context);
            },
          },
        });
        const deliver = workflow.inbox.deliver.bind(workflow.inbox);
        workflow.inbox.deliver = (envelope) => {
          workflowRunId = envelope.workflowRunId;
          workflowEvents.push(envelope.event);
          return deliver(envelope);
        };
        return workflow;
      },
      createUserInteraction: (deps) => {
        const interaction = createUserInteraction(deps);
        const deliver = interaction.inbox.deliver.bind(interaction.inbox);
        interaction.inbox.deliver = (envelope) => {
          interactionEvents.push(envelope.event);
          return deliver(envelope);
        };
        return interaction;
      },
    },
  });
  await system.start();
  const exitCode = await system.run((interaction) =>
    parsed?.ok ? runParsedCli(parsed.command, interaction) : interaction.analyze(command),
  );
  const stop = await system.shutdown();
  for (const entry of stop.modules)
    expect(
      scenario.allowInteractionStopFailure && entry.moduleId === 'user-interaction'
        ? ['STOPPED', 'STOP_FAILED']
        : ['STOPPED'],
    ).toContain(entry.state);
  for (const request of submissions) {
    if (!('steps' in request.input)) continue;
    const steps = request.input.steps;
    const answered = new Set(
      steps.flatMap((step) =>
        (step.kind === 'TOOL_RESULT' || step.kind === 'FEEDBACK') &&
        'toolCallId' in step &&
        step.toolCallId !== undefined
          ? [step.toolCallId]
          : [],
      ),
    );
    for (const step of steps)
      if (step.kind === 'MODEL_TURN')
        for (const call of step.toolCalls) expect(answered.has(call.toolCallId)).toBe(true);
  }
  const artifact = (ref: ArtifactRef) =>
    readFile(join(dataDir, 'runs', workflowRunId, 'artifacts', ref.sha256), 'utf8');
  const finished = interactionEvents.find((event) => event.type === 'RunFinished');
  const record: unknown =
    finished === undefined
      ? undefined
      : JSON.parse(
          await readFile(
            join(dataDir, 'runs', workflowRunId, 'workflow', `${workflowRunId}.json`),
            'utf8',
          ),
        );
  if (finished !== undefined)
    expect(record).toMatchObject({ id: workflowRunId, closeReason: finished.closeReason });
  const report = async () => {
    if (finished?.closeReason !== 'COMPLETED') throw new Error('No completed report');
    return assertValid<AnalysisReport>(
      AnalysisReportSchema,
      JSON.parse(await artifact(finished.reportRef)),
    );
  };
  const summary = async () => {
    if (finished === undefined || !('runSummaryRef' in finished)) throw new Error('No run summary');
    return assertValid<RunSummary>(
      RunSummarySchema,
      JSON.parse(await artifact(finished.runSummaryRef)),
    );
  };
  return {
    exitCode,
    calls,
    submissions,
    workflowEvents,
    interactionEvents,
    finished,
    text: written.join(''),
    stop,
    report,
    summary,
    record,
    audit: () => readFile(join(dataDir, 'runs', workflowRunId, 'workflow', 'audit.jsonl'), 'utf8'),
  };
}

describe('Product Workflow and UserInteraction through the composition root', () => {
  it.each([
    { ending: 'COMPLETED', code: 70 },
    { ending: 'RUN_TIMEOUT', code: 2 },
    { ending: 'CANCELLED', code: 130 },
  ] as const)(
    'retains the $ending exit code when terminal release fails',
    async ({ ending, code }) => {
      const terminal = createFakeTerminal('YES');
      const subscribe = terminal.onInterrupt.bind(terminal);
      let releases = 0;
      terminal.onInterrupt = (handler) => {
        const remove = subscribe(handler);
        return () => {
          remove();
          releases++;
          throw new Error('Terminal release failed');
        };
      };
      if (ending === 'CANCELLED')
        terminal.askYesNo = () => {
          queueMicrotask(() => terminal.interrupt());
          return Promise.resolve(undefined);
        };
      const run = await runScenario({
        terminal,
        allowInteractionStopFailure: true,
        kernel: {
          ...(ending === 'CANCELLED' ? { authorization: 'ASK' as const } : {}),
          ...(ending === 'RUN_TIMEOUT'
            ? { unitScript: () => ({ end: 'RUN_TIMEOUT' as const }) }
            : {}),
        },
      });
      expect(run.exitCode).toBe(code);
      expect(run.finished?.closeReason).toBe(ending);
      expect(run.stop.faults.length).toBeGreaterThan(0);
      expect(releases).toBe(1);
      expect(run.text).not.toContain('Terminal release failed');
    },
  );

  it.each(['YES', 'INVALID_THEN_NO', 'INPUT_ERROR', 'OUTPUT_ERROR', 'INTERRUPT'] as const)(
    'handles real CLI terminal input through public entries: %s',
    async (mode) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const signalHandlers = process.listeners('SIGINT');
      let hasDrivenInput = false;
      output.on('data', (chunk: Buffer) => {
        if (hasDrivenInput || !chunk.toString('utf8').includes('[y/n]')) return;
        hasDrivenInput = true;
        queueMicrotask(() => {
          if (mode === 'YES') input.write('y\n');
          else if (mode === 'INVALID_THEN_NO') input.write('maybe\nn\n');
          else if (mode === 'INPUT_ERROR') input.emit('error', new Error('Input stream failed'));
          else if (mode === 'OUTPUT_ERROR') output.emit('error', new Error('Output stream failed'));
          else {
            const handlers = process
              .listeners('SIGINT')
              .filter((handler) => !signalHandlers.includes(handler));
            expect(handlers).toHaveLength(1);
            handlers[0]?.('SIGINT');
          }
        });
      });
      try {
        const run = await runScenario({
          kernel: { authorization: 'ASK' },
          terminal: createNodeTerminal(input, output),
          viaCli: true,
        });
        expect(hasDrivenInput).toBe(true);
        expect(input.listenerCount('data')).toBe(0);
        expect(process.listeners('SIGINT')).toEqual(signalHandlers);
        if (mode === 'INPUT_ERROR' || mode === 'OUTPUT_ERROR') {
          expect(run.exitCode).toBe(70);
          expect(run.stop.faults.length).toBeGreaterThan(0);
          expect(run.calls).not.toContain('submit:report-publish');
        } else if (mode === 'INTERRUPT') {
          expect(run.exitCode).toBe(130);
          expect(run.finished?.closeReason).toBe('CANCELLED');
        } else {
          expect(run.exitCode).toBe(0);
          expect(run.stop.faults).toEqual([]);
          expect(await run.report()).toMatchObject({ degraded: false });
          if (mode === 'YES') expect(run.calls).toContain('submit:file-read');
          else expect(run.text).toContain('未获仓库读取授权');
        }
      } finally {
        input.destroy();
        output.destroy();
      }
    },
  );

  it('hands off, verifies sources and presents the persisted report and details', async () => {
    const run = await runScenario({ details: true });
    expect(run.exitCode).toBe(0);
    expect(run.stop.faults).toEqual([]);
    expect(run.workflowEvents.at(-1)?.type).toBe('RunClosed');
    expect(run.calls).toEqual([
      'register',
      'submit:context-assemble',
      'submit:model-call',
      'end',
      'register',
      'submit:repository-orient',
      'submit:context-assemble',
      'submit:model-call',
      'submit:file-read',
      'submit:context-assemble',
      'submit:model-call',
      'submit:report-publish',
      'end',
      'close:COMPLETED',
    ]);
    expect(await run.report()).toMatchObject({
      degraded: false,
      goal: '分析仓库并核验来源',
      readSources: [{ path: 'README.md', startLine: 1, endLine: 3 }],
      conclusions: [{ sources: [{ path: 'README.md', startLine: 1, endLine: 3 }] }],
    });
    expect(await run.summary()).toMatchObject({ closeReason: 'COMPLETED' });
    expect(run.record).toMatchObject({
      businessState: 'COMPLETED',
      agentRuns: [{ ending: 'HANDOFF' }, { ending: 'FINISH' }],
      reads: [{ output: { path: 'README.md', totalLines: 3 } }],
    });
    expect(run.text).toContain('来源：README.md:1-3');
    expect(run.text).toContain('运行摘要');
  });

  it.each(['ASK', 'TIMEOUT'] as const)(
    'uses a final call after a declined read: %s',
    async (mode) => {
      const run = await runScenario({
        kernel: { authorization: mode },
        terminal: createFakeTerminal('NO'),
      });
      expect(run.exitCode).toBe(0);
      expect(run.stop.faults).toEqual([]);
      expect(await run.report()).toMatchObject({
        degraded: false,
        wrapUp: { reason: 'USER_DECLINED' },
        readSources: [],
        conclusions: [],
      });
      expect(run.text).toContain('未获仓库读取授权');
      expect(run.calls.slice(-3)).toEqual(['submit:report-publish', 'end', 'close:COMPLETED']);
      expect(await run.summary()).toMatchObject({ closeReason: 'COMPLETED' });
    },
  );

  it('rejects creation without starting Workflow or claiming a report', async () => {
    const run = await runScenario({ kernel: { rejectCreateRun: 'REPOSITORY_INVALID' } });
    expect(run.exitCode).toBe(4);
    expect(run.workflowEvents).toEqual([]);
    expect(run.calls).toEqual([]);
    expect(run.finished).toBeUndefined();
    expect(run.text).toContain('仓库路径不符合要求');
  });

  it.each([
    { end: 'RUN_TIMEOUT', exitCode: 2, closeReason: 'RUN_TIMEOUT', message: '运行超时' },
    { end: 'PATH_ESCAPE', exitCode: 3, closeReason: 'VIOLATION', message: '安全违规' },
  ] as const)('stops business on $end', async ({ end, exitCode, closeReason, message }) => {
    const run = await runScenario({ kernel: { unitScript: () => ({ end }) } });
    expect(run.exitCode).toBe(exitCode);
    expect(run.finished?.closeReason).toBe(closeReason);
    expect(run.calls).toEqual(['register', 'submit:context-assemble']);
    expect(run.text).toContain(message);
    expect(await run.summary()).toMatchObject({ closeReason });
  });

  it('cancels during a pending authorization and stops every module', async () => {
    const terminal = createFakeTerminal();
    terminal.askYesNo = (_question, signal) => {
      queueMicrotask(() => terminal.interrupt());
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(undefined), { once: true });
      });
    };
    const run = await runScenario({ kernel: { authorization: 'ASK' }, terminal });
    expect(run.exitCode).toBe(130);
    expect(run.finished?.closeReason).toBe('CANCELLED');
    expect(run.text).toContain('运行已取消');
    expect(run.calls).not.toContain('submit:report-publish');
    expect(await run.summary()).toMatchObject({ closeReason: 'CANCELLED' });
  });

  it('carries WRAP_UP through handoff and reserves one final call for the target', async () => {
    const run = await runScenario({
      kernel: {
        unitScript: ({ executionKind }) =>
          executionKind === 'MODEL' ? { budgetState: 'WRAP_UP' } : undefined,
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.submissions.filter((request) => request.unitRef.id === 'model-call')).toHaveLength(
      2,
    );
    expect(
      run.submissions.filter((request) => 'final' in request.input && request.input.final),
    ).toHaveLength(2);
    expect(run.calls.filter((call) => call === 'register')).toHaveLength(2);
    expect(await run.report()).toMatchObject({
      degraded: false,
      wrapUp: { reason: 'BUDGET_WRAP_UP' },
    });
    expect(run.text).toContain('已进入额度收尾阶段');
  });

  it('publishes a programmatic report without another model call when EXHAUSTED', async () => {
    const run = await runScenario({
      kernel: { unitScript: () => ({ budgetState: 'EXHAUSTED' }) },
    });
    expect(run.exitCode).toBe(0);
    expect(run.calls).not.toContain('submit:model-call');
    expect(await run.report()).toMatchObject({
      degraded: true,
      wrapUp: { reason: 'BUDGET_EXHAUSTED' },
      conclusions: [],
      unconfirmed: [],
      readSources: [],
    });
    expect(run.text).toContain('额度已不足以继续调用模型');
  });

  it('keeps an ordinary fatal failure as FAILED even when the budget is exhausted', async () => {
    const run = await runScenario({
      kernel: {
        unitScript: ({ executionKind }) =>
          executionKind === 'MODEL'
            ? { fail: 'PROVIDER_AUTH', budgetState: 'EXHAUSTED' }
            : undefined,
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.finished).toMatchObject({
      closeReason: 'FAILED',
      failure: { code: 'PROVIDER_AUTH' },
    });
    expect(run.calls.at(-1)).toBe('close:FAILED');
    expect(run.calls).not.toContain('submit:report-publish');
    expect(run.text).toContain('模型服务认证失败');
    expect(await run.summary()).toMatchObject({ closeReason: 'FAILED' });
  });

  it('still presents the report when saving the run summary fails', async () => {
    const run = await runScenario({ kernel: { summaryWriteFails: true }, details: true });
    expect(run.exitCode).toBe(1);
    expect(run.finished).toMatchObject({
      closeReason: 'COMPLETED',
      finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
    });
    expect(await run.report()).toMatchObject({ degraded: false });
    expect(run.text).toContain('分析报告');
    expect(run.text).toContain('运行摘要保存失败');
  });

  it('presents uncertain effects without claiming that they succeeded', async () => {
    const run = await runScenario({
      kernel: {
        unknownEffects: [
          {
            executionId: newId('exe'),
            unitAttemptId: newId('una'),
            executionKind: 'FILE_READ',
            effect: 'EXECUTION_STOP_UNCONFIRMED',
          },
        ],
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.text).toContain('部分操作无法确认是否完成');
    expect(await run.summary()).toMatchObject({ unknownEffects: [{ executionKind: 'FILE_READ' }] });
  });

  it('absorbs a Workflow port exception as a failed run with a private diagnostic', async () => {
    const run = await runScenario({
      workflow: (deps) => ({
        ...deps,
        catalog: {
          ...deps.catalog,
          pinAgent: () => Promise.reject(new Error('Sensitive provider diagnostic')),
        },
      }),
    });
    expect(run.exitCode).toBe(1);
    expect(run.stop.faults).toEqual([]);
    expect(run.finished).toMatchObject({
      closeReason: 'FAILED',
      failure: { code: 'WORKFLOW_INTERNAL' },
    });
    expect(run.calls).toEqual(['close:FAILED']);
    expect(run.text).not.toContain('Sensitive provider diagnostic');
    expect(await run.audit()).not.toContain('Sensitive provider diagnostic');
    expect(await run.summary()).toMatchObject({ closeReason: 'FAILED' });
  });

  it('absorbs a reducer exception and persists a sanitized failure record', async () => {
    const run = await runScenario({
      workflow: (deps) => {
        const registry = createM1ProtocolRegistry();
        registry.resolveContract = () => {
          throw new Error('Sensitive contract resolution failure');
        };
        return { ...deps, registry };
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stop.faults).toEqual([]);
    expect(run.finished).toMatchObject({
      closeReason: 'FAILED',
      failure: { code: 'WORKFLOW_INTERNAL' },
    });
    expect(run.calls).not.toContain('submit:report-publish');
    expect(run.record).toMatchObject({ businessState: 'FAILED' });
    expect(await run.audit()).toContain('REDUCE');
    expect(await run.audit()).not.toContain('Sensitive contract resolution failure');
    expect(run.text).not.toContain('Sensitive contract resolution failure');
  });

  it('degrades when the reserved final model call fails', async () => {
    let modelCalls = 0;
    const run = await runScenario({
      kernel: {
        unitScript: ({ executionKind }) => {
          if (executionKind !== 'MODEL') return undefined;
          modelCalls++;
          return modelCalls === 1
            ? { budgetState: 'WRAP_UP' }
            : { fail: 'PROVIDER_AUTH', budgetState: 'EXHAUSTED' };
        },
      },
    });
    expect(run.exitCode).toBe(0);
    expect(modelCalls).toBe(2);
    expect(await run.report()).toMatchObject({
      degraded: true,
      wrapUp: { reason: 'BUDGET_EXHAUSTED' },
      conclusions: [],
    });
    // The ending is described by UserInteraction from wrapUp; the last failure is shown once
    // the report Schema carries it.
    expect(run.text).toContain('额度已不足以继续调用模型');
    expect(run.calls.slice(-3)).toEqual(['submit:report-publish', 'end', 'close:COMPLETED']);
  });

  it('closes the system when the interaction consumer throws', async () => {
    const terminal = createFakeTerminal();
    terminal.write = () => {
      throw new Error('Terminal failed');
    };
    const run = await runScenario({ kernel: { authorization: 'ASK' }, terminal });
    expect(run.exitCode).toBe(70);
    expect(run.stop.faults.length).toBeGreaterThan(0);
    expect(run.calls).not.toContain('submit:report-publish');
  });

  it('returns illegal handoff feedback to CodeViewer before a later read and finish', async () => {
    const run = await runScenario({
      modelScript: (step) => {
        if (step.callIndex === 1)
          return [
            {
              toolCallId: 'forbidden-handoff',
              toolName: 'handoff_to_code_viewer',
              arguments: { task: '继续分析', focusAreas: [], openQuestions: [] },
            },
          ];
        if (step.callIndex === 2)
          return [
            {
              toolCallId: 'read-after-feedback',
              toolName: 'read_file',
              arguments: { path: 'README.md' },
            },
          ];
        return defaultModelScript(step);
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.calls.filter((call) => call === 'register')).toHaveLength(2);
    const contexts = run.submissions.filter((request) => request.unitRef.id === 'context-assemble');
    expect(contexts[2]?.input).toMatchObject({
      steps: [
        { kind: 'MODEL_TURN', toolCalls: [{ toolCallId: 'forbidden-handoff' }] },
        { kind: 'FEEDBACK', toolCallId: 'forbidden-handoff', code: 'INVALID_ACTION' },
      ],
    });
    expect(await run.report()).toMatchObject({
      degraded: false,
      readSources: [{ path: 'README.md' }],
      conclusions: [{ sources: [{ path: 'README.md' }] }],
    });
  });

  it('escalates to root closure when Workflow cannot publish its internal failure', async () => {
    const run = await runScenario({
      workflow: (deps) => ({
        ...deps,
        catalog: { ...deps.catalog, pinAgent: () => Promise.reject(new Error('Pin failed')) },
        gateway: {
          ...deps.gateway,
          closeRun: () => Promise.reject(new Error('Close failed')),
        },
      }),
    });
    expect(run.exitCode).toBe(1);
    expect(run.stop.faults.length).toBeGreaterThan(0);
    expect(run.finished).toMatchObject({ closeReason: 'FAILED' });
    expect(run.calls).toEqual(['close:FAILED']);
    expect(run.calls).not.toContain('submit:report-publish');
  });

  it('pairs a search result and rejected unknown tool before continuing to read', async () => {
    const run = await runScenario({
      modelScript: (step) => {
        if (step.callIndex === 1)
          return [
            { toolCallId: 'search', toolName: 'search_repository', arguments: { query: 'README' } },
            { toolCallId: 'unknown', toolName: 'missing_tool', arguments: {} },
          ];
        if (step.callIndex === 2)
          return [{ toolCallId: 'read', toolName: 'read_file', arguments: { path: 'README.md' } }];
        return defaultModelScript(step);
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.calls).toContain('submit:repository-search');
    expect(run.calls).toContain('submit:file-read');
    const contexts = run.submissions.filter((request) => request.unitRef.id === 'context-assemble');
    expect(contexts[2]?.input).toMatchObject({
      steps: [
        { kind: 'MODEL_TURN' },
        { kind: 'FEEDBACK', toolCallId: 'unknown', code: 'UNKNOWN_TOOL' },
        { kind: 'TOOL_RESULT', toolCallId: 'search', status: 'OK' },
      ],
    });
    expect(await run.report()).toMatchObject({
      degraded: false,
      conclusions: [{ sources: [{ path: 'README.md' }] }],
    });
  });
});
