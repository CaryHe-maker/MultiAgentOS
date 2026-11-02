import {
  AssembleContextPackV1Schema,
  ContextAssembleInputV1Schema,
  ExecutionRequestV1Schema,
  FileReadInputSchema,
  ModelCallInputV1Schema,
  ModelRawOutputSchema,
  OrientContextPackSchema,
  RepositoryListInputSchema,
  RepositoryOrientInputV1Schema,
  RepositorySearchInputSchema,
  estimatePackTokens,
  validate,
  type ArtifactRef,
  type AssembleContextPackV1,
  type AssembleExecutorInputV1,
  type ContextAssembleInputV1,
  type ContextHistoryEntry,
  type ExecutionKindV1,
  type ExecutionLimitsV1,
  type ExecutionRequestV1,
  type ExecutorKindV1,
  type FileReadInput,
  type ModelCallInputV1,
  type ModelRawOutput,
  type ModelToolCall,
  type OrientContextPack,
  type ReasonCodeV1,
  type RepositoryListInput,
  type RepositoryOrientInputV1,
  type RepositorySearchInput,
  type ResolvedHistoryEntry,
} from '@multiagentos/contracts';
import type { AttemptSpec } from './run-attempts.js';
import type { ArtifactRefusal, SessionArtifacts } from './session-artifacts.js';

export interface ExecutionLimit {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** A tool Unit's limits (M2Design 8.2): the preview is capped by both byte limits. */
export interface ToolExecutionLimit extends ExecutionLimit {
  readonly previewMaxBytes: number;
  readonly previewMaxLines: number;
  readonly maxFullOutputBytes: number;
}

export interface ExecutionConfig {
  readonly executionLimits: {
    readonly REPOSITORY_ORIENT: ToolExecutionLimit;
    readonly REPOSITORY_SEARCH: ToolExecutionLimit;
    readonly REPOSITORY_LIST: ToolExecutionLimit;
    readonly FILE_READ: ToolExecutionLimit;
    readonly CONTEXT_ASSEMBLE: ExecutionLimit;
    readonly MODEL: ExecutionLimit;
  };
  readonly retryBackoffBaseMs: number;
  readonly retryAfterMaxMs: number;
  readonly maxReportBytes: number;
  readonly maxSnapshotFiles: number;
  readonly orientBudget: number;
  readonly searchBudget: number;
  readonly cancelGraceMs: number;
  readonly convergenceMarginMs: number;
}

export type RequestRefusal = 'INVALID_INPUT' | 'LIMIT_EXCEEDED' | ArtifactRefusal;

/** The accepted attempt cannot become a request; Core receives a controlled result. */
export class RequestBuildError extends Error {
  public readonly reasonCode: RequestRefusal;

  public constructor(reasonCode: RequestRefusal) {
    super(`Cannot build execution request: ${reasonCode}`);
    this.name = 'RequestBuildError';
    this.reasonCode = reasonCode;
  }
}

export interface BuiltRequest {
  readonly request: ExecutionRequestV1;
  /** Present for MODEL: what must be reserved before dispatch. */
  readonly reservation?: { readonly estimatedTokens: number; readonly final: boolean };
}

export interface RequestIdentity {
  readonly sessionId: string;
  readonly workflowRunId: string;
  readonly unitAttemptId: string;
  readonly executionId: string;
  readonly notBefore?: string;
}

export interface RequestBuilderDeps {
  readonly config: ExecutionConfig;
  readonly artifacts: SessionArtifacts;
  readonly now: () => Date;
}

type Schema = Parameters<typeof validate>[0];

const OBJECTIVE_MAX = 4000;
/** The model sees these instead of a preview when a tool did not run. */
const REFUSED_TOOL_TEXT: Partial<Record<ReasonCodeV1, string>> = {
  USER_DECLINED:
    'The user declined this capability. It will not be asked again in this run: do not retry it, ' +
    'work without it or say so in your reply.',
  QUOTA_EXHAUSTED: 'The tool limit of this agent is reached; finish with what you have.',
};

function inputOf<T>(schema: Schema, value: unknown): T {
  const input = validate<T>(schema, value);
  if (!input.ok) throw new RequestBuildError('INVALID_INPUT');
  return input.value;
}

function parsedCall(call: ModelRawOutput['toolCalls'][number]): ModelToolCall {
  const { toolCallId, toolName, argumentsText } = call;
  const invalid: ModelToolCall = {
    toolCallId,
    toolName,
    arguments: null,
    argumentsError: 'INVALID_JSON',
  };
  try {
    const parsed = JSON.parse(argumentsText) as Exclude<ModelToolCall['arguments'], null>;
    return parsed === null ? invalid : { toolCallId, toolName, arguments: parsed };
  } catch {
    return invalid;
  }
}

/**
 * Turns an accepted attempt into its ExecutionRequest (Kernel/Execution 3, 4b). Every reference is
 * checked against this Session here, so an Executor only ever sees resolved text.
 */
export class AttemptRequestBuilder {
  readonly #deps: RequestBuilderDeps;

