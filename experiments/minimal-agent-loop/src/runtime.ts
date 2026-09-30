import { AgentToolPool } from './agent-tool-pool.js';
import { MinimalContextEngine } from './context-engine.js';
import { FileReadExecutor } from './executors/file-read-executor.js';
import { ModelExecutor } from './executors/model-executor.js';
import { MinimalKernel } from './kernel.js';
import { MinimalWorkflow } from './workflow.js';
import type { ExperimentError, Result, UserResponse } from './contracts.js';
import type { ModelExecutorOptions } from './executors/model-executor.js';

export interface ExperimentRuntime {
  readonly agentToolPool: AgentToolPool;
  readonly workflow: MinimalWorkflow;
  readonly contextEngine: MinimalContextEngine;
  readonly kernel: MinimalKernel;
  readonly modelExecutor: ModelExecutor;
  readonly fileReadExecutor: FileReadExecutor;
}

export type ExperimentRuntimeOptions = ModelExecutorOptions;

export class ExperimentRunError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(error: ExperimentError) {
    super(error.message);
    this.name = 'ExperimentRunError';
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export function createExperimentRuntime(options: ExperimentRuntimeOptions = {}): ExperimentRuntime {
  const agentToolPool = new AgentToolPool();
  const contextEngine = new MinimalContextEngine(agentToolPool);
  const modelExecutor = new ModelExecutor(options);
  const workflow = new MinimalWorkflow(agentToolPool);
  const kernel = new MinimalKernel(workflow, modelExecutor, agentToolPool);

  return Object.freeze({
    agentToolPool,
    workflow,
    contextEngine,
    kernel,
    modelExecutor,
    fileReadExecutor: new FileReadExecutor(),
  });
}

export async function runPrompt(
  prompt: string,
  options: ExperimentRuntimeOptions = {},
): Promise<string> {
  const result: Result<UserResponse> = await createExperimentRuntime(options).kernel.run({
    prompt,
  });
  if (!result.ok) throw new ExperimentRunError(result.error);
  return result.value.answer;
}
