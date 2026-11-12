import {
  canonicalJson,
  requestedCapabilitiesOf,
  sha256Hex,
  type ExecutionKind,
  type PinnedDefinitionSet,
  type ProtocolRegistry,
  type ToolDefinition,
  type UnitDefinition,
} from '@multiagentos/contracts';
import type { AgentDefinitions, AgentUnit } from '../domain/agent/agent-cycle.js';
import type { AgentBinding } from './session-runner.js';

const unitOf = (unit: UnitDefinition): AgentUnit => ({
  ref: { kind: 'UNIT', id: unit.id, version: unit.version, digest: unit.digest },
  failurePolicy: unit.failurePolicy,
  ...(unit.protectedCapabilities.includes('external.read') ? { external: true as const } : {}),
});

/**
 * What the runner needs of one pinned Agent (Module/Workflow 7): its Units by role, the tools the
 * model may call with their parameter Schemas, and how it may end. The catalog has checked the
 * set already (AgentToolPool 4), so a missing role here is a broken catalog, not a user error.
 */
export function agentBindingOf(
  set: PinnedDefinitionSet,
  registry: Pick<ProtocolRegistry, 'resolveContract'>,
  preset: 'standard' | 'readonly' = 'standard',
  /** False when commands cannot run here: the command tools are not offered at all. */
  options: { readonly commands?: boolean } = {},
): AgentBinding {
  const { agent, model, units, tools } = set;
  const requestedCapabilities = requestedCapabilitiesOf(
    agent.capabilities,
    preset,
    options.commands !== false,
  );
  const offered = units.filter((unit) =>
    unit.protectedCapabilities.every((c) => requestedCapabilities.includes(c)),
  );
  const byKind = (kind: ExecutionKind): UnitDefinition | undefined =>
    units.find((unit) => unit.executionKind === kind);
  const required = (kind: ExecutionKind): AgentUnit => {
    const unit = byKind(kind);
    if (unit === undefined) throw new Error(`Agent ${agent.id} has no ${kind} Unit`);
    return unitOf(unit);
  };
  const toolOf = (ref: { readonly id: string; readonly version: string }): ToolDefinition => {
    const tool = tools.find((each) => each.id === ref.id && each.version === ref.version);
    if (tool === undefined) throw new Error(`Agent ${agent.id} has no tool ${ref.id}`);
    return tool;
  };
  const orient = units.find(
    (unit) =>
      unit.executionKind === 'REPOSITORY_ORIENT' &&
      agent.startUnitRefs.some((ref) => ref.id === unit.id && ref.version === unit.version),
  );
  // The catalog allows one publishing Unit per Agent: a message or a report. A SubAgent has none.
  const publish = byKind('MESSAGE_PUBLISH') ?? byKind('REPORT_PUBLISH');
  if (publish === undefined && agent.actions.onDegraded !== 'RETURN_PARTIAL')
    throw new Error(`Agent ${agent.id} has no publishing Unit`);

  const definitions: AgentDefinitions = {
    label: agent.id,
    limits: {
      maxRounds: agent.limits.maxRounds,
      maxToolCallsPerRound: agent.limits.maxToolCallsPerRound,
    },
    ...(orient === undefined ? {} : { orient: unitOf(orient) }),
    contextAssemble: required('CONTEXT_ASSEMBLE'),
    modelCall: required('MODEL'),
    ...(publish === undefined ? {} : { publish: unitOf(publish) }),
    tools: offered.flatMap((unit) =>
      unit.toolRefs.map((ref) => {
        const tool = toolOf(ref);
        return {
          modelName: tool.modelName,
          executionKind: unit.executionKind,
          unit: unitOf(unit),
          parameters: registry.resolveContract(tool.parametersContract),
        };
      }),
    ),
    endTools: agent.actions.end.map((end) => {
      const tool = toolOf(end.toolRef);
      return {
        toolName: tool.modelName,
        parameters: registry.resolveContract(tool.parametersContract),
        allowedInFinal: end.allowedInFinal,
        action: end.then,
      };
    }),
    onDegraded: agent.actions.onDegraded,
    ...(agent.actions.spawn === undefined || !requestedCapabilities.includes('agent.spawn')
      ? {}
      : {
          spawnTool: {
            toolName: toolOf(agent.actions.spawn.toolRef).modelName,
            parameters: registry.resolveContract(
              toolOf(agent.actions.spawn.toolRef).parametersContract,
            ),
          },
        }),
    ...(agent.actions.askUser === undefined
      ? {}
      : {
          askTool: {
            toolName: toolOf(agent.actions.askUser.toolRef).modelName,
            parameters: registry.resolveContract(
              toolOf(agent.actions.askUser.toolRef).parametersContract,
            ),
          },
        }),
    ...(agent.actions.sleep === undefined
      ? {}
      : {
          sleepTool: {
            toolName: toolOf(agent.actions.sleep.toolRef).modelName,
            parameters: registry.resolveContract(
              toolOf(agent.actions.sleep.toolRef).parametersContract,
            ),
          },
        }),
    ...(agent.actions.message === undefined
      ? {}
      : {
          messageTool: {
            toolName: toolOf(agent.actions.message.toolRef).modelName,
            parameters: registry.resolveContract(
              toolOf(agent.actions.message.toolRef).parametersContract,
            ),
          },
        }),
    ...(agent.actions.todos === undefined
      ? {}
      : {
          todoTool: {
            toolName: toolOf(agent.actions.todos.toolRef).modelName,
            parameters: registry.resolveContract(
              toolOf(agent.actions.todos.toolRef).parametersContract,
            ),
          },
        }),
  };
  return {
    ref: { kind: 'AGENT', id: agent.id, version: agent.version, digest: agent.digest },
    modelRef: { id: model.id, version: model.version },
    effort: agent.thinking.defaultEffort,
    allowedEfforts: agent.thinking.allowedEfforts,
    requestedCapabilities,
    writeRoots: requestedCapabilities.includes('workspace.write') ? ['.'] : [],
    // The tool definitions the model sees, by digest: a change adds a REQUEST_CONTEXT record.
    toolsDigest: sha256Hex(
      canonicalJson(
        tools
          .filter(
            (tool) =>
              tool.purpose !== 'UNIT' ||
              offered.some((unit) => unit.toolRefs.some((ref) => ref.id === tool.id)),
          )
          .map((tool) => tool.digest)
          .sort(),
      ),
    ),
    definitions,
  };
}
