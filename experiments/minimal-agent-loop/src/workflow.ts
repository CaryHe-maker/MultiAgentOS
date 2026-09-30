import type {
  AgentDefinitionReader,
  DefinitionRef,
  Result,
  UnitDefinitionReader,
  WorkflowOutput,
  WorkflowPort,
  WorkflowRequest,
} from './contracts.js';
import { ORIGIN_AGENT_REF } from './agent-tool-pool.js';

type WorkflowDefinitions = AgentDefinitionReader & UnitDefinitionReader;

function referencesMatch(left: DefinitionRef, right: DefinitionRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

export class MinimalWorkflow implements WorkflowPort {
  private readonly initialAgentRef = ORIGIN_AGENT_REF;

  public constructor(private readonly definitions: WorkflowDefinitions) {}

  public async run(request: WorkflowRequest): Promise<Result<WorkflowOutput>> {
    const agentResult = await this.definitions.getAgent(this.initialAgentRef);
    if (!agentResult.ok) return agentResult;

    const agent = agentResult.value;
    if (agent.promptPolicy !== 'PASSTHROUGH' || agent.unitRefs.length !== 2) {
      return failure('INVALID_AGENT_DEFINITION', 'Origin Agent must define exactly two Units.');
    }

    const modelUnitRef = agent.unitRefs[0];
    const returnUnitRef = agent.unitRefs[1];
    if (modelUnitRef === undefined || returnUnitRef === undefined) {
      return failure('INVALID_AGENT_DEFINITION', 'Origin Agent Unit sequence is incomplete.');
    }

    const modelUnitResult = await this.definitions.getUnit(modelUnitRef);
    if (!modelUnitResult.ok) return modelUnitResult;
    const returnUnitResult = await this.definitions.getUnit(returnUnitRef);
    if (!returnUnitResult.ok) return returnUnitResult;

    if (
      modelUnitResult.value.kind !== 'MODEL_EXECUTOR' ||
      returnUnitResult.value.kind !== 'RETURN_RESULT'
    ) {
      return failure(
        'INVALID_AGENT_DEFINITION',
        'Origin Agent Unit order must be MODEL_EXECUTOR followed by RETURN_RESULT.',
      );
    }

    if (request.completedUnits.length === 0) {
      return {
        ok: true,
        value: {
          agentRef: agent.ref,
          nextUnit: { unitRef: modelUnitRef, input: { prompt: request.objective } },
          stepNumber: 1,
        },
      };
    }

    if (request.completedUnits.length !== 1) {
      return failure('INVALID_UNIT_SEQUENCE', 'Origin Agent accepts exactly one Unit completion.');
    }

    const modelCompletion = request.completedUnits[0];
    if (modelCompletion === undefined || !referencesMatch(modelCompletion.unitRef, modelUnitRef)) {
      return failure(
        'INVALID_UNIT_SEQUENCE',
        'RETURN_RESULT requires completion of the configured MODEL_EXECUTOR Unit.',
      );
    }

    return {
      ok: true,
      value: {
        agentRef: agent.ref,
        nextUnit: {
          unitRef: returnUnitRef,
          input: { answer: modelCompletion.output.answer },
        },
        stepNumber: 2,
      },
    };
  }
}
