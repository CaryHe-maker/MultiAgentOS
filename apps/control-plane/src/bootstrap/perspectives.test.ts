/**
 * Closure checks from the seat of each work stream. Each block puts a small stand-in written
 * only against the public seams (M1Interface 14) into one seat, keeps fakes in the others, and
 * runs the whole system. They show that the seat has everything it needs from its neighbours;
 * the stand-ins are test code, far simpler than the Modules they stand for.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnalysisReportSchema,
  MEDIA_TYPES,
  REASON_CODE_CATEGORY,
  RunSummarySchema,
  newId,
  sha256Hex,
  validate,
  type AnalysisReport,
  type AnalysisReportDraft,
  type ArtifactRef,
  type BoundaryContext,
  type Envelope,
  type ExecutionKind,
  type ExecutionScope,
  type Executor,
  type ExecutorKind,
  type ExecutorOutcome,
  type ExecutorRegistry,
  type FabricPort,
  type FileReadOutput,
  type GatewayForward,
  type HandoffBrief,
  type InteractionInboxEvent,
  type KernelToInteractionEvent,
  type KernelToWorkflowEvent,
  type ModelCallOutput,
  type ModelToolCall,
  type PinnedDefinitionSet,
  type ReasonCode,
  type RunFinished,
  type RunSummary,
  type StepRecord,
  type SyscallAck,
  type SyscallRejected,
  type UnitInput,
  type UnitReport,
  type WorkflowInboxEvent,
} from '@multiagentos/contracts';
import { Inbox, SCHEMA_IDS } from '@multiagentos/fabric';
import {
  createFakeExecutorRegistry,
  createFakeGateway,
  createFakeKernelCore,
  createFakeSupervisor,
  createFakeTerminal,
  createFakeUserInteraction,
  createFakeWorkflow,
  type FakeKernelOptions,
} from '@multiagentos/testing';
import {
  EXIT_CODES,
  type TerminalPort,
  type UserInteractionDeps,
  type UserInteractionModule,
} from '@multiagentos/user-interaction';
import type { WorkflowDeps, WorkflowModule } from '@multiagentos/workflow';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSystemConfig } from '../config/system-config.js';
import { composeSystem, type SystemParts } from './compose-system.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

interface Seats {
  readonly kernel?: FakeKernelOptions;
  readonly parts?: Partial<SystemParts>;
  readonly terminal?: TerminalPort;
  readonly repositoryPath?: string;
  readonly details?: boolean;
}

/** Runs one goal to the end with fakes in every seat that `seats.parts` does not replace. */
async function runSystem(seats: Seats = {}) {
  const dataDir = await temporaryDirectory('multiagentos-seat-');
  const workflowEvents: KernelToWorkflowEvent[] = [];
  const interactionEvents: KernelToInteractionEvent[] = [];
  const written: string[] = [];
  let workflowRunId = '';
  const parts: SystemParts = {
    createGateway: createFakeGateway(),
    createKernelCore: createFakeKernelCore(seats.kernel),
    createSupervisor: createFakeSupervisor(),
    createExecutorRegistry: () => createFakeExecutorRegistry(),
    createWorkflow: createFakeWorkflow(),
    createUserInteraction: createFakeUserInteraction(),
    ...seats.parts,
  };
  const system = await composeSystem({
    config: { ...defaultSystemConfig(), dataDir },
    terminal: { ...(seats.terminal ?? createFakeTerminal()), write: (text) => written.push(text) },
    credentials: { apiKeyFor: () => undefined },
    parts: {
      ...parts,
      // Record what each Inbox receives, whichever implementation sits behind it.
      createWorkflow: (deps) => {
        const module = parts.createWorkflow(deps);
        const deliver = module.inbox.deliver.bind(module.inbox);
        module.inbox.deliver = (event) => {
          workflowRunId = event.workflowRunId;
          workflowEvents.push(event.event);
          return deliver(event);
        };
        return module;
      },
      createUserInteraction: (deps) => {
        const module = parts.createUserInteraction(deps);
        const deliver = module.inbox.deliver.bind(module.inbox);
        module.inbox.deliver = (event) => {
          interactionEvents.push(event.event);
          return deliver(event);
        };
        return module;
      },
    },
  });
  await system.start();
  const exitCode = await system.userInteraction.analyze({
    goal: 'How many lines does the README have?',
    repositoryPath: seats.repositoryPath ?? tmpdir(),
    details: seats.details ?? false,
  });
  await system.whenStopped();
  const closed = workflowEvents.at(-1);
  const finished = interactionEvents.at(-1);
  if (closed?.type !== 'RunClosed' || finished?.type !== 'RunFinished')
    throw new Error('the run did not end with RunClosed and RunFinished');
  const artifact = (ref: ArtifactRef) =>
    readFile(join(dataDir, 'runs', workflowRunId, 'artifacts', ref.sha256), 'utf8');
  return { exitCode, workflowEvents, interactionEvents, closed, finished, written, artifact };
}

