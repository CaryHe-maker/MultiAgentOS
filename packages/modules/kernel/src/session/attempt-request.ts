import {
  AssembleContextPackSchema,
  ContextAssembleInputSchema,
  CommandInputSchema,
  ExecutionRequestSchema,
  GitInspectInputSchema,
  FileEditInputSchema,
  FileReadInputSchema,
  FileWriteInputSchema,
  OutputReadInputSchema,
  ModelCallInputSchema,
  ModelRawOutputSchema,
  OrientContextPackSchema,
  RepositoryListInputSchema,
  RepositoryOrientInputSchema,
  RepositorySearchInputSchema,
  calibratedTokens,
  estimatePackTokens,
  validate,
  type ArtifactRef,
  type AssembleContextPack,
  type AssembleExecutorInput,
  type ContextAssembleInput,
  type ContextHistoryEntry,
  type CommandInput,
  type ExecutionKind,
  type GitInspectInput,
  type ExecutionLimits,
  type ExecutionRequest,
  type ExecutorKind,
  type FileEditInput,
  type FileReadInput,
  type FileWriteInput,
  type OutputReadInput,
  type ModelCallInput,
  type ModelRawOutput,
  type ModelToolCall,
  type OrientContextPack,
  type RepositoryListInput,
  type RepositoryOrientInput,
  type RepositorySearchInput,
  type ResolvedHistoryEntry,
  type TokenCalibration,
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
    readonly FILE_WRITE: ToolExecutionLimit;
    readonly FILE_EDIT: ToolExecutionLimit;
    readonly OUTPUT_READ: ToolExecutionLimit;
    readonly COMMAND: ToolExecutionLimit;
    readonly GIT_INSPECT: ToolExecutionLimit;
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
  readonly request: ExecutionRequest;
  /** Present for MODEL: what must be reserved before dispatch. */
  readonly reservation?: {
    readonly estimatedTokens: number;
    readonly final: boolean;
    readonly cacheHitWeight: number;
    readonly inputEstimate: number;
  };
}

export interface RequestIdentity {
  /** The AgentRun's last measured request, for figures that decide a limit. */
  readonly calibration?: TokenCalibration;
  readonly sessionId: string;
  readonly workflowRunId: string;
  readonly unitAttemptId: string;
  readonly executionId: string;
  readonly notBefore?: string;
  /** A technical retry: a final call is then forced (ExecutorSet 7). */
  readonly retry?: boolean;
}

export interface RequestBuilderDeps {
  readonly config: ExecutionConfig;
  readonly artifacts: SessionArtifacts;
  readonly now: () => Date;
}

type Schema = Parameters<typeof validate>[0];

const OBJECTIVE_MAX = 4000;
/** The estimate may be low by this much; a reservation must still hold (Kernel/Monitor 3.2). */
const RESERVED_INPUT_SHARE = 1.05;

/**
 * Room for the estimate to be low, up to the input limit: the ledger keeps exactly a limit's worth
 * for the next call and the final one, and those reservations must always succeed.
 */
