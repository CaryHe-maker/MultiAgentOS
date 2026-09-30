import type { ModelExecutorPort, ModelRequest, ModelResponse, Result } from '../contracts.js';
import { NotImplementedError } from '../contracts.js';

export class ModelExecutor implements ModelExecutorPort {
  public execute(_request: ModelRequest): Promise<Result<ModelResponse>> {
    void _request;
    return Promise.reject(new NotImplementedError('ModelExecutor', 'execute'));
  }
}
