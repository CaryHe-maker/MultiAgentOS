import {
  newId,
  type BoundaryContext,
  type ExecutionScope,
  type ModelToolSpec,
  type PinnedDefinitionSet,
  type PortResult,
  type ProtectedCapability,
  type ProtocolRegistry,
  requestedCapabilitiesOf,
  type RegisterAgentRunRequest,
  type ThinkingEffort,
  type ToolDefinition,
} from '@multiagentos/contracts';
import type { AgentBudget } from '../monitor/index.js';
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
    ...(tool.answer === undefined ? {} : { answer: tool.answer }),
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
  // `run_subagents` is offered to an AgentRun whose ceiling has `agent.spawn` (M2Design 5.4, layer 2).
  const spawn =
    agent.actions.spawn === undefined || !requested.includes('agent.spawn')
      ? undefined
      : toolOf(agent.actions.spawn.toolRef);
  // `ask_user` needs no capability: any Agent that declares it offers it (M2Design 3.4).
  const ask =
    agent.actions.askUser === undefined ? undefined : toolOf(agent.actions.askUser.toolRef);
  const ordinary = [
    ...unitTools,
    ...(todos === undefined ? [] : [todos]),
    ...(spawn === undefined ? [] : [spawn]),
    ...(ask === undefined ? [] : [ask]),
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

/** What `reserveDelegation` needs of an Agent (M2Design 7.3). */
export type AgentShare =
  | { readonly ok: true; readonly defaultShare: number | undefined; readonly budget: AgentBudget }
  | { readonly ok: false; readonly reasonCode: 'DEFINITION_UNAVAILABLE' | 'DEFINITION_MISMATCH' };

/** The default share and the per-call budget of an Agent, from the catalog. */
export function agentShareFrom(
  catalog: AgentCatalog,
): (
  ref: { readonly id: string; readonly version: string; readonly digest: string },
  context: Pick<BoundaryContext, 'sessionId' | 'workflowRunId'>,
) => AgentShare {
  return (ref, context) => {
    const set = catalog.pinAgent(ref, {
      correlationId: newId('cor'),
      tenantId: 'local',
      projectId: 'local',
      ...context,
    });
    if (!set.ok) return { ok: false, reasonCode: 'DEFINITION_UNAVAILABLE' };
    if (set.value.agent.digest !== ref.digest)
      return { ok: false, reasonCode: 'DEFINITION_MISMATCH' };
    return {
      ok: true,
      defaultShare: set.value.agent.spawnable?.defaultShare,
      budget: set.value.agent.budget,
    };
  };
}

/** The catalog as Core reads it: one Agent and everything it runs with. */
export interface AgentCatalog {
  pinAgent(
    ref: { readonly id: string; readonly version: string },
    context: BoundaryContext,
  ): PortResult<PinnedDefinitionSet>;
}

/** The catalog as compaction reads it: an Agent by its reference, and the newest of an id. */
export interface CompactionCatalog extends AgentCatalog {
  latest(kind: 'AGENT', id: string): { readonly id: string; readonly version: string } | undefined;
}

/**
 * The Agent a compaction of a context is made as: what the Agent is, from the catalog, with what a
 * start asks for under the preset (one function, shared with Workflow's registration). It is the one
 * way every compaction finds its Agent, whatever its target: a reference names it (the Agent an
 * AgentRun was registered as), and no reference means main, the Agent of the Session's Turn-chat.
 * Nothing of an AgentRun is read: not whether there is one, nor how it ended.
 */
export function compactionAgentFrom(
  catalog: CompactionCatalog,
  registry: Pick<ProtocolRegistry, 'jsonSchemaOf'>,
  options: { readonly preset: 'standard' | 'readonly'; readonly commands: boolean },
): (ref?: { readonly id: string; readonly version: string }) => PinnedAgent | undefined {
  const made = new Map<string, PinnedAgent | undefined>();
  return (ref) => {
    const named = ref ?? catalog.latest('AGENT', 'main');
    if (named === undefined) return undefined;
    const key = `${named.id}@${named.version}`;
    if (made.has(key)) return made.get(key);
    const set = catalog.pinAgent(
      { id: named.id, version: named.version },
      { correlationId: newId('cor'), tenantId: 'local', projectId: 'local' },
    );
    let agent: PinnedAgent | undefined;
    if (set.ok) {
      const { agent: definition } = set.value;
      const pinned = pinnedAgentOf(
        set.value,
        definition.thinking.defaultEffort,
        registry,
        requestedCapabilitiesOf(definition.capabilities, options.preset, options.commands),
      );
      agent = pinned === 'FORBIDDEN' ? undefined : pinned;
    }
    made.set(key, agent);
    return agent;
  };
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
