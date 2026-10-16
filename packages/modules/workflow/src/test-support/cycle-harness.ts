import {
  MEDIA_TYPES,
  UnitReportSchema,
  assertValid,
  newId,
  createM1ProtocolRegistry,
} from '@multiagentos/contracts';
import type {
  ModelCallOutput,
  PinnedDefinitionSet,
  UnitFailedCode,
  UnitReport,
  WorkflowInboxEvent,
} from '@multiagentos/contracts';
import { createWorkflow, DEFAULT_WORKFLOW_CONFIG } from '../index.js';
import { cycleDefinitions } from './cycle-definitions.js';
import { FixedCatalog } from './fixed-catalog.js';
import { MemoryPersistence } from './memory-persistence.js';
import { ScriptedGateway } from './scripted-gateway.js';

export const finishOutput: ModelCallOutput = {
  hasText: false,
  finishReason: 'TOOL_CALLS',
  toolCalls: [
    {
      toolCallId: 'finish',
      toolName: 'finish_analysis',
      arguments: {
        summary: '分析完成',
        conclusions: [],
        unconfirmed: [],
      },
    },
  ],
};

export interface CycleHarnessOptions {
  readonly entry?: PinnedDefinitionSet;
  readonly target?: PinnedDefinitionSet;
  readonly modelOutputs?: readonly ModelCallOutput[];
  readonly modelFailure?: UnitFailedCode;
  readonly failFinalOnly?: boolean;
  readonly modelBudget?: UnitReport['budgetState'];
  readonly readIsEmpty?: boolean;
  readonly beforeAck?: boolean;
  readonly reverseTools?: boolean;
  readonly failPublication?: boolean;
  readonly rejectEnd?: boolean;
  readonly rejectTargetRegistration?: boolean;
  readonly closeEarly?: boolean;
  readonly persistence?: MemoryPersistence;
}

