import type {
  AgentDefinition,
  AgentToolPoolPort,
  DefinitionRef,
  PromptTemplate,
  Result,
  ToolDefinition,
} from './contracts.js';
import { NotImplementedError } from './contracts.js';

export class AgentToolPool implements AgentToolPoolPort {
  public getAgent(_ref: DefinitionRef): Promise<Result<AgentDefinition>> {
    void _ref;
    return Promise.reject(new NotImplementedError('AgentToolPool', 'getAgent'));
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