const reportsOf = (events: readonly KernelToWorkflowEvent[]) =>
  events.filter((event): event is UnitReport => event.type === 'UnitReport');

// ---------------------------------------------------------------------------------------------
// Seat 1: ExecutorSet (and AgentToolPool, whose shipped catalog every run below pins for real)
// ---------------------------------------------------------------------------------------------

/** A real file read, standing where the FileReadExecutor of ExecutorSet will be. */
function realFileRead(seen: {
  scope?: ExecutionScope;
  maxOutputBytes?: number;
}): Executor<'FILE_READ'> {
  return {
    executionKind: 'FILE_READ',
    execute: async (input, environment): Promise<ExecutorOutcome> => {
      seen.scope = environment.scope;
      seen.maxOutputBytes = environment.limits.maxOutputBytes;
      if (environment.scope.kind !== 'REPOSITORY')
        return { outcome: 'VIOLATION', reasonCode: 'SCOPE_MISSING' };
      let text: string;
      try {
        text = await readFile(join(environment.scope.repositoryRoot, input.path), 'utf8');
      } catch {
        return { outcome: 'REJECTED', reasonCode: 'NOT_FOUND' };
      }
      const lines = text.split('\n').length - 1;
      return {
        outcome: 'COMPLETED',
        result: {
          output: {
            path: input.path,
            startLine: 1,
            endLine: lines,
            totalLines: lines,
            contentSha256: sha256Hex(text),
            fileSha256: sha256Hex(text),
          },
          artifact: { mediaType: MEDIA_TYPES.fileText, text },
        },
      };
    },
  };
}

const withExecutor = (overrides: Partial<ExecutorRegistry>): Partial<SystemParts> => ({
  createExecutorRegistry: () => createFakeExecutorRegistry(undefined, overrides),
});

