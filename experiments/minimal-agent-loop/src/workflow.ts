import type {
  AgentDefinitionReader,
  ContextReader,
  Result,
  WorkflowOutput,
  WorkflowPort,
  WorkflowRequest,
} from './contracts.js';
import { NotImplementedError } from './contracts.js';

export class MinimalWorkflow implements WorkflowPort {
  public constructor(
    private readonly definitions: AgentDefinitionReader,
    private readonly context: ContextReader,
  ) {}

  public run(_request: WorkflowRequest): Promise<Result<WorkflowOutput>> {
    void this.definitions;
    void this.context;
    void _request;
    return Promise.reject(new NotImplementedError('MinimalWorkflow', 'run'));
  }
}
