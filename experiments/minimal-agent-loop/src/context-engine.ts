import type {
  AgentDefinitionReader,
  ChatMessage,
  ContextPack,
  ContextReader,
  ContextRequest,
  FileReadResponse,
  PromptTemplateReader,
  Result,
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

export class MinimalContextEngine implements ContextReader {
  public constructor(private readonly definitions: ContextDefinitions) {}

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

    for (const turn of request.turns) {
      messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });
      for (const call of turn.toolCalls) {
        const observation = request.observations.find((item) => item.callId === call.id);
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
          content: formatFileRead(observation.output),
        });
      }
    }

    return {
      ok: true,
      value: {
        agentRef: request.agentRef,
        promptRef: request.promptRef,
        messages,
        tools: agent.value.tools,
      },
    };
  }
}
