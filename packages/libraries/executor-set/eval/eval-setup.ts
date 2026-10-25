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

/** `v1.10.0` sorts after `v1.9.0`. */
function compareVersions(left: string, right: string): number {
  const parts = (version: string) => version.slice(1).split('.').map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The newest code viewer, with exactly the versions it references. The catalog keeps
 * superseded versions, so a lookup by id alone could mix versions.
 */
export async function loadCodeViewer(modelId?: string): Promise<CodeViewerSetup> {
  const digests: Record<string, string> = {};
  const index = await loadCatalogIndex(new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY));
  const find = <D extends Definition>(kind: D['kind'], id: string, version?: string): D => {
    const found = [...index.definitions.values()]
      .filter(
        (definition) =>
          definition.kind === kind &&
          definition.id === id &&
          (version === undefined || definition.version === version),
      )
      .sort((left, right) => compareVersions(right.version, left.version))[0];
    if (found === undefined)
      throw new Error(`${kind} ${id} ${version ?? ''} is not in the catalog`);
    digests[`${found.kind}:${found.id}@${found.version}`] = found.digest;
    return found as D;
  };
  const agent = find<AgentDefinition>('AGENT', 'code-viewer');
  const model =
    modelId === undefined
      ? find<ModelDefinition>('MODEL', agent.modelRef.id, agent.modelRef.version)
      : find<ModelDefinition>('MODEL', modelId);
  const prompt = find<PromptDefinition>('PROMPT', agent.promptRef.id, agent.promptRef.version);
  const registry = createM1ProtocolRegistry();
  const byName = new Map<
    string,
    LoopTools['byName'] extends ReadonlyMap<string, infer V> ? V : never
  >();
  for (const unitRef of agent.unitRefs) {
    const unit = find<UnitDefinition>('UNIT', unitRef.id, unitRef.version);
    for (const toolRef of unit.toolRefs) {
      const tool = find<ToolDefinition>('TOOL', toolRef.id, toolRef.version);
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
  const finishTool = find<ToolDefinition>(
    'TOOL',
    agent.actions.finish.toolRef.id,
    agent.actions.finish.toolRef.version,
  );
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
