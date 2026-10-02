import type {
  AgentDefinitionReader,
  ChatMessage,
  ContextPack,
  ContextReader,
  ContextRequest,
  FileReadResponse,
  PromptTemplateReader,
  Result,
  ToolObservation,
} from './contracts.js';

type ContextDefinitions = PromptTemplateReader & AgentDefinitionReader;

/**
 * Render a file read as plain text: one header line, then the line-numbered source as-is,
 * so the model reads real lines instead of a JSON string full of escaped newlines.
 */
export function formatFileRead(output: FileReadResponse): string {
  const header = `${output.path} (lines ${output.startLine}-${output.endLine} of ${output.totalLines})`;
  const lines = [header, output.content];
  if (output.truncated) {
    lines.push(`[truncated: read from line ${output.endLine + 1} to continue]`);
  }
  return lines.join('\n');
}

function formatObservation(observation: ToolObservation): string {
  if (observation.result.ok) return formatFileRead(observation.result.value);
  const { code, message } = observation.result.error;
  return `Error ${code}: ${message}`;
}

export interface ContextEngineOptions {
  /**
   * Experiment C7: end every context with a status bar (call and read counts, ranges read).
   * It is rebuilt on each call and never kept in history, so the cached prefix is unchanged.
   */
  readonly statusBar?: boolean;
}

/** Render the C7 status bar from Workflow counters and the successful reads so far. */
export function formatStatusBar(request: ContextRequest): string | undefined {
  if (request.usage === undefined) return undefined;
  const ranges = request.observations.flatMap(({ result }) =>
    result.ok ? [`${result.value.path}:${result.value.startLine}-${result.value.endLine}`] : [],
  );
  return [
    `[Run status] model call ${request.usage.modelCallsUsed + 1} of ${request.limits.maxModelCalls}`,
    `file reads used ${request.usage.fileReadsUsed} of ${request.limits.maxFileReads}`,
    `ranges read: ${ranges.length === 0 ? 'none' : ranges.join(', ')}`,
  ].join(' | ');
}

export class MinimalContextEngine implements ContextReader {
  public constructor(
    private readonly definitions: ContextDefinitions,
    private readonly options: ContextEngineOptions = {},
  ) {}

  /**
   * Builds an append-only conversation: system prompt, one fixed task message, then each
   * assistant turn followed by one tool message per tool call. Earlier messages never
   * change between calls, so every call extends the previous call's prefix.
   */
  public async build(request: ContextRequest): Promise<Result<ContextPack>> {
    const prompt = await this.definitions.getPrompt(request.promptRef);
    if (!prompt.ok) return prompt;
    const agent = await this.definitions.getAgent(request.agentRef);
    if (!agent.ok) return agent;

    const task = {
      objective: request.objective,
      // The root path is a local detail bound by Workflow; the model only needs the revision.
      repository:
        request.repository === undefined ? undefined : { revision: request.repository.revision },
      availableAgents: request.routingCatalog,
      handoff: request.handoff,
      repositoryOverview: request.repositoryOverview,
      limits: request.limits,
    };
    const messages: ChatMessage[] = [
      { role: 'system', content: prompt.value.template },
      { role: 'user', content: JSON.stringify(task, null, 2) },
    ];

    // Observations are stored in call order; each one answers exactly one tool call, so a
    // tool-call id reused in a later turn still pairs with its own result.
    const used = new Set<number>();
    for (const turn of request.turns) {
      messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });
      for (const call of turn.toolCalls) {
        const index = request.observations.findIndex(
          (item, position) => item.callId === call.id && !used.has(position),
        );
        const observation = request.observations[index];
        used.add(index);
        if (observation === undefined) {
          return {
            ok: false,
            error: {
              code: 'CONTEXT_MISSING_OBSERVATION',
              message: `Tool call ${call.id} has no observation to replay.`,
              retryable: false,
            },
          };
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: formatObservation(observation),
        });
      }
      if (turn.notice !== undefined) messages.push({ role: 'user', content: turn.notice });
    }

    const statusBar = this.options.statusBar === true ? formatStatusBar(request) : undefined;
    if (statusBar !== undefined) messages.push({ role: 'user', content: statusBar });

    const finishTool = agent.value.finishToolName;
    if (request.finalCall) {
      // Appended last so the cached prefix stays intact on the final call.
      messages.push({
        role: 'user',
        content:
          finishTool === undefined
            ? 'Model-call limit reached: this is your final call. Answer now.'
            : `Model-call limit reached: this is your final call. Call ${finishTool} now using only the evidence already read.`,
      });
    }

    return {
      ok: true,
      value: {
        agentRef: request.agentRef,
        promptRef: request.promptRef,
        messages,
        tools: agent.value.tools,
        ...(request.finalCall && finishTool !== undefined ? { toolChoice: finishTool } : {}),
      },
    };
  }
}