  public constructor(deps: RequestBuilderDeps) {
    this.#deps = deps;
  }

  async build(spec: AttemptSpec, identity: RequestIdentity): Promise<BuiltRequest> {
    const { unit, input } = spec;
    const made = (executorInput: unknown, limits: ExecutionLimitsV1): ExecutionRequestV1 =>
      this.#request(spec, identity, unit.executionKind, executorInput, limits);
    switch (unit.executionKind) {
      case 'REPOSITORY_ORIENT': {
        const { objectiveRef } = inputOf<RepositoryOrientInputV1>(
          RepositoryOrientInputV1Schema,
          input,
        );
        const objective = (await this.#text(objectiveRef)).slice(0, OBJECTIVE_MAX);
        const limits = this.#toolLimits('REPOSITORY_ORIENT', identity);
        return {
          request: made(
            { objective, tokenBudget: this.#deps.config.orientBudget },
            { ...limits, maxFiles: this.#deps.config.maxSnapshotFiles },
          ),
        };
      }
      case 'REPOSITORY_SEARCH': {
        const search = inputOf<RepositorySearchInput>(RepositorySearchInputSchema, input);
        return {
          request: made(
            {
              query: search.query,
              mode: search.mode ?? 'AUTO',
              maxItems: search.maxItems ?? 20,
              tokenBudget: this.#deps.config.searchBudget,
            },
            this.#toolLimits('REPOSITORY_SEARCH', identity),
          ),
        };
      }
      case 'REPOSITORY_LIST':
        return {
          request: made(
            inputOf<RepositoryListInput>(RepositoryListInputSchema, input),
            this.#toolLimits('REPOSITORY_LIST', identity),
          ),
        };
      case 'FILE_READ':
        return {
          request: made(
            inputOf<FileReadInput>(FileReadInputSchema, input),
            this.#toolLimits('FILE_READ', identity),
          ),
        };
      case 'CONTEXT_ASSEMBLE':
        return {
          request: made(await this.#assemble(spec), this.#baseLimits('CONTEXT_ASSEMBLE', identity)),
        };
      case 'MODEL':
        return this.#model(spec, identity);
      default:
        throw new RequestBuildError('INVALID_INPUT');
    }
  }

  #deadline(kind: ExecutorKindV1, identity: RequestIdentity): string {
    const start = identity.notBefore ?? this.#deps.now().toISOString();
    const { timeoutMs } = this.#deps.config.executionLimits[kind];
    return new Date(new Date(start).getTime() + timeoutMs).toISOString();
  }

  #baseLimits(kind: ExecutorKindV1, identity: RequestIdentity) {
    return {
      deadline: this.#deadline(kind, identity),
      maxOutputBytes: this.#deps.config.executionLimits[kind].maxOutputBytes,
    };
  }

  #toolLimits(
    kind: 'REPOSITORY_ORIENT' | 'REPOSITORY_SEARCH' | 'REPOSITORY_LIST' | 'FILE_READ',
    identity: RequestIdentity,
  ) {
    const limit = this.#deps.config.executionLimits[kind];
    return {
      ...this.#baseLimits(kind, identity),
      preview: {
        maxBytes: Math.min(limit.previewMaxBytes, limit.maxOutputBytes),
        maxLines: limit.previewMaxLines,
      },
      maxFullOutputBytes: limit.maxFullOutputBytes,
    };
  }

  #request(
    spec: AttemptSpec,
    identity: RequestIdentity,
    executionKind: ExecutionKindV1,
    input: unknown,
    limits: ExecutionLimitsV1,
  ): ExecutionRequestV1 {
    const { notBefore, ...ids } = identity;
    const validated = validate<ExecutionRequestV1>(ExecutionRequestV1Schema, {
      ...ids,
      runEpoch: spec.runEpoch,
      executionKind,
      input,
      scope: spec.scope,
      limits,
      ...(notBefore === undefined ? {} : { notBefore }),
    });
    if (!validated.ok) throw new RequestBuildError('INVALID_INPUT');
    return validated.value;
  }

  async #text(ref: ArtifactRef): Promise<string> {
    const content = await this.#deps.artifacts.read(ref);
    if (!content.ok) throw new RequestBuildError(content.reasonCode);
    return content.text;
  }

