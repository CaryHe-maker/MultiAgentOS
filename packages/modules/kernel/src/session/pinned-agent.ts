import {
  newId,
  type BoundaryContext,
  type ExecutionScope,
  type ModelToolSpec,
  type PinnedDefinitionSet,
  type PortResult,
  type ProtectedCapability,
  type ProtocolRegistry,
  type RegisterAgentRunRequest,
  type ThinkingEffort,
  type ToolDefinition,
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
  set: PinnedDefinitionSet,
  effort: ThinkingEffort,
  registry: Pick<ProtocolRegistry, 'jsonSchemaOf'>,
  requested: readonly ProtectedCapability[],
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

  const specOf = (tool: ToolDefinition): ModelToolSpec => ({
    name: tool.modelName,
    description: tool.modelDescription,
    parameters: registry.jsonSchemaOf(tool.parametersContract),
    purpose: tool.purpose,
  });
  const toolOf = (ref: { readonly id: string; readonly version: string }) =>
    tools.find((tool) => tool.id === ref.id && tool.version === ref.version);
  // A tool beyond the ceiling is not offered at all; asking for it would be refused (M2Design 5.4).
  const unitTools = units
    .filter((unit) => unit.protectedCapabilities.every((c) => requested.includes(c)))
    .flatMap((unit) => unit.toolRefs.flatMap((ref) => toolOf(ref) ?? []));
  const ends = agent.actions.end.flatMap((end) => {
    const tool = toolOf(end.toolRef);
    return tool === undefined ? [] : [{ tool, allowedInFinal: end.allowedInFinal }];
  });
  const todos = agent.actions.todos === undefined ? undefined : toolOf(agent.actions.todos.toolRef);
  const ordinary = [
    ...unitTools,
    ...(todos === undefined ? [] : [todos]),
    ...ends.map((end) => end.tool),
  ].map(specOf);
  const final = ends.filter((end) => end.allowedInFinal).map((end) => specOf(end.tool));

  return {
    id: agent.id,
    capabilities: agent.capabilities,
    units,
    maxToolUnits: agent.limits.maxToolUnits,
    ...(agent.limits.maxWallClockMs === undefined
      ? {}
      : { maxWallClockMs: agent.limits.maxWallClockMs }),
    modelScope,
    budget: agent.budget,
    contextWindowTokens: model.limits.contextWindowTokens,
    cacheHitWeight: model.pricing.offPeak.inputCacheHit / model.pricing.offPeak.inputCacheMiss,
    instructions: prompt.template,
    // A final call offers only the end tools allowed in it (ExecutorSet 6.1).
    toolSpecs: (isFinal) => (isFinal ? final : ordinary),
  };
}

/** The catalog as Core reads it: one Agent and everything it runs with. */
export interface AgentCatalog {
  pinAgent(
    ref: { readonly id: string; readonly version: string },
    context: BoundaryContext,
  ): PortResult<PinnedDefinitionSet>;
}

/**
 * `RunWork.pinAgent` over the catalog: the Agent must exist, have exactly the digest Workflow
 * pinned, and allow the effort it registered with (Kernel/Core 4).
 */
export function pinAgentFrom(
  catalog: AgentCatalog,
  registry: Pick<ProtocolRegistry, 'jsonSchemaOf'>,
): (request: RegisterAgentRunRequest) => Promise<PinResult> {
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
    const agent = pinnedAgentOf(set.value, effort, registry, request.requestedCapabilities);
    return Promise.resolve(
      agent === 'FORBIDDEN' ? { ok: false, reasonCode: 'FORBIDDEN' } : { ok: true, agent },
    );
  };
}