describe('ExecutorSet seat: a real Executor runs inside the whole chain', () => {
  it('receives the scope and limits from the Kernel and its result reaches Workflow', async () => {
    const repositoryPath = await temporaryDirectory('multiagentos-repository-');
    await writeFile(join(repositoryPath, 'README.md'), 'alpha\nbeta\n');
    const seen: { scope?: ExecutionScope; maxOutputBytes?: number } = {};
    const run = await runSystem({
      repositoryPath,
      parts: withExecutor({ FILE_READ: realFileRead(seen) }),
    });

    expect(run.exitCode).toBe(0);
    expect(seen.scope).toEqual({
      kind: 'REPOSITORY',
      repositoryRoot: repositoryPath,
      exclusions: [],
    });
    expect(seen.maxOutputBytes).toBe(
      defaultSystemConfig().kernel.executionLimits.FILE_READ.maxOutputBytes,
    );
    const read = reportsOf(run.workflowEvents).find(
      (report) => report.executionKind === 'FILE_READ',
    );
    expect(read).toMatchObject({
      status: 'OK',
      output: { totalLines: 2, contentSha256: sha256Hex('alpha\nbeta\n') },
    });
    if (read?.status !== 'OK') return;
    expect(await run.artifact(read.outputRef)).toBe('alpha\nbeta\n');
  });

  it.each<[string, ExecutorOutcome, Partial<UnitReport>, number]>([
    [
      'a rejection',
      { outcome: 'REJECTED', reasonCode: 'NOT_FOUND' },
      { status: 'REJECTED', reasonCode: 'NOT_FOUND' },
      EXIT_CODES.FAILED,
    ],
    [
      'a failure',
      { outcome: 'FAILED', reasonCode: 'INTERNAL', retryable: false },
      { status: 'FAILED', reasonCode: 'INTERNAL' },
      EXIT_CODES.FAILED,
    ],
  ])('delivers %s of an Executor as a UnitReport', async (_label, outcome, expected, exitCode) => {
    const run = await runSystem({
      parts: withExecutor({
        FILE_READ: { executionKind: 'FILE_READ', execute: () => Promise.resolve(outcome) },
      }),
    });
    expect(reportsOf(run.workflowEvents).at(-1)).toMatchObject(expected);
    expect(run.exitCode).toBe(exitCode);
  });

  it('reports an Executor that throws as FAILED(INTERNAL) instead of hanging', async () => {
    const run = await runSystem({
      parts: withExecutor({
        FILE_READ: {
          executionKind: 'FILE_READ',
          execute: () => Promise.reject(new Error('executor bug')),
        },
      }),
    });
    expect(reportsOf(run.workflowEvents).at(-1)).toMatchObject({
      status: 'FAILED',
      reasonCode: 'INTERNAL',
    });
  });

  it('stops the run as VIOLATION when an Executor reports a security violation', async () => {
    const run = await runSystem({
      parts: withExecutor({
        FILE_READ: {
          executionKind: 'FILE_READ',
          execute: () => Promise.resolve({ outcome: 'VIOLATION', reasonCode: 'PATH_ESCAPE' }),
        },
      }),
    });
    expect(run.closed).toMatchObject({
      closeReason: 'VIOLATION',
      failure: { code: 'PATH_ESCAPE', category: 'INTEGRITY', source: 'KERNEL' },
    });
    expect(run.exitCode).toBe(EXIT_CODES.VIOLATION);
  });
});

// ---------------------------------------------------------------------------------------------
// Seat 2: Workflow
// ---------------------------------------------------------------------------------------------

class Stop extends Error {
  public constructor(public readonly code: ReasonCode) {
    super(code);
  }
}

/**
 * The shortest Workflow that follows docs/M1/Module/Workflow.md end to end: planner, handoff,
 * code viewer, one tool round, FINISH, source check, report-publish, closeRun. It has no
 * Validation, failurePolicy, Round limit or final-call: anything unexpected closes as FAILED.
 */
