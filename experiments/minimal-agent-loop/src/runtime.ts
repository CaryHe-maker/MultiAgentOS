import { AgentToolPool } from './agent-tool-pool.js';
import { MinimalContextEngine } from './context-engine.js';
import { ApiCallExecutor } from './executors/api-call-executor.js';
import { WebSearchExecutor } from './executors/web-search-executor.js';
import { MinimalKernel } from './kernel.js';
import { MinimalWorkflow } from './workflow.js';

export interface ExperimentRuntime {
  readonly agentToolPool: AgentToolPool;
  readonly workflow: MinimalWorkflow;
  readonly contextEngine: MinimalContextEngine;
  readonly kernel: MinimalKernel;
  readonly apiCallExecutor: ApiCallExecutor;
  readonly webSearchExecutor: WebSearchExecutor;
}

export function createExperimentRuntime(): ExperimentRuntime {
  const agentToolPool = new AgentToolPool();
  const contextEngine = new MinimalContextEngine(agentToolPool);
  return Object.freeze({
    agentToolPool,
    workflow: new MinimalWorkflow(agentToolPool, contextEngine),
    contextEngine,
    kernel: new MinimalKernel(),
    apiCallExecutor: new ApiCallExecutor(),
    webSearchExecutor: new WebSearchExecutor(),
  });
}
