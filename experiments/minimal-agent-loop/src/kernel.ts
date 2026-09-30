import type {
  AgentDefinitionReader,
  ContextReader,
  DefinitionRef,
  ExperimentError,
  FileReadExecutorPort,
  KernelPort,
  ModelExecutorPort,
  Result,
  UnitAttempt,
  UnitAttemptStatus,
  UnitCompletion,
  UnitDefinitionReader,
  UnitIntent,
  UnitOutput,
  UserRequest,
  UserResponse,
  WorkflowDecision,
  WorkflowPort,
} from './contracts.js';

type KernelDefinitions = AgentDefinitionReader & UnitDefinitionReader;

const MAX_UNIT_STEPS = 64;

function referencesMatch(left: DefinitionRef, right: DefinitionRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function failure(code: string, message: string, retryable = false): Result<never> {
  return { ok: false, error: { code, message, retryable } };
}

function unitIsAllowed(allowed: readonly DefinitionRef[], unitRef: DefinitionRef): boolean {
  return allowed.some((ref) => referencesMatch(ref, unitRef));
}

export class MinimalKernel implements KernelPort {
  private readonly attempts = new Map<string, UnitAttempt>();
  private workflowRunSequence = 0;

  public constructor(
    private readonly workflow: WorkflowPort,
    private readonly contextEngine: ContextReader,
    private readonly modelExecutor: ModelExecutorPort,
    private readonly fileReadExecutor: FileReadExecutorPort,
    private readonly definitions: KernelDefinitions,
  ) {}

  public getUnitAttempt(unitAttemptId: string): UnitAttempt | undefined {
    return this.attempts.get(unitAttemptId);
  }

  public async run(request: UserRequest): Promise<Result<UserResponse>> {
    if (request.prompt.trim().length === 0) {
      return failure('INVALID_PROMPT', 'Prompt must not be empty.');
    }

    this.workflowRunSequence += 1;
    const workflowRunId = `workflow-run-${this.workflowRunSequence}`;
    let decisionResult = await this.workflow.start({
      workflowRunId,
      objective: request.prompt,
      ...(request.repository === undefined ? {} : { repository: request.repository }),
    });

    for (let step = 0; step < MAX_UNIT_STEPS; step += 1) {
      if (!decisionResult.ok) return decisionResult;
      const decision: WorkflowDecision = decisionResult.value;
      if (decision.kind === 'COMPLETE') return { ok: true, value: decision.response };
      if (decision.kind === 'FAILED') return { ok: false, error: decision.error };

      const completion = await this.executeUnit(decision.intent);
      decisionResult = await this.workflow.resume(decision.state, completion);
    }

    return failure(
      'WORKFLOW_STEP_LIMIT',
      `Workflow exceeded the ${MAX_UNIT_STEPS}-step limit without returning a result.`,
    );
  }

  private async executeUnit(intent: UnitIntent): Promise<UnitCompletion> {
    const unitAttemptId = `${intent.unitIntentId}:attempt:1`;
    this.transitionAttempt(unitAttemptId, intent.unitIntentId, 'CREATED');
    this.transitionAttempt(unitAttemptId, intent.unitIntentId, 'ADMISSION_CHECKING');

    const admission = await this.admit(intent);
    if (!admission.ok) {
      this.transitionAttempt(unitAttemptId, intent.unitIntentId, 'REJECTED');
      return this.completion(intent, unitAttemptId, 'REJECTED', undefined, admission.error);
    }

    this.transitionAttempt(unitAttemptId, intent.unitIntentId, 'ADMITTED');
    this.transitionAttempt(unitAttemptId, intent.unitIntentId, 'RUNNING');

    try {
      const execution = await this.route(intent);
      if (!execution.ok) {
        this.transitionAttempt(unitAttemptId, intent.unitIntentId, 'FAILED');
        return this.completion(intent, unitAttemptId, 'FAILED', undefined, execution.error);
      }
      this.transitionAttempt(unitAttemptId, intent.unitIntentId, 'SUCCEEDED');
      return this.completion(intent, unitAttemptId, 'SUCCEEDED', execution.value);
    } catch (error: unknown) {
      this.transitionAttempt(unitAttemptId, intent.unitIntentId, 'FAILED');
      const detail = error instanceof Error ? error.message : String(error);
      return this.completion(intent, unitAttemptId, 'FAILED', undefined, {
        code: 'UNIT_EXECUTION_EXCEPTION',
        message: detail,
        retryable: false,
      });
    }
  }

  private async admit(intent: UnitIntent): Promise<Result<void>> {
    const agent = await this.definitions.getAgent(intent.agentRef);
    if (!agent.ok) return agent;
    if (!unitIsAllowed(agent.value.allowedUnitRefs, intent.unitRef)) {
      return failure(
        'UNIT_NOT_ALLOWED',
        `${agent.value.name} is not allowed to use ${intent.unitRef.id}.`,
      );
    }
    const unit = await this.definitions.getUnit(intent.unitRef);
    if (!unit.ok) return unit;
    if (unit.value.kind !== intent.input.kind) {
      return failure(
        'UNIT_INPUT_MISMATCH',
        `${unit.value.kind} Unit received ${intent.input.kind} input.`,
      );
    }
    return { ok: true, value: undefined };
  }

  private async route(intent: UnitIntent): Promise<Result<UnitOutput>> {
    switch (intent.input.kind) {
      case 'CONTEXT_BUILD': {
        const result = await this.contextEngine.build(intent.input.request);
        return result.ok
          ? { ok: true, value: { kind: 'CONTEXT_BUILD', context: result.value } }
          : result;
      }
      case 'MODEL_CALL': {
        const result = await this.modelExecutor.execute(intent.input.request);
        return result.ok
          ? { ok: true, value: { kind: 'MODEL_CALL', response: result.value } }
          : result;
      }
      case 'REPOSITORY_VIEW': {
        const result = await this.fileReadExecutor.view(intent.input.request);
        return result.ok
          ? { ok: true, value: { kind: 'REPOSITORY_VIEW', overview: result.value } }
          : result;
      }
      case 'FILE_READ': {
        const result = await this.fileReadExecutor.read(intent.input.request);
        return result.ok
          ? {
              ok: true,
              value: {
                kind: 'FILE_READ',
                observation: {
                  callId: intent.input.callId,
                  toolName: 'file_read',
                  input: intent.input.request.input,
                  output: result.value,
                },
              },
            }
          : result;
      }
      case 'RETURN_RESULT':
        return {
          ok: true,
          value: { kind: 'RETURN_RESULT', response: intent.input.response },
        };
    }
  }

  private completion(
    intent: UnitIntent,
    unitAttemptId: string,
    outcome: UnitCompletion['outcome'],
    output?: UnitOutput,
    error?: ExperimentError,
  ): UnitCompletion {
    return {
      unitIntentId: intent.unitIntentId,
      unitAttemptId,
      attemptNumber: 1,
      agentRunId: intent.agentRunId,
      unitRef: intent.unitRef,
      outcome,
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
    };
  }

  private transitionAttempt(
    unitAttemptId: string,
    unitIntentId: string,
    status: UnitAttemptStatus,
  ): void {
    const current = this.attempts.get(unitAttemptId);
    const history = current === undefined ? [status] : [...current.history, status];
    this.attempts.set(unitAttemptId, {
      unitAttemptId,
      unitIntentId,
      attemptNumber: 1,
      status,
      history,
    });
  }
}