function referenceWorkflow(log: { afterClose?: SyscallAck | SyscallRejected } = {}) {
  return (deps: WorkflowDeps): WorkflowModule => {
    const inbox = new Inbox<WorkflowInboxEvent>({
      channels: ['default'],
      dedupeKey: (event) => event.eventId,
    });
    const waiting = new Map<string, (report: UnitReport) => void>();
    let driver: Promise<void> = Promise.resolve();

    const drive = async (workflowRunId: string, goal: string) => {
      const context: BoundaryContext = {
        correlationId: newId('cor'),
        tenantId: 'local',
        projectId: 'local',
        workflowRunId,
      };
      const accepted = (response: SyscallAck | SyscallRejected) => {
        if (response.outcome === 'REJECTED') throw new Stop(response.reasonCode);
      };
      const pin = async (ref: { id: string; version: string }) => {
        const pinned = await deps.catalog.pinAgent({ id: ref.id, version: ref.version }, context);
        if (!pinned.ok) throw new Stop('PIN_FAILED');
        return pinned.value;
      };
      const submit = async (
        agentRunId: string,
        pinned: PinnedDefinitionSet,
        kind: ExecutionKind,
        input: UnitInput,
      ) => {
        const unit = pinned.units.find((candidate) => candidate.executionKind === kind);
        if (unit === undefined) throw new Stop('FORBIDDEN');
        const requestId = newId('req');
        // The UnitReport may arrive before the SyscallAck, so wait for it from the start.
        const report = new Promise<UnitReport>((resolve) => waiting.set(requestId, resolve));
        const { id, version, digest } = unit;
        accepted(
          await deps.gateway.submitUnit(
            {
              requestId,
              workflowRunId,
              agentRunId,
              unitRef: { kind: 'UNIT', id, version, digest },
              input,
            },
            context,
          ),
        );
        const result = await report;
        if (result.status !== 'OK') throw new Stop(result.reasonCode);
        return result;
      };
      const register = async (pinned: PinnedDefinitionSet) => {
        const agentRunId = newId('agr');
        const { id, version, digest } = pinned.agent;
        accepted(
          await deps.gateway.registerAgentRun(
            {
              requestId: newId('req'),
              workflowRunId,
              agentRunId,
              agentRef: { kind: 'AGENT', id, version, digest },
            },
            context,
          ),
        );
        return agentRunId;
      };
      const end = async (agentRunId: string) =>
        accepted(
          await deps.gateway.endAgentRun(
            { requestId: newId('req'), workflowRunId, agentRunId },
            context,
          ),
        );
      /** One Round up to the model's answer: context-assemble, then model-call. */
      const askModel = async (
        agentRunId: string,
        pinned: PinnedDefinitionSet,
        round: number,
        steps: StepRecord[],
        extra: { handoff?: HandoffBrief; orientPackRef?: ArtifactRef },
      ): Promise<ModelToolCall> => {
        const status = {
          roundsUsed: round - 1,
          maxRounds: pinned.agent.limits.maxRounds,
          final: false,
          budgetState: 'NORMAL' as const,
        };
        const assembled = await submit(agentRunId, pinned, 'CONTEXT_ASSEMBLE', {
          objective: goal,
          final: false,
          ...extra,
          steps,
          status,
        });
        const answered = await submit(agentRunId, pinned, 'MODEL', {
          contextPackRef: assembled.outputRef,
          final: false,
        });
        const [call] = (answered.output as ModelCallOutput).toolCalls;
        if (call === undefined) throw new Stop('WORKFLOW_INTERNAL');
        steps.push({ kind: 'MODEL_TURN', round, requestId: answered.requestId, toolCalls: [call] });
        return call;
      };

      try {
        const planner = await pin(deps.config.entryAgentRef);
        if (planner.handoffTargetRef === undefined) throw new Stop('PIN_FAILED');
        const viewer = await pin(planner.handoffTargetRef);
        if (viewer.agent.digest !== planner.handoffTargetRef.digest) throw new Stop('PIN_FAILED');

        const plannerRun = await register(planner);
        const handoff = await askModel(plannerRun, planner, 1, [], {});
        if (handoff.toolName !== 'handoff_to_code_viewer') throw new Stop('WORKFLOW_INTERNAL');
        await end(plannerRun);

        const viewerRun = await register(viewer);
        const orient = await submit(viewerRun, viewer, 'REPOSITORY_ORIENT', { objective: goal });
        const extra = {
          handoff: handoff.arguments as HandoffBrief,
          orientPackRef: orient.outputRef,
        };
        const steps: StepRecord[] = [];
        const reads: { requestId: string; output: FileReadOutput }[] = [];
        let call = await askModel(viewerRun, viewer, 1, steps, extra);
        for (let round = 2; call.toolName === 'read_file' && round <= 3; round += 1) {
          const read = await submit(viewerRun, viewer, 'FILE_READ', call.arguments as UnitInput);
          const output = read.output as FileReadOutput;
          reads.push({ requestId: read.requestId, output });
          steps.push({
            kind: 'TOOL_RESULT',
            round: round - 1,
            requestId: read.requestId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            status: 'OK',
            output,
            outputRef: read.outputRef,
          });
          call = await askModel(viewerRun, viewer, round, steps, extra);
        }
        if (call.toolName !== 'finish_analysis') throw new Stop('WORKFLOW_INTERNAL');

        const draft = call.arguments as AnalysisReportDraft;
        const covering = (source: { path: string; startLine: number; endLine: number }) =>
          reads.find(
            ({ output }) =>
              output.path === source.path &&
              output.startLine <= source.startLine &&
              source.endLine <= output.endLine,
          );
        const verified = draft.conclusions.filter(
          (conclusion) =>
            conclusion.sources.length > 0 && conclusion.sources.every((source) => covering(source)),
        );
        const toSource = (source: { path: string; startLine: number; endLine: number }) => {
          const read = covering(source);
          if (read === undefined) throw new Stop('WORKFLOW_INTERNAL');
          return {
            ...source,
            readRequestId: read.requestId,
            readContentSha256: read.output.contentSha256,
          };
        };
        const report: AnalysisReport = {
          workflowRunId,
          goal,
          summary: draft.summary,
          conclusions: verified.map((conclusion) => ({
            statement: conclusion.statement,
            sources: conclusion.sources.map(toSource),
          })),
          unconfirmed: draft.conclusions
            .filter((conclusion) => !verified.includes(conclusion))
            .map((conclusion) => ({
              statement: conclusion.statement,
              reason: 'SOURCE_NOT_READ' as const,
            })),
          readSources: reads.map(({ requestId, output }) => ({
            path: output.path,
            startLine: output.startLine,
            endLine: output.endLine,
            readRequestId: requestId,
            readContentSha256: output.contentSha256,
          })),
          degraded: false,
          agentRounds: [],
          createdAt: new Date().toISOString(),
        };
        const published = await submit(viewerRun, viewer, 'REPORT_PUBLISH', { report });
        await end(viewerRun);
        accepted(
          await deps.gateway.closeRun(
            {
              requestId: newId('req'),
              workflowRunId,
              outcome: 'COMPLETED',
              reportRef: published.outputRef,
            },
            context,
          ),
        );
      } catch (error) {
        const code = error instanceof Stop ? error.code : 'WORKFLOW_INTERNAL';
        if (code === 'RUN_BLOCKED') return;
        await deps.gateway.closeRun(
          {
            requestId: newId('req'),
            workflowRunId,
            outcome: 'FAILED',
            failure: { code, category: REASON_CODE_CATEGORY[code], source: 'WORKFLOW' },
          },
          context,
        );
      }
    };

    return {
      manifest: { moduleId: 'workflow', version: '0.0.0-reference', dependencies: ['gateway'] },
      inbox: {
        deliver: (event) => {
          inbox.enqueue(event);
          return Promise.resolve();
        },
      },
      start: () => {
        inbox.start(async ({ workflowRunId, event }) => {
          // The driver waits for later events, so the Inbox handler must never wait for it.
          if (event.type === 'RunStart') driver = drive(workflowRunId, event.goal);
          if (event.type === 'UnitReport') waiting.get(event.requestId)?.(event);
          if (event.type === 'RunClosed')
            log.afterClose = await deps.gateway.endAgentRun(
              { requestId: newId('req'), workflowRunId, agentRunId: newId('agr') },
              { correlationId: newId('cor'), tenantId: 'local', projectId: 'local', workflowRunId },
            );
        });
        return Promise.resolve();
      },
      stop: async () => {
        await inbox.idle();
        await driver;
      },
      health: () =>
        Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: [] }),
    };
  };
}

