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
      // The root path is a local detail bound by Workflow; the model only needs the revision.
      repository:
        request.repository === undefined ? undefined : { revision: request.repository.revision },
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
