import type {
  ContextPack,
  ContextReader,
  ContextRequest,
  PromptTemplateReader,
  Result,
} from './contracts.js';

export class MinimalContextEngine implements ContextReader {
  public constructor(private readonly prompts: PromptTemplateReader) {}

  public async build(request: ContextRequest): Promise<Result<ContextPack>> {
    const prompt = await this.prompts.getPrompt(request.promptRef);
    if (!prompt.ok) return prompt;

    const dynamicInput = {
      objective: request.objective,
      repository: request.repository,
      availableAgents: request.routingCatalog,
      handoff: request.handoff,
      repositoryOverview: request.repositoryOverview,
      observations: request.observations,
      status: request.status,
    };

    return {
      ok: true,
      value: {
        agentRef: request.agentRef,
        promptRef: request.promptRef,
        instructions: prompt.value.template,
        input: JSON.stringify(dynamicInput, null, 2),
      },
    };
  }
}