describe('Workflow seat: the whole business flow runs against the fake Kernel', () => {
  it('goes planner, handoff, code viewer, tool round, FINISH, verified report, close', async () => {
    const log: { afterClose?: SyscallAck | SyscallRejected } = {};
    const run = await runSystem({ parts: { createWorkflow: referenceWorkflow(log) } });

    expect(run.exitCode).toBe(0);
    expect(reportsOf(run.workflowEvents).map((report) => report.executionKind)).toEqual([
      'CONTEXT_ASSEMBLE', // planner
      'MODEL',
      'REPOSITORY_ORIENT', // code viewer start unit
      'CONTEXT_ASSEMBLE',
      'MODEL',
      'FILE_READ',
      'CONTEXT_ASSEMBLE', // the read result is resolved into this pack
      'MODEL',
      'REPORT_PUBLISH',
    ]);
    if (run.finished.closeReason !== 'COMPLETED') throw new Error('expected COMPLETED');
    const report: unknown = JSON.parse(await run.artifact(run.finished.reportRef));
    expect(validate(AnalysisReportSchema, report)).toMatchObject({ ok: true });
    const read = reportsOf(run.workflowEvents).find((item) => item.executionKind === 'FILE_READ');
    expect(report).toMatchObject({
      degraded: false,
      unconfirmed: [],
      conclusions: [{ sources: [{ path: 'README.md', readRequestId: read?.requestId }] }],
    });
    if (!('runSummaryRef' in run.finished)) throw new Error('reference run has no summary');
    const summary = JSON.parse(await run.artifact(run.finished.runSummaryRef)) as RunSummary;
    expect(summary.agentRuns.map((agentRun) => [agentRun.agentRef.id, agentRun.rounds])).toEqual([
      ['planner', 1],
      ['code-viewer', 2],
    ]);
    // After RunClosed the Kernel still answers: an unknown AgentRun is rejected, not ignored.
    expect(log.afterClose).toMatchObject({
      outcome: 'REJECTED',
      reasonCode: 'AGENT_RUN_NOT_FOUND',
    });
  });

  it('receives a scripted rejection and budget state, the inputs of failurePolicy', async () => {
    const run = await runSystem({
      parts: { createWorkflow: referenceWorkflow() },
      kernel: {
        unitScript: ({ executionKind, index }) =>
          executionKind === 'MODEL'
            ? { reject: 'BUDGET_EXHAUSTED' }
            : index === 0
              ? { budgetState: 'WRAP_UP' }
              : undefined,
      },
    });
    const [assembled, model] = reportsOf(run.workflowEvents);
    expect(assembled).toMatchObject({ status: 'OK', budgetState: 'WRAP_UP' });
    expect(model).toMatchObject({ status: 'REJECTED', reasonCode: 'BUDGET_EXHAUSTED' });
    expect(run.closed).toMatchObject({
      closeReason: 'FAILED',
      failure: { code: 'BUDGET_EXHAUSTED', category: 'RESOURCE', source: 'WORKFLOW' },
    });
    expect(run.exitCode).toBe(EXIT_CODES.FAILED);
  });
});

