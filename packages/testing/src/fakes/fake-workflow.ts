import {
  REASON_CODE_CATEGORY,
  newId,
  type ArtifactRef,
  type BoundaryContext,
  type KernelToWorkflowEvent,
  type PinnedDefinitionRef,
  type PinnedDefinitionSet,
  type ReasonCode,
  type SyscallAck,
  type SyscallRejected,
  type UnitInput,
  type UnitReport,
  type WorkflowInboxEvent,
} from '@multiagentos/contracts';
import { Inbox } from '@multiagentos/fabric';
import type { WorkflowDeps, WorkflowModule } from '@multiagentos/workflow';
import { FAKE_FILE, cannedReport } from '../fixtures/canned.js';

/**
 * Workflow stand-in for Kernel and UserInteraction work. It pins the entry agent and its
 * handoff target, registers the target's AgentRun and submits each of its Units once, in a
 * fixed order, ending with report-publish and closeRun. It interprets no model output and has
 * no Round, Validation, failurePolicy or source check: any rejection or failed Unit makes it
 * close the run as FAILED.
 */
export interface FakeWorkflowModule extends WorkflowModule {
  /** Every event received so far, in order. */
  readonly events: readonly KernelToWorkflowEvent[];
}

type ExecutionKind = UnitReport['executionKind'];
const UNIT_ORDER: readonly ExecutionKind[] = [
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'FILE_READ',
  'CONTEXT_ASSEMBLE',
  'MODEL',
  'REPORT_PUBLISH',
];

export function createFakeWorkflow(): (deps: WorkflowDeps) => FakeWorkflowModule {
  return (deps) => {
    const events: KernelToWorkflowEvent[] = [];
    const inbox = new Inbox<WorkflowInboxEvent>({
      channels: ['default'],
      dedupeKey: (event) => event.eventId,
    });
    let goal = '';
    let agentRunId = '';
    let pinned: PinnedDefinitionSet | undefined;
    let remaining: ExecutionKind[] = [];
    const refs: { orient?: ArtifactRef; assemble?: ArtifactRef } = {};
    let closing = false;

    const contextOf = (workflowRunId: string): BoundaryContext => ({
      correlationId: newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      workflowRunId,
    });
    const accepted = (response: SyscallAck | SyscallRejected) => response.outcome === 'ACCEPTED';

    const fail = async (workflowRunId: string, code: ReasonCode) => {
      if (closing) return;
      closing = true;
      await deps.gateway.closeRun(
        {
          requestId: newId('req'),
          workflowRunId,
          outcome: 'FAILED',
          failure: { code, category: REASON_CODE_CATEGORY[code], source: 'WORKFLOW' },
        },
        contextOf(workflowRunId),
      );
    };

    const inputOf = (workflowRunId: string, kind: ExecutionKind): UnitInput => {
      switch (kind) {
        case 'REPOSITORY_ORIENT':
          return { objective: goal };
        case 'REPOSITORY_SEARCH':
          return { query: 'README' };
        case 'FILE_READ':
          return { path: FAKE_FILE.path };
        case 'CONTEXT_ASSEMBLE':
          return {
            objective: goal,
            final: false,
            ...(refs.orient === undefined ? {} : { orientPackRef: refs.orient }),
            steps: [],
            status: { roundsUsed: 0, maxRounds: 1, final: false, budgetState: 'NORMAL' },
          };
        case 'MODEL':
          if (refs.assemble === undefined) throw new Error('context-assemble did not run');
          return { contextPackRef: refs.assemble, final: false };
        default:
          return { report: cannedReport(workflowRunId, goal) };
      }
    };

    const submitNext = async (workflowRunId: string) => {
      const kind = remaining.shift();
      const unit = pinned?.units.find((candidate) => candidate.executionKind === kind);
      if (kind === undefined || unit === undefined) return;
      const unitRef: PinnedDefinitionRef = {
        kind: 'UNIT',
        id: unit.id,
        version: unit.version,
        digest: unit.digest,
      };
      const response = await deps.gateway.submitUnit(
        {
          requestId: newId('req'),
          workflowRunId,
          agentRunId,
          unitRef,
          input: inputOf(workflowRunId, kind),
        },
        contextOf(workflowRunId),
      );
      if (response.outcome === 'REJECTED' && response.reasonCode !== 'RUN_BLOCKED')
        await fail(workflowRunId, response.reasonCode);
    };

    const start = async (workflowRunId: string) => {
      const context = contextOf(workflowRunId);
      const entry = await deps.catalog.pinAgent(deps.config.entryAgentRef, context);
      const targetRef = entry.ok ? entry.value.handoffTargetRef : undefined;
      const target =
        entry.ok && targetRef !== undefined
          ? await deps.catalog.pinAgent({ id: targetRef.id, version: targetRef.version }, context)
          : entry;
      if (!target.ok) return await fail(workflowRunId, 'PIN_FAILED');
      pinned = target.value;
      agentRunId = newId('agr');
      const { id, version, digest } = pinned.agent;
      const registered = await deps.gateway.registerAgentRun(
        {
          requestId: newId('req'),
          workflowRunId,
          agentRunId,
          agentRef: { kind: 'AGENT', id, version, digest },
        },
        context,
      );
      if (registered.outcome === 'REJECTED')
        return await fail(workflowRunId, registered.reasonCode);
      const available = new Set(pinned.units.map((unit) => unit.executionKind));
      remaining = UNIT_ORDER.filter((kind) => available.has(kind));
      await submitNext(workflowRunId);
    };

    const onReport = async (workflowRunId: string, report: UnitReport) => {
      if (report.status !== 'OK') return await fail(workflowRunId, report.reasonCode);
      if (report.executionKind === 'REPOSITORY_ORIENT') refs.orient = report.outputRef;
      if (report.executionKind === 'CONTEXT_ASSEMBLE') refs.assemble = report.outputRef;
      if (report.executionKind !== 'REPORT_PUBLISH') return await submitNext(workflowRunId);
      const context = contextOf(workflowRunId);
      const ended = await deps.gateway.endAgentRun(
        { requestId: newId('req'), workflowRunId, agentRunId },
        context,
      );
      if (!accepted(ended) || closing) return;
      closing = true;
      await deps.gateway.closeRun(
        {
          requestId: newId('req'),
          workflowRunId,
          outcome: 'COMPLETED',
          reportRef: report.outputRef,
        },
        context,
      );
    };

    return {
      manifest: { moduleId: 'workflow', version: '0.0.0-fake', dependencies: ['gateway'] },
      events,
      inbox: {
        deliver: (event) => {
          inbox.enqueue(event);
          return Promise.resolve();
        },
      },
      start: () => {
        inbox.start(async ({ workflowRunId, event }) => {
          events.push(event);
          if (event.type === 'RunStart') {
            goal = event.goal;
            await start(workflowRunId);
          } else if (event.type === 'UnitReport') await onReport(workflowRunId, event);
        });
        return Promise.resolve();
      },
      stop: () => inbox.idle(),
      health: () =>
        Promise.resolve({ status: 'UP', checkedAt: new Date().toISOString(), details: ['fake'] }),
    };
  };
}
