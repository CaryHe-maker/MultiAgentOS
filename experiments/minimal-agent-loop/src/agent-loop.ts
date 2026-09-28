import type { ExperimentInput, ExperimentOutput } from './contracts.js';
import { NotImplementedError } from './contracts.js';

export class AgentLoop {
  public run(_input: ExperimentInput): Promise<ExperimentOutput> {
    void _input;
    return Promise.reject(new NotImplementedError('AgentLoop', 'run'));
  }
}