// ---------------------------------------------------------------------------------------------
// Seat 3: Kernel and UserInteraction
// ---------------------------------------------------------------------------------------------

/** Records every GatewayForward that reaches the Kernel core. */
function recordingKernel(
  seen: GatewayForward[],
  options: FakeKernelOptions = {},
): Partial<SystemParts> {
  return {
    createKernelCore: (deps) => {
      const register: FabricPort['register'] = <TRequest, TResponse>(
        schemaId: string,
        handler: (envelope: Envelope<TRequest>) => Promise<TResponse>,
      ) =>
        deps.fabric.register<TRequest, TResponse>(schemaId, (envelope) => {
          if (schemaId === SCHEMA_IDS.gatewayForward) seen.push(envelope.payload as GatewayForward);
          return handler(envelope);
        });
      return createFakeKernelCore(options)({ ...deps, fabric: { ...deps.fabric, register } });
    },
  };
}

/** Records which Executors the Supervisor was asked to run, and with which scope. */
function recordingExecutors(seen: [ExecutorKind, ExecutionScope['kind']][]): Partial<SystemParts> {
  return {
    createExecutorRegistry: () => {
      const registry = createFakeExecutorRegistry();
      const wrap = <K extends ExecutorKind>(kind: K): Executor<K> => ({
        executionKind: kind,
        execute: (input, environment) => {
          seen.push([kind, environment.scope.kind]);
          return registry[kind].execute(input, environment);
        },
      });
      return {
        REPOSITORY_ORIENT: wrap('REPOSITORY_ORIENT'),
        REPOSITORY_SEARCH: wrap('REPOSITORY_SEARCH'),
        FILE_READ: wrap('FILE_READ'),
        CONTEXT_ASSEMBLE: wrap('CONTEXT_ASSEMBLE'),
        MODEL: wrap('MODEL'),
      };
    },
  };
}

