import type { ExperimentInput, ExperimentOutput } from './contracts.js';
import { NotImplementedError } from './contracts.js';

export class MinimalKernel {
  public dispatch(_input: ExperimentInput): Promise<ExperimentOutput> {
    void _input;
    return Promise.reject(new NotImplementedError('MinimalKernel', 'dispatch'));
  }
}
