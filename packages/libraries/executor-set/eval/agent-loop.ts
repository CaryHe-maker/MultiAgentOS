import {
  AnalysisReportDraftSchema,
  MEDIA_TYPES,
  canonicalJson,
  sha256Hex,
  validate,
  type AgentDefinition,
  type AnalysisReportDraft,
  type AssembleContextPack,
  type ExecutionScope,
  type ExecutorEnvironment,
  type ExecutorKind,
  type ExecutorOutcome,
  type ExecutorRegistry,
  type FileReadOutput,
  type ModelCallOutput,
  type ModelDefinition,
  type ModelToolCall,
  type ModelToolSpec,
  type OrientContextPack,
  type ResolvedStep,
  type StatusFacts,
  type SubprocessRunner,
  type TokenUsage,
  type WrapUpReason,
} from '@multiagentos/contracts';

type TSchema = Parameters<typeof validate>[0];

/**
 * A single-Agent loop that follows Workflow 4–10 closely enough to measure ExecutorSet and the
 * prompts before the product Workflow and Kernel exist: orient, then per Round assemble → model
 * → interpret → validate → execute, with final-call, duplicate and no-progress handling and
 * source verification. It is an evaluation tool, not a second Workflow: once the real chain
 * runs (Workflow plan T19), evaluations move to it.
 */
export interface LoopTools {
  /** One per model-visible tool, with the Executor that serves it and the Schema of its input. */
  readonly byName: ReadonlyMap<
    string,
    { kind: ExecutorKind; schema: TSchema; spec: ModelToolSpec }
  >;
  readonly finish: ModelToolSpec;
}

export interface LoopOptions {
  readonly question: string;
  readonly repositoryRoot: string;
  readonly registry: ExecutorRegistry;
  readonly agent: AgentDefinition;
  readonly model: ModelDefinition;
  readonly instructions: string;
  readonly tools: LoopTools;
  readonly apiKey: string;
  readonly subprocess: SubprocessRunner;
  readonly regenerationLimit?: number;
  readonly noProgressRounds?: number;
}

export interface CallMetrics {
  readonly usage?: TokenUsage;
  readonly latencyMs: number;
  readonly outcome: string;
}

export interface LoopResult {
  readonly ok: boolean;
  readonly endReason: 'FINISH' | 'DEGRADED' | 'FAILED';
  readonly failure?: string;
  readonly draft?: AnalysisReportDraft;
  /** Conclusions whose every source lies inside a successful read of this run. */
  readonly verified: number;
  /** Conclusions with no source, or with a source that was never read. */
  readonly unverified: number;
  readonly rounds: number;
  readonly wrapUpReason?: WrapUpReason;
  readonly calls: readonly CallMetrics[];
  readonly reads: number;
  readonly repeatedReads: number;
  readonly searches: number;
  readonly rejectedToolCalls: number;
  readonly invalidReplies: number;
  readonly report: string;
}

const BUDGET = {
  perCallInputLimit: 64_000,
  finalInputBudget: 48_000,
  orientBudget: 4_000,
  searchBudget: 4_000,
};

function environment(
  kind: ExecutorKind,
  scope: ExecutionScope,
  options: LoopOptions,
  timeoutMs: number,
): ExecutorEnvironment {
  return {
    scope,
    limits:
      kind === 'MODEL'
        ? {
            deadline: new Date(Date.now() + timeoutMs).toISOString(),
            maxOutputBytes: 1_048_576,
            maxOutputTokens: 8_192,
          }
        : kind === 'REPOSITORY_ORIENT'
          ? {
              deadline: new Date(Date.now() + timeoutMs).toISOString(),
              maxOutputBytes: 1_048_576,
              maxFiles: 20_000,
            }
          : { deadline: new Date(Date.now() + timeoutMs).toISOString(), maxOutputBytes: 1_048_576 },
    signal: AbortSignal.timeout(timeoutMs),
    subprocess: options.subprocess,
    credentials: {
      apiKeyFor: (provider) => (provider === options.model.provider ? options.apiKey : undefined),
    },
    now: () => new Date(),
  };
}

const ref = (text: string, mediaType: string) => {
  const sha256 = sha256Hex(text);
  return { artifactId: `art_${sha256}`, sha256, size: Buffer.byteLength(text), mediaType };
};

