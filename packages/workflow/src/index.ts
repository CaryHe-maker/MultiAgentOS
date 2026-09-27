import { randomUUID } from 'node:crypto';
import type {
  AgentPinRequest,
  BoundaryContext,
  CatalogPort,
  PinnedDefinitionSet,
  PortResult,
  RunUserIntent,
  WorkflowRunView,
} from '@multiagentos/contracts';

export interface WorkflowBudgets {
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}
export interface WorkflowControlPort {
  create(intent: RunUserIntent, context: BoundaryContext): Promise<PortResult<WorkflowRunView>>;
  inspect(workflowRunId: string, context: BoundaryContext): Promise<PortResult<WorkflowRunView>>;
}
export const M1_BUDGETS: WorkflowBudgets = Object.freeze({
  maxSteps: 24,
  maxModelCalls: 12,
  maxTokens: 120_000,
  timeoutMs: 30 * 60 * 1000,
});
const id = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '')}`;
/** The agent version M1 runs. Changing it is a deliberate, reviewed change. */
export const M1_AGENT: AgentPinRequest = Object.freeze({
  id: 'repository-analysis-agent',
  version: 'v0.1.0',
});

export class WorkflowService implements WorkflowControlPort {
  readonly #runs = new Map<string, WorkflowRunView>();
  /** Definitions fixed at run creation; later steps read only from here. */
  readonly #pinnedDefinitions = new Map<string, PinnedDefinitionSet>();
  public constructor(
    private readonly catalog: CatalogPort,
    public readonly budgets: WorkflowBudgets = M1_BUDGETS,
    private readonly agent: AgentPinRequest = M1_AGENT,
  ) {
    if (
      budgets.maxSteps < 1 ||
      budgets.maxModelCalls < 1 ||
      budgets.maxTokens < 1 ||
      budgets.timeoutMs < 1
    )
      throw new Error('Workflow budgets must be positive');
  }
  async create(
    _intent: RunUserIntent,
    context: BoundaryContext,
  ): Promise<PortResult<WorkflowRunView>> {
    const pinned = await this.catalog.pinAgent(this.agent, context);
    if (!pinned.ok) return pinned;
    const workflowRunId = id('wfr');
    const view: WorkflowRunView = Object.freeze({
      workflowRunId,
      status: 'CREATED',
      sourceVersion: 0,
      graphRevision: 0,
      currentStep: 'CONTEXT',
      pinnedDefinitions: [...pinned.value.refs],
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      evidenceRefs: [],
      updatedAt: new Date().toISOString(),
    });
    this.#runs.set(workflowRunId, view);
    this.#pinnedDefinitions.set(workflowRunId, pinned.value);
    return { ok: true, value: view };
  }
  /** The definition set pinned when the run was created; later steps must use only this. */
  pinnedDefinitions(workflowRunId: string): PinnedDefinitionSet | undefined {
    return this.#pinnedDefinitions.get(workflowRunId);
  }
  inspect(workflowRunId: string, context: BoundaryContext): Promise<PortResult<WorkflowRunView>> {
    const run = this.#runs.get(workflowRunId);
    if (!run)
      return Promise.resolve({
        ok: false,
        error: {
          code: 'WORKFLOW_NOT_FOUND',
          category: 'VALIDATION',
          message: `Workflow not found: ${workflowRunId}`,
          retryable: false,
          correlationId: context.correlationId,
        },
      });
    return Promise.resolve({ ok: true, value: run });
  }
}