  async #json<T>(ref: ArtifactRef, schema: Schema): Promise<T> {
    const text = await this.#text(ref);
    try {
      return inputOf<T>(schema, JSON.parse(text));
    } catch (error) {
      if (error instanceof RequestBuildError) throw error;
      throw new RequestBuildError('INVALID_INPUT');
    }
  }

  async #assemble(spec: AttemptSpec): Promise<AssembleExecutorInputV1> {
    const input = inputOf<ContextAssembleInputV1>(ContextAssembleInputV1Schema, spec.input);
    const { agent } = spec;
    const { projectInstructions: project } = input;
    const orientPack =
      input.orientPackRef === undefined
        ? undefined
        : await this.#json<OrientContextPack>(input.orientPackRef, OrientContextPackSchema);
    const history: ResolvedHistoryEntry[] = [];
    for (const entry of input.history) history.push(await this.#resolved(entry));
    return {
      final: input.final,
      tokenBudget: input.final ? agent.budget.finalInputBudget : agent.budget.perCallInputLimit,
      instructions: agent.instructions,
      toolSpecs: agent.toolSpecs(input.final),
      ...(project === undefined
        ? {}
        : {
            projectInstructions: { text: await this.#text(project.ref), trusted: project.trusted },
          }),
      ...(orientPack === undefined ? {} : { orientPack }),
      history,
      status: input.status,
    };
  }

  async #rawOutput(ref: ArtifactRef): Promise<ModelRawOutput> {
    return this.#json<ModelRawOutput>(ref, ModelRawOutputSchema);
  }

  async #resolved(entry: ContextHistoryEntry): Promise<ResolvedHistoryEntry> {
    const { seq, category } = entry;
    const base = { seq, category, ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }) };
    switch (entry.kind) {
      case 'HUMAN':
        return { ...base, kind: 'HUMAN', text: await this.#text(entry.contentRef) };
      case 'NOTE':
        return { ...base, kind: 'NOTE', text: entry.text };
      case 'FEEDBACK':
        return {
          ...base,
          kind: 'FEEDBACK',
          text: entry.text,
          ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
        };
      case 'MODEL_TURN': {
        const raw = await this.#rawOutput(entry.outputRef);
        const reasoning =
          entry.replayable && entry.reasoningRef !== undefined
            ? await this.#text(entry.reasoningRef)
            : undefined;
        return {
          ...base,
          kind: 'MODEL_TURN',
          ...(raw.text === undefined ? {} : { text: raw.text }),
          toolCalls: raw.toolCalls.map(parsedCall),
          ...(reasoning === undefined ? {} : { reasoningContent: reasoning }),
        };
      }
      case 'TOOL_RESULT': {
        const { toolCallId, outputRef, reasonCode, status } = entry;
        if (outputRef !== undefined) {
          // A full output reaches the model through read_output only (M2Design 8.2).
          if (this.#deps.artifacts.isFullOutput(outputRef))
            throw new RequestBuildError('INVALID_INPUT');
          return { ...base, kind: 'TOOL_RESULT', toolCallId, text: await this.#text(outputRef) };
        }
        const refused = reasonCode === undefined ? undefined : REFUSED_TOOL_TEXT[reasonCode];
        return {
          ...base,
          kind: 'TOOL_RESULT',
          toolCallId,
          text: refused ?? `[${status}] ${reasonCode ?? 'no output'}`,
        };
      }
      case 'HANDOFF': {
        const raw = await this.#rawOutput(entry.outputRef);
        const call = raw.toolCalls.find((candidate) => candidate.toolCallId === entry.toolCallId);
        if (call === undefined) throw new RequestBuildError('INVALID_INPUT');
        return { ...base, kind: 'NOTE', text: call.argumentsText };
      }
    }
  }

  async #model(spec: AttemptSpec, identity: RequestIdentity): Promise<BuiltRequest> {
    const input = inputOf<ModelCallInputV1>(ModelCallInputV1Schema, spec.input);
    const { budget, contextWindowTokens } = spec.agent;
    const contextPack = await this.#json<AssembleContextPackV1>(
      input.contextPackRef,
      AssembleContextPackV1Schema,
    );
    const expected = input.final ? budget.finalInputBudget : budget.perCallInputLimit;
    if (contextPack.tokenBudget !== expected) throw new RequestBuildError('INVALID_INPUT');
    const maxOutputTokens = input.final ? budget.finalMaxOutputTokens : budget.maxOutputTokens;
    const estimatedTokens = estimatePackTokens(contextPack) + maxOutputTokens;
    if (estimatedTokens > contextWindowTokens) throw new RequestBuildError('LIMIT_EXCEEDED');
    const { final, finalMode } = input;
    return {
      request: this.#request(
        spec,
        identity,
        'MODEL',
        { contextPack, final, ...(finalMode === undefined ? {} : { finalMode }) },
        { ...this.#baseLimits('MODEL', identity), maxOutputTokens },
      ),
      reservation: { estimatedTokens, final },
    };
  }
}
