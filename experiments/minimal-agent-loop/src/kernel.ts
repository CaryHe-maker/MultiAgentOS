import type {
  KernelPort,
  ModuleRequest,
  ModuleResponse,
  Result,
  UserRequest,
  UserResponse,
} from './contracts.js';
import { NotImplementedError } from './contracts.js';

export class MinimalKernel implements KernelPort {
  public run(_request: UserRequest): Promise<Result<UserResponse>> {
    void _request;
    return Promise.reject(new NotImplementedError('MinimalKernel', 'run'));
  }

  public dispatch(_request: ModuleRequest): Promise<Result<ModuleResponse>> {
    void _request;
    return Promise.reject(new NotImplementedError('MinimalKernel', 'dispatch'));
  }
}
