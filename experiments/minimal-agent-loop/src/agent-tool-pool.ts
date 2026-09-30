import type {
  AgentDefinition,
  AgentToolPoolPort,
  DefinitionRef,
  PromptTemplate,
  Result,
  ToolDefinition,
  UnitDefinition,
} from './contracts.js';
import { NotImplementedError } from './contracts.js';

export const ORIGIN_AGENT_REF: DefinitionRef = Object.freeze({
  id: 'origin-agent',
  version: '1.0.0',
});

export const ORIGIN_MODEL_UNIT_REF: DefinitionRef = Object.freeze({
  id: 'origin-model-executor-unit',
  version: '1.0.0',
});

export const ORIGIN_RETURN_UNIT_REF: DefinitionRef = Object.freeze({
  id: 'origin-return-result-unit',
  version: '1.0.0',
});

const ORIGIN_MODEL_UNIT: UnitDefinition = Object.freeze({
  ref: ORIGIN_MODEL_UNIT_REF,
  name: 'Origin Model Executor',
  kind: 'MODEL_EXECUTOR',
  description: 'Pass the user input through unchanged as the model prompt.',
});

const ORIGIN_RETURN_UNIT: UnitDefinition = Object.freeze({
  ref: ORIGIN_RETURN_UNIT_REF,
  name: 'Origin Return Result',
  kind: 'RETURN_RESULT',
  description: 'Return the preceding model result to the user without modification.',
});

const ORIGIN_AGENT: AgentDefinition = Object.freeze({
  ref: ORIGIN_AGENT_REF,
  name: 'Origin Agent',
  promptPolicy: 'PASSTHROUGH',
  unitRefs: Object.freeze([ORIGIN_MODEL_UNIT_REF, ORIGIN_RETURN_UNIT_REF]),
});

function referencesMatch(left: DefinitionRef, right: DefinitionRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function notFound(kind: string, ref: DefinitionRef): Result<never> {
  return {
    ok: false,
    error: {
      code: 'DEFINITION_NOT_FOUND',
      message: `${kind} definition ${ref.id}@${ref.version} was not found.`,
      retryable: false,
    },
  };
}

export class AgentToolPool implements AgentToolPoolPort {
  public getAgent(ref: DefinitionRef): Promise<Result<AgentDefinition>> {
    return Promise.resolve(
      referencesMatch(ref, ORIGIN_AGENT_REF)
        ? { ok: true, value: ORIGIN_AGENT }
        : notFound('Agent', ref),
    );
  }

  public getUnit(ref: DefinitionRef): Promise<Result<UnitDefinition>> {
    if (referencesMatch(ref, ORIGIN_MODEL_UNIT_REF)) {
      return Promise.resolve({ ok: true, value: ORIGIN_MODEL_UNIT });
    }
    if (referencesMatch(ref, ORIGIN_RETURN_UNIT_REF)) {
      return Promise.resolve({ ok: true, value: ORIGIN_RETURN_UNIT });
    }
    return Promise.resolve(notFound('Unit', ref));
  }

  public getTools(_refs: readonly DefinitionRef[]): Promise<Result<readonly ToolDefinition[]>> {
    void _refs;
    return Promise.reject(new NotImplementedError('AgentToolPool', 'getTools'));
  }

  public getPrompt(_ref: DefinitionRef): Promise<Result<PromptTemplate>> {
    void _ref;
    return Promise.reject(new NotImplementedError('AgentToolPool', 'getPrompt'));
  }
}
