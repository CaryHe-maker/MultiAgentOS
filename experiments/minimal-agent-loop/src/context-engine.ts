import type {
  AgentDefinitionReader,
  ContextPack,
  ContextReader,
  ContextRequest,
  PromptTemplateReader,
  Result,
} from './contracts.js';

type ContextDefinitions = PromptTemplateReader & AgentDefinitionReader;

export class MinimalContextEngine implements ContextReader {
  public constructor(private readonly definitions: ContextDefinitions) {}

  public async build(request: ContextRequest): Promise<Result<ContextPack>> {
    const prompt = await this.definitions.getPrompt(request.promptRef);
    if (!prompt.ok) return prompt;
    const agent = await this.definitions.getAgent(request.agentRef);
    if (!agent.ok) return agent;

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
        tools: agent.value.tools,
      },
    };
  }
}
