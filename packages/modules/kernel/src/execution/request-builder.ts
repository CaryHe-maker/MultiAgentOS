import {
  AssembleContextPackSchema,
  ContextAssembleInputSchema,
  ExecutionRequestSchema,
  FileReadInputSchema,
  ModelCallInputSchema,
  RepositoryOrientInputSchema,
  RepositorySearchInputSchema,
  OrientContextPackSchema,
  estimatePackTokens,
  validate,
  type ArtifactRef,
  type AssembleContextPack,
  type AssembleExecutorInput,
  type ContextAssembleInput,
  type DefinitionRef,
  type ExecutionLimits,
  type ExecutionRequest,
  type FileReadInput,
  type KernelConfig,
  type ModelCallInput,
  type ModelToolSpec,
  type OrientContextPack,
  type ProtocolRegistry,
  type RepositoryOrientInput,
  type RepositorySearchInput,
  type ResolvedStep,
} from '@multiagentos/contracts';
import type { ExecutionRecord, UnitAttempt } from './attempt.js';

type Schema = Parameters<typeof validate>[0];

export type RequestBuildReason = 'INVALID_INPUT' | 'INVALID_ARTIFACT_REF' | 'LIMIT_EXCEEDED';

/** A request cannot be built from the accepted attempt; Core receives a controlled result. */
export class RequestBuildError extends Error {
  public readonly reasonCode: RequestBuildReason;

  public constructor(reasonCode: RequestBuildReason, message?: string) {
    super(message ?? `Cannot build execution request: ${reasonCode}`);
    this.name = 'RequestBuildError';
    this.reasonCode = reasonCode;
  }
}

export interface BuiltRequest {
  readonly request: ExecutionRequest;
  /** Present for MODEL: the exact estimate that must be reserved before dispatch. */
  readonly reservation?: { readonly estimatedTokens: number; readonly final: boolean };
}

export interface RequestBuilderDeps {
  readonly config: KernelConfig;
  readonly registry: ProtocolRegistry;
  readonly workflowRunId: string;
  readonly now: () => Date;
  readonly readArtifact: (
    ref: ArtifactRef,
  ) => Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }>;
}

/**
 * Builds the five Executor-facing requests (docs/M1/Kernel/Execution.md 7). It resolves only
 * the three ArtifactRef positions allowed by M1Interface 6.1 and never dispatches an Executor.
 */
export class ExecutionRequestBuilder {
  readonly #config: KernelConfig;
  readonly #registry: ProtocolRegistry;
  readonly #workflowRunId: string;
  readonly #now: () => Date;
  readonly #readArtifact: RequestBuilderDeps['readArtifact'];

  public constructor(deps: RequestBuilderDeps) {
    this.#config = deps.config;
    this.#registry = deps.registry;
    this.#workflowRunId = deps.workflowRunId;
    this.#now = deps.now;
    this.#readArtifact = deps.readArtifact;
  }

  public async build(attempt: UnitAttempt, execution: ExecutionRecord): Promise<BuiltRequest> {
    switch (attempt.unit.executionKind) {
      case 'REPOSITORY_ORIENT':
        return this.#orient(attempt, execution);
      case 'REPOSITORY_SEARCH':
        return this.#search(attempt, execution);
      case 'FILE_READ':
        return this.#fileRead(attempt, execution);
      case 'CONTEXT_ASSEMBLE':
        return this.#assemble(attempt, execution);
      case 'MODEL':
        return this.#model(attempt, execution);
      default:
        throw new RequestBuildError(
          'INVALID_INPUT',
          `Execution cannot build a request for ${attempt.unit.executionKind}`,
        );
    }
  }

