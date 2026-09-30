import type {
  AgentDefinitionReader,
  DefinitionRef,
  KernelPort,
  ModelExecutorPort,
  ModuleRequest,
  ModuleResponse,
  Result,
  UnitCompletion,
  UnitDefinitionReader,
  UnitIntent,
  UserRequest,
  UserResponse,
  WorkflowPort,
} from './contracts.js';

type KernelDefinitions = AgentDefinitionReader & UnitDefinitionReader;

const MAX_UNIT_STEPS = 16;

function referencesMatch(left: DefinitionRef, right: DefinitionRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

function isModelInput(input: UnitIntent['input']): input is { readonly prompt: string } {
  return 'prompt' in input && typeof input.prompt === 'string';
}

function isReturnInput(input: UnitIntent['input']): input is { readonly answer: string } {
  return 'answer' in input && typeof input.answer === 'string';
}

export class MinimalKernel implements KernelPort {
  public constructor(
    private readonly workflow: WorkflowPort,
    private readonly modelExecutor: ModelExecutorPort,
    private readonly definitions: KernelDefinitions,
  ) {}

  public async run(request: UserRequest): Promise<Result<UserResponse>> {
    if (request.prompt.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: 'INVALID_PROMPT',
          message: 'Prompt must not be empty.',
          retryable: false,
        },
      };
    }

    const completedUnits: UnitCompletion[] = [];
    let workflowAgentRef: DefinitionRef | undefined;

    for (let stepIndex = 0; stepIndex < MAX_UNIT_STEPS; stepIndex += 1) {
      const workflowResult = await this.dispatch({
        target: 'WORKFLOW',
        input: {
          objective: request.prompt,
          completedUnits,
        },
      });

      if (!workflowResult.ok) return workflowResult;
      if (workflowResult.value.source !== 'WORKFLOW') {
        return failure(
          'UNEXPECTED_MODULE_RESPONSE',
          `Kernel expected WORKFLOW but received ${workflowResult.value.source}.`,
        );
      }

      const workflowOutput = workflowResult.value.output;
      if (workflowOutput.stepNumber !== stepIndex + 1) {
        return failure(
          'INVALID_UNIT_SEQUENCE',
          `Workflow returned step ${workflowOutput.stepNumber}; Kernel expected ${stepIndex + 1}.`,
        );
      }

      if (
        workflowAgentRef !== undefined &&
        !referencesMatch(workflowOutput.agentRef, workflowAgentRef)
      ) {
        return failure('INVALID_AGENT_SEQUENCE', 'Workflow changed Agent during an active run.');
      }

      const agentResult = await this.definitions.getAgent(workflowOutput.agentRef);
      if (!agentResult.ok) return agentResult;
      const agent = agentResult.value;
      workflowAgentRef = agent.ref;

      const intent = workflowOutput.nextUnit;
      const expectedRef = agent.unitRefs[stepIndex];
      if (expectedRef === undefined || !referencesMatch(intent.unitRef, expectedRef)) {
        return failure(
          'INVALID_UNIT_SEQUENCE',
          `Workflow returned an unexpected Unit at step ${stepIndex + 1}.`,
        );
      }

      const unitResult = await this.definitions.getUnit(intent.unitRef);
      if (!unitResult.ok) return unitResult;

      switch (unitResult.value.kind) {
        case 'MODEL_EXECUTOR': {
          if (completedUnits.length !== 0 || !isModelInput(intent.input)) {
            return failure(
              'INVALID_UNIT_INPUT',
              'MODEL_EXECUTOR must be the first Unit and requires a prompt.',
            );
          }

          const modelResult = await this.modelExecutor.execute({ prompt: intent.input.prompt });
          if (!modelResult.ok) return modelResult;
          completedUnits.push({ unitRef: intent.unitRef, output: modelResult.value });
          break;
        }
        case 'RETURN_RESULT': {
          const modelCompletion = completedUnits[0];
          if (
            completedUnits.length !== 1 ||
            modelCompletion === undefined ||
            !isReturnInput(intent.input) ||
            intent.input.answer !== modelCompletion.output.answer
          ) {
            return failure(
              'INVALID_UNIT_INPUT',
              'RETURN_RESULT must return the preceding MODEL_EXECUTOR answer unchanged.',
            );
          }
          return { ok: true, value: { answer: intent.input.answer } };
        }
      }
    }

    return failure(
      'WORKFLOW_STEP_LIMIT',
      `Workflow exceeded the ${MAX_UNIT_STEPS}-step Kernel limit without returning a result.`,
    );
  }

  public async dispatch(request: ModuleRequest): Promise<Result<ModuleResponse>> {
    switch (request.target) {
      case 'WORKFLOW': {
        const result = await this.workflow.run(request.input);
        return result.ok
          ? { ok: true, value: { source: 'WORKFLOW', output: result.value } }
          : result;
      }
      case 'FILE_READ_EXECUTOR':
        return {
          ok: false,
          error: {
            code: 'CAPABILITY_NOT_IMPLEMENTED',
            message: 'FILE_READ_EXECUTOR is intentionally not implemented in this stage.',
            retryable: false,
          },
        };
    }
  }
}
