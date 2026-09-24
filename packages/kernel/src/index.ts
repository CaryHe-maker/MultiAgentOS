import { randomUUID } from 'node:crypto';
import type {
  ArtifactStorePort,
  BoundaryContext,
  ContextPort,
  ContextRequest,
  KernelControlPort,
  KernelUnitPort,
  PortResult,
  RunUserIntent,
  RuntimeProjection,
  UnitIntent,
  UnitResult,
  UserIntent,
  WorkflowRunView,
} from '@multiagentos/contracts';
import {
  assertValid,
  BoundaryContextSchema,
  ContextRequestSchema,
  UnitIntentSchema,
  unsupported,
  UserIntentSchema,
} from '@multiagentos/contracts';

export interface WorkflowControlAdapter {
  create(intent: RunUserIntent, context: BoundaryContext): Promise<PortResult<WorkflowRunView>>;
  inspect(workflowRunId: string, context: BoundaryContext): Promise<PortResult<WorkflowRunView>>;
}
export interface ExecutionAdapter {
  execute(intent: UnitIntent, context: BoundaryContext): Promise<UnitResult>;
}

export class Kernel implements KernelControlPort, KernelUnitPort {
  public constructor(
    private readonly workflow: WorkflowControlAdapter,
    private readonly context: ContextPort,
    private readonly artifacts: ArtifactStorePort,
    private readonly executor: ExecutionAdapter,
  ) {}
  async submit(
    rawIntent: UserIntent,
    rawContext: BoundaryContext,
  ): Promise<PortResult<RuntimeProjection>> {
    const context = assertValid<BoundaryContext>(BoundaryContextSchema, rawContext);
    let intent: UserIntent;
    try {
      intent = assertValid<UserIntent>(UserIntentSchema, rawIntent);
    } catch {
      return {
        ok: false,
        error: {
          code: 'INVALID_USER_INTENT',
          category: 'VALIDATION',
          message: 'UserIntent failed contract validation',
          retryable: false,
          correlationId: context.correlationId,
        },
      };
    }
    if (intent.kind === 'RUN') {
      const result = await this.workflow.create(intent, context);
      return result.ok ? { ok: true, value: this.#project(result.value) } : result;
    }
    if (intent.kind === 'INSPECT' || intent.kind === 'REPORT') {
      const result = await this.workflow.inspect(intent.workflowRunId, context);
      return result.ok ? { ok: true, value: this.#project(result.value) } : result;
    }
    return {
      ok: false,
      error: unsupported(
        `kernel.control.${intent.kind.toLowerCase()}`,
        'interaction.UserIntent.v0',
        context.correlationId,
      ),
    };
  }
  #project(view: WorkflowRunView): RuntimeProjection {
    return Object.freeze({ ...view });
  }
  async execute(rawIntent: UnitIntent, rawContext: BoundaryContext): Promise<UnitResult> {
    const started = Date.now();
    const context = assertValid<BoundaryContext>(BoundaryContextSchema, rawContext);
    const intent = assertValid<UnitIntent>(UnitIntentSchema, rawIntent);
    if (Date.parse(intent.deadline) <= Date.now())
      return this.#failure(
        intent,
        'TIMED_OUT',
        'UNIT_DEADLINE_EXCEEDED',
        'TIMEOUT',
        started,
        context.correlationId,
      );
    if (intent.executionKind !== 'CONTEXT') return await this.executor.execute(intent, context);
    try {
      const request = assertValid<ContextRequest>(ContextRequestSchema, intent.input);
      if (request.workspace.workspaceId !== intent.workspace.workspaceId)
        return this.#failure(
          intent,
          'FAILED',
          'WORKSPACE_MISMATCH',
          'POLICY',
          started,
          context.correlationId,
        );
      const pack = await this.context.buildContext(request, context);
      const outputRef = await this.artifacts.put(
        Buffer.from(JSON.stringify(pack)),
        'application/vnd.multiagentos.context-pack+json',
      );
      return Object.freeze({
        schemaVersion: 'v0',
        unitIntentId: intent.unitIntentId,
        unitAttemptId: `una_${randomUUID().replaceAll('-', '')}`,
        status: 'SUCCEEDED',
        outputRef,
        evidenceRefs: [],
        usage: { inputTokens: 0, outputTokens: pack.tokenCount, durationMs: Date.now() - started },
        completedAt: new Date().toISOString(),
      });
    } catch {
      return this.#failure(
        intent,
        'FAILED',
        'CONTEXT_EXECUTION_FAILED',
        'EXECUTION',
        started,
        context.correlationId,
      );
    }
  }
  #failure(
    intent: UnitIntent,
    status: 'FAILED' | 'TIMED_OUT',
    code: string,
    category: 'TIMEOUT' | 'POLICY' | 'EXECUTION',
    started: number,
    correlationId = `cor_${randomUUID().replaceAll('-', '')}`,
  ): UnitResult {
    return Object.freeze({
      schemaVersion: 'v0',
      unitIntentId: intent.unitIntentId,
      unitAttemptId: `una_${randomUUID().replaceAll('-', '')}`,
      status,
      evidenceRefs: [],
      usage: { inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started },
      error: {
        code,
        category,
        message: code,
        retryable: false,
        correlationId,
      },
      completedAt: new Date().toISOString(),
    });
  }
}

export class UnsupportedExecutionAdapter implements ExecutionAdapter {
  execute(intent: UnitIntent, context: BoundaryContext): Promise<UnitResult> {
    return Promise.resolve({
      schemaVersion: 'v0',
      unitIntentId: intent.unitIntentId,
      unitAttemptId: `una_${randomUUID().replaceAll('-', '')}`,
      status: 'FAILED',
      evidenceRefs: [],
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      error: unsupported(
        `executor.${intent.executionKind.toLowerCase()}`,
        'kernel.unit.UnitIntent.v0',
        context.correlationId,
      ),
      completedAt: new Date().toISOString(),
    });
  }
}
