import type {
  FileReadExecutorPort,
  FileReadRequest,
  FileReadResponse,
  Result,
} from '../contracts.js';
import { NotImplementedError } from '../contracts.js';

export class FileReadExecutor implements FileReadExecutorPort {
  public execute(_request: FileReadRequest): Promise<Result<FileReadResponse>> {
    void _request;
    return Promise.reject(new NotImplementedError('FileReadExecutor', 'execute'));
  }
}
