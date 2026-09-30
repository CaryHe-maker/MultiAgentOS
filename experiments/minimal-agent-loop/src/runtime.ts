import { AgentToolPool } from './agent-tool-pool.js';
import { MinimalContextEngine } from './context-engine.js';
import { FileReadExecutor } from './executors/file-read-executor.js';
import { ModelExecutor } from './executors/model-executor.js';
import { MinimalKernel } from './kernel.js';
import { MinimalWorkflow } from './workflow.js';

export interface ExperimentRuntime {
  readonly agentToolPool: AgentToolPool;
  readonly workflow: MinimalWorkflow;
  readonly contextEngine: MinimalContextEngine;
  readonly kernel: MinimalKernel;
  readonly modelExecutor: ModelExecutor;
  readonly fileReadExecutor: FileReadExecutor;
}

export function createExperimentRuntime(): ExperimentRuntime {
  const agentToolPool = new AgentToolPool();
  const contextEngine = new MinimalContextEngine(agentToolPool);
  return Object.freeze({
    agentToolPool,
    workflow: new MinimalWorkflow(agentToolPool, contextEngine),
    contextEngine,
    kernel: new MinimalKernel(),
    modelExecutor: new ModelExecutor(),
    fileReadExecutor: new FileReadExecutor(),
  });
}
