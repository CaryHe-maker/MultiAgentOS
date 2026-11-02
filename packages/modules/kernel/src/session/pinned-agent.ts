import {
  newId,
  type BoundaryContextV1,
  type ExecutionScope,
  type ModelToolSpec,
  type PinnedDefinitionSetV1,
  type PortResult,
  type ProtocolRegistry,
  type RegisterAgentRunRequestV1,
  type ThinkingEffort,
  type ToolDefinitionV1,
} from '@multiagentos/contracts';
import type { PinnedAgent } from './run-attempts.js';
import type { PinResult } from './run-work.js';

export type PinFailure = 'FORBIDDEN';

/**
 * What Core and Execution run one AgentRun with, from the definitions pinned for it. The effort is
 * the one the AgentRun registered with; it must be allowed by the Agent, and the Model says what
 * it means for the provider (Interface/Definitions 3).
 */
export function pinnedAgentOf(
  set: PinnedDefinitionSetV1,
  effort: ThinkingEffort,
  registry: Pick<ProtocolRegistry, 'jsonSchemaOf'>,
): PinnedAgent | PinFailure {
  const { agent, model, prompt, units, tools } = set;
  if (!agent.thinking.allowedEfforts.includes(effort)) return 'FORBIDDEN';
  const request = model.features.thinking.effortMapping.find(
    (entry) => entry.effort === effort,
  )?.request;
  if (request === undefined) return 'FORBIDDEN';
  const base = {
    kind: 'MODEL',
    provider: model.provider,
    apiModelId: model.apiModelId,
    apiProtocol: model.apiProtocol,
    baseUrl: model.baseUrl,
  } as const;
  const modelScope: ExecutionScope =
    request.thinking === 'DISABLED'
      ? { ...base, thinking: 'DISABLED' }
      : { ...base, thinking: 'ENABLED', thinkingEffort: request.providerEffort ?? effort };

  const specOf = (tool: ToolDefinitionV1): ModelToolSpec => ({
    name: tool.modelName,
    description: tool.modelDescription,
    parameters: registry.jsonSchemaOf(tool.parametersContract),
    purpose: tool.purpose,
  });
  const toolOf = (ref: { readonly id: string; readonly version: string }) =>
    tools.find((tool) => tool.id === ref.id && tool.version === ref.version);
  const unitTools = units.flatMap((unit) => unit.toolRefs.flatMap((ref) => toolOf(ref) ?? []));
  const ends = agent.actions.end.flatMap((end) => {
    const tool = toolOf(end.toolRef);
    return tool === undefined ? [] : [{ tool, allowedInFinal: end.allowedInFinal }];
  });
  const ordinary = [...unitTools, ...ends.map((end) => end.tool)].map(specOf);
  const final = ends.filter((end) => end.allowedInFinal).map((end) => specOf(end.tool));

  return {
    units,
    maxToolUnits: agent.limits.maxToolUnits,
    ...(agent.limits.maxWallClockMs === undefined
      ? {}
      : { maxWallClockMs: agent.limits.maxWallClockMs }),
    modelScope,
    budget: agent.budget,
    contextWindowTokens: model.limits.contextWindowTokens,
    instructions: prompt.template,
    // A final call offers only the end tools allowed in it (ExecutorSet 6.1).
    toolSpecs: (isFinal) => (isFinal ? final : ordinary),
  };
}

/** The catalog as Core reads it: one Agent and everything it runs with. */
export interface AgentCatalog {
  pinAgent(
    ref: { readonly id: string; readonly version: string },
    context: BoundaryContextV1,
  ): PortResult<PinnedDefinitionSetV1>;
}

/**
 * `RunWork.pinAgent` over the catalog: the Agent must exist, have exactly the digest Workflow
 * pinned, and allow the effort it registered with (Kernel/Core 4).
 */
export function pinAgentFrom(
  catalog: AgentCatalog,
  registry: Pick<ProtocolRegistry, 'jsonSchemaOf'>,
): (request: RegisterAgentRunRequestV1) => Promise<PinResult> {
  return (request) => {
    const { agentRef, effort, sessionId, workflowRunId } = request;
    const set = catalog.pinAgent(agentRef, {
      correlationId: newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      sessionId,
      workflowRunId,
    });
    if (!set.ok) return Promise.resolve({ ok: false, reasonCode: 'DEFINITION_UNAVAILABLE' });
    if (set.value.agent.digest !== agentRef.digest)
      return Promise.resolve({ ok: false, reasonCode: 'DEFINITION_MISMATCH' });
    const agent = pinnedAgentOf(set.value, effort, registry);
    return Promise.resolve(
      agent === 'FORBIDDEN' ? { ok: false, reasonCode: 'FORBIDDEN' } : { ok: true, agent },
    );
  };
}
