import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  FileDefinitionSource,
  loadCatalogIndex,
} from '@multiagentos/agent-tool-pool';
import {
  createM1ProtocolRegistry,
  type AgentDefinition,
  type Definition,
  type ExecutorKind,
  type ModelDefinition,
  type PromptDefinition,
  type ToolDefinition,
  type UnitDefinition,
} from '@multiagentos/contracts';
import type { LoopTools } from './agent-loop.js';

/** The code viewer as the catalog defines it: prompt, tools, model and limits. */
export interface CodeViewerSetup {
  readonly agent: AgentDefinition;
  readonly model: ModelDefinition;
  readonly instructions: string;
  readonly tools: LoopTools;
  /** `KIND:id@version` → digest of every definition the evaluation uses. */
  readonly digests: Readonly<Record<string, string>>;
}

export async function loadCodeViewer(modelId?: string): Promise<CodeViewerSetup> {
  const digests: Record<string, string> = {};
  const index = await loadCatalogIndex(new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY));
  const find = <D extends Definition>(kind: D['kind'], id: string): D => {
    const found = [...index.definitions.values()].find(
      (definition) => definition.kind === kind && definition.id === id,
    );
    if (found === undefined) throw new Error(`${kind} ${id} is not in the catalog`);
    digests[`${found.kind}:${found.id}@${found.version}`] = found.digest;
    return found as D;
  };
  const agent = find<AgentDefinition>('AGENT', 'code-viewer');
  const model = find<ModelDefinition>('MODEL', modelId ?? agent.modelRef.id);
  const prompt = find<PromptDefinition>('PROMPT', agent.promptRef.id);
  const registry = createM1ProtocolRegistry();
  const byName = new Map<
    string,
    LoopTools['byName'] extends ReadonlyMap<string, infer V> ? V : never
  >();
  for (const unitRef of agent.unitRefs) {
    const unit = find<UnitDefinition>('UNIT', unitRef.id);
    for (const toolRef of unit.toolRefs) {
      const tool = find<ToolDefinition>('TOOL', toolRef.id);
      byName.set(tool.modelName, {
        kind: unit.executionKind as ExecutorKind,
        schema: registry.resolveContract(tool.parametersContract),
        spec: {
          name: tool.modelName,
          description: tool.modelDescription,
          parameters: registry.jsonSchemaOf(tool.parametersContract),
          purpose: tool.purpose,
        },
      });
    }
  }
  const finishTool = find<ToolDefinition>('TOOL', agent.actions.finish.toolRef.id);
  return {
    digests,
    agent,
    model,
    instructions: prompt.template,
    tools: {
      byName,
      finish: {
        name: finishTool.modelName,
        description: finishTool.modelDescription,
        parameters: registry.jsonSchemaOf(finishTool.parametersContract),
        purpose: finishTool.purpose,
      },
    },
  };
}