export const reservedTokens = (
  inputTokens: number,
  inputLimit: number,
  maxOutputTokens: number,
): number => Math.min(Math.ceil(inputTokens * RESERVED_INPUT_SHARE), inputLimit) + maxOutputTokens;

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
    const made = (executorInput: unknown, limits: ExecutionLimits): ExecutionRequest =>
      this.#request(spec, identity, unit.executionKind, executorInput, limits);
    switch (unit.executionKind) {
      case 'REPOSITORY_ORIENT': {
        const { objectiveRef } = inputOf<RepositoryOrientInput>(RepositoryOrientInputSchema, input);
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
      case 'FILE_WRITE':
        return {
          request: made(
            inputOf<FileWriteInput>(FileWriteInputSchema, input),
            this.#toolLimits('FILE_WRITE', identity),
          ),
        };
      case 'FILE_EDIT':
        return {
          request: made(
            inputOf<FileEditInput>(FileEditInputSchema, input),
            this.#toolLimits('FILE_EDIT', identity),
          ),
        };
      case 'OUTPUT_READ': {
        const { fullRef, ...window } = inputOf<OutputReadInput>(OutputReadInputSchema, input);
        if (!this.#deps.artifacts.isFullOutput(fullRef))
          throw new RequestBuildError('INVALID_ARTIFACT_REF');
        return {
          request: made(
            { ...window, content: await this.#text(fullRef) },
            this.#toolLimits('OUTPUT_READ', identity),
          ),
        };
      }
      case 'COMMAND': {
        // Where it runs and whether it is online were decided into the scope; the Executor gets the rest.
        const { command, timeoutMs } = inputOf<CommandInput>(CommandInputSchema, input);
        return {
          request: made({ command, timeoutMs }, this.#toolLimits('COMMAND', identity)),
        };
      }
      case 'GIT_INSPECT':
        return {
          request: made(
            inputOf<GitInspectInput>(GitInspectInputSchema, input),
            this.#toolLimits('GIT_INSPECT', identity),
          ),
        };
      case 'CONTEXT_ASSEMBLE':
        return {
          request: made(
            await this.#assemble(spec, identity),
            this.#baseLimits('CONTEXT_ASSEMBLE', identity),
          ),
        };
      case 'MODEL':
        return this.#model(spec, identity);
      default:
        throw new RequestBuildError('INVALID_INPUT');
    }
  }

  #deadline(kind: ExecutorKind, identity: RequestIdentity): string {
    const start = identity.notBefore ?? this.#deps.now().toISOString();
    const { timeoutMs } = this.#deps.config.executionLimits[kind];
    return new Date(new Date(start).getTime() + timeoutMs).toISOString();
  }

  #baseLimits(kind: ExecutorKind, identity: RequestIdentity) {
    return {
      deadline: this.#deadline(kind, identity),
      maxOutputBytes: this.#deps.config.executionLimits[kind].maxOutputBytes,
    };
  }

  #toolLimits(
    kind:
      | 'REPOSITORY_ORIENT'
      | 'REPOSITORY_SEARCH'
      | 'REPOSITORY_LIST'
      | 'FILE_READ'
      | 'FILE_WRITE'
      | 'FILE_EDIT'
      | 'OUTPUT_READ'
      | 'COMMAND'
      | 'GIT_INSPECT',
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
    executionKind: ExecutionKind,
    input: unknown,
    limits: ExecutionLimits,
  ): ExecutionRequest {
    const { sessionId, workflowRunId, unitAttemptId, executionId, notBefore } = identity;
    const validated = validate<ExecutionRequest>(ExecutionRequestSchema, {
      sessionId,
      workflowRunId,
      unitAttemptId,
      executionId,
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

  async #assemble(spec: AttemptSpec, identity: RequestIdentity): Promise<AssembleExecutorInput> {
    const input = inputOf<ContextAssembleInput>(ContextAssembleInputSchema, spec.input);
    const { agent } = spec;
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
      ...(orientPack === undefined ? {} : { orientPack }),
      history,
      status: input.status,
      ...(identity.calibration === undefined ? {} : { tokenCalibration: identity.calibration }),
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
      case 'PROJECT_INSTRUCTIONS':
        return {
          ...base,
          kind: 'PROJECT_INSTRUCTIONS',
          path: entry.path,
          text: await this.#text(entry.ref),
          trusted: entry.trusted,
        };
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
        const { toolCallId, toolName, outputRef, reasonCode, status } = entry;
        const result = {
          ...base,
          kind: 'TOOL_RESULT' as const,
          toolCallId,
          toolName,
          status,
          ...(reasonCode === undefined ? {} : { reasonCode }),
        };
        if (outputRef === undefined) return result;
        // A full output reaches the model through read_output only (M2Design 8.2).
        if (this.#deps.artifacts.isFullOutput(outputRef))
          throw new RequestBuildError('INVALID_INPUT');
        return { ...result, text: await this.#text(outputRef) };
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
    const input = inputOf<ModelCallInput>(ModelCallInputSchema, spec.input);
    const { budget, contextWindowTokens, cacheHitWeight } = spec.agent;
    const contextPack = await this.#json<AssembleContextPack>(
      input.contextPackRef,
      AssembleContextPackSchema,
    );
    const expected = input.final ? budget.finalInputBudget : budget.perCallInputLimit;
    if (contextPack.tokenBudget !== expected) throw new RequestBuildError('INVALID_INPUT');
    const maxOutputTokens = input.final ? budget.finalMaxOutputTokens : budget.maxOutputTokens;
    const inputEstimate = estimatePackTokens(contextPack);
    const inputTokens = calibratedTokens(inputEstimate, identity.calibration);
    if (inputTokens + maxOutputTokens > contextWindowTokens)
      throw new RequestBuildError('LIMIT_EXCEEDED');
    const estimatedTokens = reservedTokens(inputTokens, contextPack.tokenBudget, maxOutputTokens);
    const { final } = input;
    const finalMode = identity.retry === true && final ? 'FORCED' : input.finalMode;
    return {
      request: this.#request(
        spec,
        identity,
        'MODEL',
        { contextPack, final, ...(finalMode === undefined ? {} : { finalMode }) },
        { ...this.#baseLimits('MODEL', identity), maxOutputTokens },
      ),
      reservation: { estimatedTokens, final, cacheHitWeight, inputEstimate },
    };
  }
}