/**
 * The shortest UserInteraction that follows docs/M1/Module/UserInteraction.md 3: it asks the
 * authorization question on the terminal without blocking the Inbox, cancels on interrupt,
 * shows the report (and the RunSummary with `details`) and requests shutdown.
 */
function referenceInteraction() {
  return (deps: UserInteractionDeps): UserInteractionModule => {
    const inbox = new Inbox<InteractionInboxEvent>({
      channels: ['default'],
      dedupeKey: (event) => event.eventId,
    });
    const contextOf = (workflowRunId?: string): BoundaryContext => ({
      correlationId: newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      ...(workflowRunId === undefined ? {} : { workflowRunId }),
    });
    let question: AbortController | undefined;
    let resolveFinished: (event: RunFinished) => void = () => undefined;
    const finished = new Promise<RunFinished>((resolve) => {
      resolveFinished = resolve;
    });
    return {
      manifest: {
        moduleId: 'user-interaction',
        version: '0.0.0-reference',
        dependencies: ['gateway'],
      },
      inbox: {
        deliver: (event) => {
          inbox.enqueue(event);
          return Promise.resolve();
        },
      },
      start: () => {
        inbox.start(({ workflowRunId, event }) => {
          if (event.type === 'AuthorizationRequest') {
            question = new AbortController();
            // Not awaited: reading the answer is a task of its own.
            void deps.terminal
              .askYesNo(
                `Read ${event.repositoryPath} and send it to ${event.provider}?`,
                question.signal,
              )
              .then(async (answer) => {
                if (answer === undefined) return;
                await deps.gateway.answerAuthorization(
                  { requestId: newId('req'), workflowRunId, questionId: event.questionId, answer },
                  contextOf(workflowRunId),
                );
              });
          } else question?.abort();
          if (event.type === 'RunFinished') resolveFinished(event);
          return Promise.resolve();
        });
        return Promise.resolve();
      },
      stop: () => inbox.idle(),
      health: () =>
        Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: [] }),
      analyze: async (command) => {
        const created = await deps.gateway.createRun(
          { requestId: newId('req'), goal: command.goal, repositoryPath: command.repositoryPath },
          contextOf(),
        );
        if (created.outcome === 'REJECTED') throw new Error(created.reasonCode);
        const { workflowRunId } = created;
        const removeInterrupt = deps.terminal.onInterrupt(() => {
          void deps.gateway.cancelRun(
            { requestId: newId('req'), workflowRunId },
            contextOf(workflowRunId),
          );
        });
        const end = await finished;
        removeInterrupt();
        const show = async (label: string, ref: ArtifactRef) => {
          const content = await deps.gateway.readArtifact(
            { requestId: newId('req'), workflowRunId, ref },
            contextOf(workflowRunId),
          );
          if (content.outcome === 'ACCEPTED') deps.terminal.write(`${label}:${content.text}`);
        };
        if (end.closeReason === 'COMPLETED') await show('report', end.reportRef);
        else deps.terminal.write(`ended:${end.closeReason}`);
        if ('finalizationError' in end) {
          deps.terminal.write(`ended:${end.finalizationError}`);
        } else if (command.details) await show('summary', end.runSummaryRef);
        await deps.gateway.shutdown({ requestId: newId('req') }, contextOf());
        return 'finalizationError' in end ? 1 : EXIT_CODES[end.closeReason];
      },
    };
  };
}