  #orient(attempt: UnitAttempt, execution: ExecutionRecord): BuiltRequest {
    const input = validate<RepositoryOrientInput>(RepositoryOrientInputSchema, attempt.input);
    if (!input.ok) throw new RequestBuildError('INVALID_INPUT');
    return {
      request: this.#makeRequest(
        attempt,
        execution,
        { objective: input.value.objective, tokenBudget: this.#config.budget.orientBudget },
        this.#limits(attempt, execution),
      ),
    };
  }

  #search(attempt: UnitAttempt, execution: ExecutionRecord): BuiltRequest {
    const input = validate<RepositorySearchInput>(RepositorySearchInputSchema, attempt.input);
    if (!input.ok) throw new RequestBuildError('INVALID_INPUT');
    return {
      request: this.#makeRequest(
        attempt,
        execution,
        {
          query: input.value.query,
          mode: input.value.mode ?? 'AUTO',
          maxItems: input.value.maxItems ?? 20,
          tokenBudget: this.#config.budget.searchBudget,
        },
        this.#limits(attempt, execution),
      ),
    };
  }

  #fileRead(attempt: UnitAttempt, execution: ExecutionRecord): BuiltRequest {
    const input = validate<FileReadInput>(FileReadInputSchema, attempt.input);
    if (!input.ok) throw new RequestBuildError('INVALID_INPUT');
    return {
      request: this.#makeRequest(attempt, execution, input.value, this.#limits(attempt, execution)),
    };
  }

  async #assemble(attempt: UnitAttempt, execution: ExecutionRecord): Promise<BuiltRequest> {
    const input = validate<ContextAssembleInput>(ContextAssembleInputSchema, attempt.input);
    if (!input.ok) throw new RequestBuildError('INVALID_INPUT');
    const value = input.value;
    const orientPack =
      value.orientPackRef === undefined
        ? undefined
        : await this.#resolveJson<OrientContextPack>(value.orientPackRef, OrientContextPackSchema);
    const history: ResolvedStep[] = [];
    for (const step of value.steps) {
      if (step.kind === 'TOOL_RESULT' && step.status === 'OK') {
        history.push({ step, outputText: await this.#resolveText(step.outputRef) });
      } else {
        history.push({ step });
      }
    }
    const assembled: AssembleExecutorInput = {
      objective: value.objective,
      final: value.final,
      tokenBudget: value.final
        ? this.#config.budget.finalInputBudget
        : this.#config.budget.perCallInputLimit,
      instructions: attempt.pinned.prompt.template,
      toolSpecs: this.#toolSpecs(attempt, value.final),
      ...(value.handoff === undefined ? {} : { handoff: value.handoff }),
      ...(orientPack === undefined ? {} : { orientPack }),
      history,
      status: value.status,
    };
    return {
      request: this.#makeRequest(attempt, execution, assembled, this.#limits(attempt, execution)),
    };
  }

  async #model(attempt: UnitAttempt, execution: ExecutionRecord): Promise<BuiltRequest> {
    const input = validate<ModelCallInput>(ModelCallInputSchema, attempt.input);
    if (!input.ok) throw new RequestBuildError('INVALID_INPUT');
    const value = input.value;
    const contextPack = await this.#resolveJson<AssembleContextPack>(
      value.contextPackRef,
      AssembleContextPackSchema,
    );
    const expectedBudget = value.final
      ? this.#config.budget.finalInputBudget
      : this.#config.budget.perCallInputLimit;
    if (contextPack.tokenBudget !== expectedBudget) throw new RequestBuildError('INVALID_INPUT');
    const maxOutputTokens = value.final
      ? this.#config.budget.finalMaxOutputTokens
      : this.#config.budget.maxOutputTokens;
    const estimatedTokens = estimatePackTokens(contextPack) + maxOutputTokens;
    if (estimatedTokens > attempt.pinned.model.limits.contextWindowTokens)
      throw new RequestBuildError('LIMIT_EXCEEDED');
    return {
      request: this.#makeRequest(
        attempt,
        execution,
        { contextPack, final: value.final },
        this.#limits(attempt, execution, value.final),
      ),
      reservation: { estimatedTokens, final: value.final },
    };
  }

  #limits(attempt: UnitAttempt, execution: ExecutionRecord, final = false): ExecutionLimits {
    const kind = attempt.unit.executionKind;
    const configured = this.#config.executionLimits[kind as keyof KernelConfig['executionLimits']];
    const base = execution.notBefore ?? this.#now().toISOString();
    const deadline = new Date(new Date(base).getTime() + configured.timeoutMs).toISOString();
    const limits = { deadline, maxOutputBytes: configured.maxOutputBytes };
    if (kind === 'REPOSITORY_ORIENT') return { ...limits, maxFiles: this.#config.maxSnapshotFiles };
    if (kind === 'MODEL')
      return {
        ...limits,
        maxOutputTokens: final
          ? this.#config.budget.finalMaxOutputTokens
          : this.#config.budget.maxOutputTokens,
      };
    return limits;
  }

  #makeRequest(
    attempt: UnitAttempt,
    execution: ExecutionRecord,
    input: ExecutionRequest['input'],
    limits: ExecutionLimits,
  ): ExecutionRequest {
    const request = {
      workflowRunId: this.#workflowRunId,
      unitAttemptId: attempt.unitAttemptId,
      executionId: execution.executionId,
      runEpoch: attempt.runEpoch,
      executionKind: attempt.unit.executionKind,
      input,
      scope: attempt.scope,
      limits,
      ...(execution.notBefore === undefined ? {} : { notBefore: execution.notBefore }),
    };
    const validated = validate<ExecutionRequest>(ExecutionRequestSchema, request);
    if (!validated.ok) throw new RequestBuildError('INVALID_INPUT');
    return validated.value;
  }

  #toolSpecs(attempt: UnitAttempt, final: boolean): ModelToolSpec[] {
    const specs: ModelToolSpec[] = [];
    const seen = new Set<string>();
    const add = (ref: DefinitionRef): void => {
      const key = `${ref.id}@${ref.version}`;
      if (seen.has(key)) return;
      seen.add(key);
      const tool = attempt.pinned.tools.find(
        (candidate) => candidate.id === ref.id && candidate.version === ref.version,
      );
      if (tool === undefined) throw new Error(`Pinned tool ${key} is missing`);
      specs.push({
        name: tool.modelName,
        description: tool.modelDescription,
        parameters: this.#registry.jsonSchemaOf(tool.parametersContract),
        purpose: tool.purpose,
      });
    };

    if (!final) {
      for (const unit of attempt.pinned.units) {
        for (const ref of unit.toolRefs) add(ref);
      }
    }
    add(attempt.pinned.agent.actions.finish.toolRef);
    if (!final && attempt.pinned.agent.actions.handoff !== undefined)
      add(attempt.pinned.agent.actions.handoff.toolRef);
    return specs;
  }

  async #resolveText(ref: ArtifactRef): Promise<string> {
    const content = await this.#readArtifact(ref);
    if (!content.ok) throw new RequestBuildError('INVALID_ARTIFACT_REF');
    return content.text;
  }

  async #resolveJson<T>(ref: ArtifactRef, schema: Schema): Promise<T> {
    const text = await this.#resolveText(ref);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new RequestBuildError('INVALID_INPUT');
    }
    const parsed = validate<T>(schema, value);
    if (!parsed.ok) throw new RequestBuildError('INVALID_INPUT');
    return parsed.value;
  }
}
