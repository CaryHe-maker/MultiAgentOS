import { AgentLoop } from './agent-loop.js';
import { MinimalContextEngine } from './context-engine.js';
import { ApiCallExecutor } from './executors/api-call-executor.js';
import { WebSearchExecutor } from './executors/web-search-executor.js';
import { MinimalKernel } from './kernel.js';
import { MinimalWorkflow } from './workflow.js';

export interface ExperimentRuntime {
  readonly agentLoop: AgentLoop;
  readonly workflow: MinimalWorkflow;
  readonly contextEngine: MinimalContextEngine;
  readonly kernel: MinimalKernel;
  readonly apiCallExecutor: ApiCallExecutor;
  readonly webSearchExecutor: WebSearchExecutor;
}

export function createExperimentRuntime(): ExperimentRuntime {
  return Object.freeze({
    agentLoop: new AgentLoop(),
    workflow: new MinimalWorkflow(),
    contextEngine: new MinimalContextEngine(),
    kernel: new MinimalKernel(),
    apiCallExecutor: new ApiCallExecutor(),
    webSearchExecutor: new WebSearchExecutor(),
  });
}
