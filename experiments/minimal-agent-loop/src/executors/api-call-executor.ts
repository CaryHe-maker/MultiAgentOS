import type { ApiCallExecutorPort, ApiCallRequest, ApiCallResponse, Result } from '../contracts.js';
import { NotImplementedError } from '../contracts.js';

export class ApiCallExecutor implements ApiCallExecutorPort {
  public execute(_request: ApiCallRequest): Promise<Result<ApiCallResponse>> {
    void _request;
    return Promise.reject(new NotImplementedError('ApiCallExecutor', 'execute'));
  }
}