let requestCounter = 0;
const nextRequestId = () => `req_eval${String((requestCounter += 1)).padStart(8, '0')}`;

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const { registry, agent } = options;
  const repository: ExecutionScope = {
    kind: 'REPOSITORY',
    repositoryRoot: options.repositoryRoot,
    exclusions: [],
  };
  const target = {
    kind: 'MODEL' as const,
    provider: options.model.provider,
    apiModelId: options.model.apiModelId,
    apiProtocol: options.model.apiProtocol,
    baseUrl: options.model.baseUrl,
  };
  const settings = agent.modelSettings;
  const modelScope: ExecutionScope =
    settings.thinking === 'ENABLED' && settings.thinkingEffort !== undefined
      ? { ...target, thinking: 'ENABLED', thinkingEffort: settings.thinkingEffort }
      : { ...target, thinking: 'DISABLED' };
  const calls: CallMetrics[] = [];
  const steps: ResolvedStep[] = [];
  const reads: { path: string; startLine: number; endLine: number }[] = [];
  const succeeded = new Set<string>();
  let rejectedToolCalls = 0;
  let invalidReplies = 0;
  let searches = 0;
  let repeatedReads = 0;

  const oriented = await registry.REPOSITORY_ORIENT.execute(
    { objective: options.question, tokenBudget: BUDGET.orientBudget },
    environment('REPOSITORY_ORIENT', repository, options, 60_000),
  );
  if (oriented.outcome !== 'COMPLETED') return failedResult(`orient ${describe(oriented)}`, calls);
  const orientPack = JSON.parse(oriented.result.artifact.text) as OrientContextPack;

  const maxRounds = agent.limits.maxRounds;
  let roundsUsed = 0;
  let regeneration = 0;
  let noProgress = 0;
  let wrapUpReason: WrapUpReason | undefined;
  for (;;) {
    if (wrapUpReason === undefined && roundsUsed >= maxRounds) wrapUpReason = 'ROUND_LIMIT';
    const final = wrapUpReason !== undefined;
    const status: StatusFacts = {
      roundsUsed: Math.min(roundsUsed, maxRounds),
      maxRounds,
      final,
      budgetState: 'NORMAL',
      ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
    };
    const toolSpecs = final
      ? [options.tools.finish]
      : [...[...options.tools.byName.values()].map((tool) => tool.spec), options.tools.finish];
    const assembled = await registry.CONTEXT_ASSEMBLE.execute(
      {
        objective: options.question,
        final,
        tokenBudget: final ? BUDGET.finalInputBudget : BUDGET.perCallInputLimit,
        instructions: options.instructions,
        toolSpecs,
        orientPack,
        history: steps,
        status,
      },
      environment('CONTEXT_ASSEMBLE', { kind: 'NONE' }, options, 10_000),
    );
    if (assembled.outcome !== 'COMPLETED')
      return failedResult(`assemble ${describe(assembled)}`, calls);
    const contextPack = JSON.parse(assembled.result.artifact.text) as AssembleContextPack;

    const started = Date.now();
    const answered = await registry.MODEL.execute(
      { contextPack, final },
      environment('MODEL', modelScope, options, 180_000),
    );
    calls.push({
      latencyMs: Date.now() - started,
      outcome: describe(answered),
      ...('usage' in answered && answered.usage !== undefined ? { usage: answered.usage } : {}),
    });
    roundsUsed += 1;
    const round = roundsUsed;
    if (answered.outcome !== 'COMPLETED') {
      // Workflow 7: PROVIDER_ERROR returns to the model; the others end the run.
      if (answered.outcome === 'FAILED' && answered.reasonCode === 'PROVIDER_ERROR' && !final) {
        steps.push({
          step: {
            kind: 'FEEDBACK',
            round,
            code: 'MODEL_CALL_FAILED',
            message: 'The model call failed; try again.',
          },
        });
        continue;
      }
      return failedResult(`model ${describe(answered)}`, calls);
    }
    const output = answered.result.output as ModelCallOutput;
    const modelTurn = (toolCalls: readonly ModelToolCall[]): ResolvedStep => ({
      step: { kind: 'MODEL_TURN', round, requestId: nextRequestId(), toolCalls: [...toolCalls] },
    });

    const control = output.toolCalls.filter((call) => call.toolName === options.tools.finish.name);
    const invalid = (reason: string) => {
      invalidReplies += 1;
      regeneration += 1;
      steps.push(modelTurn(output.toolCalls));
      if (output.toolCalls.length === 0)
        steps.push({ step: { kind: 'FEEDBACK', round, code: 'INVALID_ACTION', message: reason } });
      for (const call of output.toolCalls)
        steps.push({
          step: {
            kind: 'FEEDBACK',
            round,
            code: 'INVALID_ACTION',
            message: reason,
            toolCallId: call.toolCallId,
          },
        });
      if (regeneration >= (options.regenerationLimit ?? 3)) wrapUpReason ??= 'REGENERATION_LIMIT';
    };

    if (output.toolCalls.length === 0) {
      if (final) return degraded(wrapUpReason, round, calls);
      invalid(
        output.finishReason === 'LENGTH'
          ? 'Your reply was cut off; reply with tool calls only.'
          : 'Reply with tool calls only; plain text is discarded.',
      );
      continue;
    }
    if (control.length > 0) {
      if (output.toolCalls.length > 1) {
        if (final) return degraded(wrapUpReason, round, calls);
        invalid('Call finish_analysis on its own, without other tools in the same reply.');
        continue;
      }
      const draft = validate<AnalysisReportDraft>(AnalysisReportDraftSchema, control[0]?.arguments);
      if (!draft.ok) {
        if (final) return degraded(wrapUpReason, round, calls);
        invalid(
          `The finish_analysis arguments are invalid: ${draft.issues.slice(0, 3).join('; ')}`,
        );
        continue;
      }
      let verified = 0;
      for (const conclusion of draft.value.conclusions) {
        const covered =
          conclusion.sources.length > 0 &&
          conclusion.sources.every((source) =>
            reads.some(
              (range) =>
                range.path === source.path &&
                range.startLine <= source.startLine &&
                source.endLine <= range.endLine,
            ),
          );
        if (covered) verified += 1;
      }
      return {
        ok: true,
        endReason: 'FINISH',
        draft: draft.value,
        verified,
        unverified: draft.value.conclusions.length - verified,
        rounds: round,
        ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
        calls,
        reads: reads.length,
        repeatedReads,
        searches,
        rejectedToolCalls,
        invalidReplies,
        report: renderReport(draft.value),
      };
    }

    // TOOL_CALLS: Workflow 6.
    regeneration = 0;
    steps.push(modelTurn(output.toolCalls));
    let progressed = false;
    let index = 0;
    for (const call of output.toolCalls) {
      index += 1;
      const tool = options.tools.byName.get(call.toolName);
      const feedback = (
        code: 'TOO_MANY_TOOL_CALLS' | 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'DUPLICATE_CALL',
        message: string,
      ) => {
        rejectedToolCalls += 1;
        steps.push({
          step: { kind: 'FEEDBACK', round, code, message, toolCallId: call.toolCallId },
        });
      };
      if (index > agent.limits.maxToolCallsPerRound) {
        feedback(
          'TOO_MANY_TOOL_CALLS',
          `At most ${agent.limits.maxToolCallsPerRound} tool calls per reply.`,
        );
        continue;
      }
      if (tool === undefined) {
        feedback('UNKNOWN_TOOL', `${call.toolName} is not one of your tools.`);
        continue;
      }
      if (call.arguments === null || !validate(tool.schema, call.arguments).ok) {
        feedback(
          'INVALID_ARGUMENTS',
          `The arguments do not match the ${call.toolName} parameters.`,
        );
        continue;
      }
      const key = canonicalJson({ tool: call.toolName, arguments: call.arguments });
      if (succeeded.has(key)) {
        feedback('DUPLICATE_CALL', 'You already made this call; its result is above.');
        continue;
      }
      const outcome = await execute(
        tool.kind,
        call.arguments as Record<string, unknown>,
        registry,
        repository,
        options,
      );
      const requestId = nextRequestId();
      if (tool.kind === 'REPOSITORY_SEARCH') searches += 1;
      if (outcome.outcome === 'COMPLETED') {
        succeeded.add(key);
        progressed = true;
        const text = outcome.result.artifact.text;
        if (tool.kind === 'FILE_READ') {
          const read = outcome.result.output as FileReadOutput;
          if (read.totalLines > 0) {
            if (
              reads.some(
                (range) =>
                  range.path === read.path &&
                  range.startLine <= read.startLine &&
                  read.endLine <= range.endLine,
              )
            )
              repeatedReads += 1;
            reads.push({ path: read.path, startLine: read.startLine, endLine: read.endLine });
          }
          steps.push({
            step: {
              kind: 'TOOL_RESULT',
              round,
              requestId,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              status: 'OK',
              output: read,
              outputRef: ref(text, MEDIA_TYPES.fileText),
            },
            outputText: text,
          });
        } else {
          steps.push({
            step: {
              kind: 'TOOL_RESULT',
              round,
              requestId,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              status: 'OK',
              output: outcome.result.output as Extract<
                ResolvedStep['step'],
                { status: 'OK'; output: { hits: unknown } }
              >['output'],
              outputRef: ref(text, MEDIA_TYPES.contextPack),
            },
            outputText: text,
          });
        }
      } else if (outcome.outcome === 'REJECTED') {
        steps.push({
          step: {
            kind: 'TOOL_RESULT',
            round,
            requestId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            status: 'REJECTED',
            reasonCode: outcome.reasonCode,
          },
        });
      } else {
        const reasonCode = outcome.outcome === 'FAILED' ? outcome.reasonCode : 'INTERNAL';
        steps.push({
          step: {
            kind: 'TOOL_RESULT',
            round,
            requestId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            status: 'FAILED',
            reasonCode,
          },
        });
      }
    }
    noProgress = progressed ? 0 : noProgress + 1;
    if (noProgress >= (options.noProgressRounds ?? 2)) wrapUpReason ??= 'NO_PROGRESS';
  }

  function failedResult(failure: string, metrics: CallMetrics[]): LoopResult {
    return {
      ok: false,
      endReason: 'FAILED',
      failure,
      verified: 0,
      unverified: 0,
      rounds: 0,
      calls: metrics,
      reads: reads.length,
      repeatedReads,
      searches,
      rejectedToolCalls,
      invalidReplies,
      report: '',
    };
  }
  function degraded(
    reason: WrapUpReason | undefined,
    rounds: number,
    metrics: CallMetrics[],
  ): LoopResult {
    return {
      ok: false,
      endReason: 'DEGRADED',
      ...(reason === undefined ? {} : { wrapUpReason: reason }),
      verified: 0,
      unverified: 0,
      rounds,
      calls: metrics,
      reads: reads.length,
      repeatedReads,
      searches,
      rejectedToolCalls,
      invalidReplies,
      report: '',
    };
  }
}