describe('Kernel seat: the fakes around it send everything a Kernel must handle', () => {
  it('receives all nine request types and is asked to run all five Executors', async () => {
    const forwards: GatewayForward[] = [];
    const executions: [ExecutorKind, ExecutionScope['kind']][] = [];
    const parts = () => ({
      ...recordingKernel(forwards, { authorization: 'ASK' }),
      ...recordingExecutors(executions),
    });
    await runSystem({ parts: parts() });
    // The second run is cancelled from the terminal while the question is open.
    const terminal = createFakeTerminal();
    const interrupting: TerminalPort = {
      ...terminal,
      askYesNo: (_question, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(undefined));
          setImmediate(() => terminal.interrupt());
        }),
    };
    await runSystem({
      parts: { ...parts(), createUserInteraction: referenceInteraction() },
      terminal: interrupting,
    });

    expect(new Set(forwards.map((forward) => `${forward.caller}:${forward.requestType}`))).toEqual(
      new Set([
        'user-interaction:createRun',
        'user-interaction:answerAuthorization',
        'user-interaction:cancelRun',
        'user-interaction:readArtifact',
        'user-interaction:shutdown',
        'workflow:registerAgentRun',
        'workflow:submitUnit',
        'workflow:endAgentRun',
        'workflow:closeRun',
      ]),
    );
    expect(new Set(executions.map(([kind, scope]) => `${kind}:${scope}`))).toEqual(
      new Set([
        'REPOSITORY_ORIENT:REPOSITORY',
        'REPOSITORY_SEARCH:REPOSITORY',
        'FILE_READ:REPOSITORY',
        'CONTEXT_ASSEMBLE:NONE',
        'MODEL:MODEL',
      ]),
    );
  });
});

describe('UserInteraction seat: every user path runs against the fake Kernel', () => {
  it('answers the question from the terminal and shows the report and the RunSummary', async () => {
    const run = await runSystem({
      parts: { createUserInteraction: referenceInteraction() },
      kernel: { authorization: 'ASK' },
      terminal: createFakeTerminal('YES'),
      details: true,
    });
    expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);
    expect(run.interactionEvents.map((event) => event.type)).toEqual([
      'AuthorizationRequest',
      'AuthorizationResolved',
      'RunFinished',
    ]);
    const shown = (label: string): unknown =>
      JSON.parse(
        run.written.find((text) => text.startsWith(`${label}:`))?.slice(label.length + 1) ?? 'null',
      );
    expect(validate(AnalysisReportSchema, shown('report'))).toMatchObject({ ok: true });
    expect(validate(RunSummarySchema, shown('summary'))).toMatchObject({ ok: true });
  });

  it('ends as FAILED after the user answers NO', async () => {
    const run = await runSystem({
      parts: { createUserInteraction: referenceInteraction() },
      kernel: { authorization: 'ASK' },
      terminal: createFakeTerminal('NO'),
    });
    expect(run.interactionEvents).toContainEqual(
      expect.objectContaining({ type: 'AuthorizationResolved', resolution: 'DECLINED' }),
    );
    expect(run.exitCode).toBe(EXIT_CODES.FAILED);
    expect(run.written).toContain('ended:FAILED');
  });

  it('cancels on interrupt, which also ends the open question', async () => {
    const terminal = createFakeTerminal();
    let questionEnded = false;
    const run = await runSystem({
      parts: { createUserInteraction: referenceInteraction() },
      kernel: { authorization: 'ASK' },
      terminal: {
        ...terminal,
        askYesNo: (_question, signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              questionEnded = true;
              resolve(undefined);
            });
            setImmediate(() => terminal.interrupt());
          }),
      },
    });
    expect(run.exitCode).toBe(EXIT_CODES.CANCELLED);
    expect(questionEnded).toBe(true);
    expect(run.interactionEvents).toContainEqual(
      expect.objectContaining({ type: 'AuthorizationResolved', resolution: 'CANCELLED' }),
    );
    expect(run.closed).toMatchObject({ closeReason: 'CANCELLED' });
  });
});
