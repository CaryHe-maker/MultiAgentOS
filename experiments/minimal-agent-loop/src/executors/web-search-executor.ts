import type {
  Result,
  WebSearchExecutorPort,
  WebSearchRequest,
  WebSearchResponse,
} from '../contracts.js';
import { NotImplementedError } from '../contracts.js';

export class WebSearchExecutor implements WebSearchExecutorPort {
  public execute(_request: WebSearchRequest): Promise<Result<WebSearchResponse>> {
    void _request;
    return Promise.reject(new NotImplementedError('WebSearchExecutor', 'execute'));
  }
}