/** Kernel 5.1 fills the defaults of a search before dispatch. */
async function execute(
  kind: ExecutorKind,
  input: Record<string, unknown>,
  registry: ExecutorRegistry,
  scope: ExecutionScope,
  options: LoopOptions,
): Promise<ExecutorOutcome> {
  const env = environment(kind, scope, options, 30_000);
  if (kind === 'REPOSITORY_SEARCH')
    return registry.REPOSITORY_SEARCH.execute(
      {
        query: String(input['query']),
        mode: (input['mode'] as 'AUTO' | undefined) ?? 'AUTO',
        maxItems: (input['maxItems'] as number | undefined) ?? 20,
        tokenBudget: BUDGET.searchBudget,
      },
      env,
    );
  if (kind === 'FILE_READ') return registry.FILE_READ.execute(input as { path: string }, env);
  return { outcome: 'FAILED', reasonCode: 'INTERNAL', retryable: false };
}

function describe(outcome: ExecutorOutcome): string {
  return outcome.outcome === 'COMPLETED'
    ? 'COMPLETED'
    : `${outcome.outcome}(${outcome.reasonCode})`;
}

/** The report as text, for grading: what a user would read. */
export function renderReport(draft: AnalysisReportDraft): string {
  const lines = [draft.summary, ''];
  for (const conclusion of draft.conclusions)
    lines.push(
      `- ${conclusion.statement} (${conclusion.sources.map((source) => `${source.path}:${source.startLine}-${source.endLine}`).join(', ')})`,
    );
  if (draft.unconfirmed.length > 0)
    lines.push('', 'Unconfirmed:', ...draft.unconfirmed.map((item) => `- ${item}`));
  return lines.join('\n');
}