/** Runs the public factory against module-local ports; no shared fake or product Kernel is used. */
export async function runWorkflowCase(options: CycleHarnessOptions = {}) {
  const gateway = new ScriptedGateway();
  const persistence = options.persistence ?? new MemoryPersistence();
  const entry = options.entry ?? cycleDefinitions();
  const sets = [entry, ...(options.target === undefined ? [] : [options.target])];
  const catalog = new FixedCatalog(sets);
  const faults: unknown[] = [];
  const deliveryTasks: Promise<void>[] = [];
  const errors: unknown[] = [];
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const module = createWorkflow({
    gateway,
    catalog,
    persistence,
    registry: createM1ProtocolRegistry(),
    config: {
      ...DEFAULT_WORKFLOW_CONFIG,
      entryAgentRef: { id: entry.agent.id, version: entry.agent.version },
    },
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    reportSystemFault: (fault) => {
      faults.push(fault);
      resolveEnded();
    },
  });
  gateway.inbox = module.inbox;
  const workflowRunId = newId('wfr');
  let seq = 0;
  let modelIndex = 0;
  const agents = new Map<string, PinnedDefinitionSet>();
  const buffered: UnitReport[] = [];
  const emitted: WorkflowInboxEvent[] = [];
  const reference = (mediaType: string) => ({
    artifactId: `art_${'a'.repeat(64)}`,
    mediaType,
    sha256: 'a'.repeat(64),
    size: 10,
  });
  async function emit(event: WorkflowInboxEvent['event']): Promise<void> {
    const envelope: WorkflowInboxEvent = {
      eventId: newId('evt'),
      workflowRunId,
      seq: ++seq,
      occurredAt: '2026-10-14T00:00:00.000Z',
      event,
    };
    emitted.push(envelope);
    await gateway.deliver(envelope);
  }
  gateway.handler = async (call) => {
    if (call.kind === 'REGISTER') {
      if (options.rejectTargetRegistration === true && agents.size > 0)
        return {
          requestId: call.request.requestId,
          outcome: 'REJECTED',
          issuer: 'CORE',
          reasonCode: 'FORBIDDEN',
        };
      const set = sets.find((candidate) => candidate.agent.id === call.request.agentRef.id);
      if (set === undefined) throw new Error('Missing registered fixture');
      agents.set(call.request.agentRunId, set);
    }
    if (call.kind === 'END' && options.rejectEnd === true)
      return {
        requestId: call.request.requestId,
        outcome: 'REJECTED',
        issuer: 'CORE',
        reasonCode: 'FORBIDDEN',
      };
    if (call.kind === 'CLOSE') {
      const request = call.request;
      await emit({
        type: 'RunClosed',
        closeReason: request.outcome,
        unknownEffects: [],
        finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
        ...(request.outcome === 'FAILED'
          ? { failure: request.failure }
          : { reportRef: request.reportRef }),
      } as WorkflowInboxEvent['event']);
      resolveEnded();
    }
    if (call.kind === 'SUBMIT') {
      const request = call.request;
      const set = agents.get(request.agentRunId);
      const unit = set?.units.find((candidate) => candidate.id === request.unitRef.id);
      if (unit === undefined) throw new Error('Missing submitted fixture Unit');
      if (options.closeEarly === true) {
        await emit({
          type: 'RunClosed',
          closeReason: 'CANCELLED',
          unknownEffects: [],
          finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
        });
        resolveEnded();
        return { requestId: request.requestId, outcome: 'ACCEPTED' };
      }
      const common = {
        type: 'UnitReport',
        requestId: request.requestId,
        agentRunId: request.agentRunId,
        unitRef: request.unitRef,
        unitAttemptId: newId('una'),
        executionKind: unit.executionKind,
        budgetState: 'NORMAL',
      };
      let output: unknown;
      let mediaType: string = MEDIA_TYPES.contextPack;
      let code: UnitFailedCode | undefined;
      switch (unit.executionKind) {
        case 'CONTEXT_ASSEMBLE':
          output = {
            contextPackId: newId('ctx'),
            tokenCount: 10,
            tokenBudget: 100,
            truncated: false,
            droppedCount: 0,
            prefixSha256: 'a'.repeat(64),
            elidedRequestIds: [],
          };
          break;
        case 'MODEL':
          output = options.modelOutputs?.[modelIndex++] ?? finishOutput;
          mediaType = MEDIA_TYPES.modelOutput;
          if (options.failFinalOnly !== true || ('final' in request.input && request.input.final))
            code = options.modelFailure;
          common.budgetState = options.modelBudget ?? 'NORMAL';
          break;
        case 'REPOSITORY_ORIENT':
          output = {
            snapshotId: `snp_${'b'.repeat(64)}`,
            fileCount: 1,
            totalBytes: 10,
            summary: '仓库概况',
            tokenCount: 10,
            truncated: false,
          };
          break;
        case 'FILE_READ':
          output = {
            path: 'path' in request.input ? request.input.path : 'fixture.ts',
            startLine: 1,
            endLine: options.readIsEmpty === true ? 0 : 10,
            totalLines: options.readIsEmpty === true ? 0 : 10,
            contentSha256: 'a'.repeat(64),
            fileSha256: 'b'.repeat(64),
          };
          mediaType = MEDIA_TYPES.fileText;
          break;
        case 'REPORT_PUBLISH':
          if (!('report' in request.input)) throw new Error('Missing report input');
          output = {
            conclusionCount: request.input.report.conclusions.length,
            unconfirmedCount: request.input.report.unconfirmed.length,
            degraded: request.input.report.degraded,
          };
          mediaType = MEDIA_TYPES.analysisReport;
          if (options.failPublication === true) code = 'INTERNAL';
          break;
        default:
          throw new Error('Unsupported harness Unit');
      }
      const report = assertValid<UnitReport>(
        UnitReportSchema,
        code === undefined
          ? { ...common, status: 'OK', output, outputRef: reference(mediaType) }
          : { ...common, status: 'FAILED', reasonCode: code },
      );
      const dispatch = async () => {
        if (options.reverseTools === true && unit.executionKind === 'FILE_READ') {
          buffered.push(report);
          if (buffered.length === 2)
            for (const pending of buffered.splice(0).reverse()) await emit(pending);
        } else await emit(report);
      };
      if (options.beforeAck !== false) await dispatch();
      else
        deliveryTasks.push(
          new Promise<void>((resolve) => {
            setImmediate(() => {
              dispatch().then(resolve, (error: unknown) => {
                errors.push(error);
                resolveEnded();
                resolve();
              });
            });
          }),
        );
    }
    return { requestId: call.request.requestId, outcome: 'ACCEPTED' };
  };
  await module.start();
  await emit({ type: 'RunStart', goal: '分析仓库' });
  await ended;
  await Promise.all(deliveryTasks);
  await module.stop();
  if (errors.length > 0) throw errors[0];
  return { module, gateway, persistence, catalog, faults, emitted, workflowRunId };
}
