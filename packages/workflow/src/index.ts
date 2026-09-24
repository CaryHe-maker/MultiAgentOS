import { randomUUID } from 'node:crypto';
import type {
  BoundaryContext,
  CatalogPort,
  DefinitionVersion,
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
const queries = [
  ['AGENT', 'repository-analysis-agent'],
  ['MODEL', 'default-model'],
  ['TOOL', 'repository-read-tools'],
  ['PROMPT', 'repository-analysis-prompt'],
  ['CONTRACT', 'analysis-action'],
] as const;

export class WorkflowService implements WorkflowControlPort {
  readonly #runs = new Map<string, WorkflowRunView>();
  public constructor(
    private readonly catalog: CatalogPort,
    public readonly budgets: WorkflowBudgets = M1_BUDGETS,
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
    const definitions: DefinitionVersion[] = [];
    for (const [kind, definitionId] of queries) {
      const result = await this.catalog.resolve(
        { kind, definitionId, requiredCapabilities: [] },
        context,
      );
      if (!result.ok) return result;
      definitions.push(result.value);
    }
    const workflowRunId = id('wfr');
    const view: WorkflowRunView = Object.freeze({
      workflowRunId,
      status: 'CREATED',
      sourceVersion: 0,
      graphRevision: 0,
      currentStep: 'CONTEXT',
      definitionVersions: definitions,
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      evidenceRefs: [],
      updatedAt: new Date().toISOString(),
    });
    this.#runs.set(workflowRunId, view);
    return { ok: true, value: view };
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
