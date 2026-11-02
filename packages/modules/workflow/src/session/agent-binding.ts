import {
  canonicalJson,
  sha256Hex,
  type ExecutionKindV1,
  type PinnedDefinitionSetV1,
  type ProtocolRegistry,
  type ToolDefinitionV1,
  type UnitDefinitionV1,
} from '@multiagentos/contracts';
import type { AgentDefinitions, AgentUnit } from '../domain/agent/agent-cycle.js';
import type { AgentBinding } from './session-runner.js';

const unitOf = (unit: UnitDefinitionV1): AgentUnit => ({
  ref: { kind: 'UNIT', id: unit.id, version: unit.version, digest: unit.digest },
  failurePolicy: unit.failurePolicy,
});

/**
 * What the runner needs of one pinned Agent (Module/Workflow 7): its Units by role, the tools the
 * model may call with their parameter Schemas, and how it may end. The catalog has checked the
 * set already (AgentToolPool 4), so a missing role here is a broken catalog, not a user error.
 */
export function agentBindingOf(
  set: PinnedDefinitionSetV1,
  registry: Pick<ProtocolRegistry, 'resolveContract'>,
): AgentBinding {
  const { agent, model, units, tools } = set;
  const byKind = (kind: ExecutionKindV1): UnitDefinitionV1 | undefined =>
    units.find((unit) => unit.executionKind === kind);
  const required = (kind: ExecutionKindV1): AgentUnit => {
    const unit = byKind(kind);
    if (unit === undefined) throw new Error(`Agent ${agent.id} has no ${kind} Unit`);
    return unitOf(unit);
  };
  const toolOf = (ref: { readonly id: string; readonly version: string }): ToolDefinitionV1 => {
    const tool = tools.find((each) => each.id === ref.id && each.version === ref.version);
    if (tool === undefined) throw new Error(`Agent ${agent.id} has no tool ${ref.id}`);
    return tool;
  };
  const orient = units.find(
    (unit) =>
      unit.executionKind === 'REPOSITORY_ORIENT' &&
      agent.startUnitRefs.some((ref) => ref.id === unit.id && ref.version === unit.version),
  );
  // The catalog allows one publishing Unit per Agent: a message or a report.
  const publish = byKind('MESSAGE_PUBLISH') ?? byKind('REPORT_PUBLISH');
  if (publish === undefined) throw new Error(`Agent ${agent.id} has no publishing Unit`);

  const definitions: AgentDefinitions = {
    label: agent.id,
    limits: {
      maxRounds: agent.limits.maxRounds,
      maxToolCallsPerRound: agent.limits.maxToolCallsPerRound,
    },
    ...(orient === undefined ? {} : { orient: unitOf(orient) }),
    contextAssemble: required('CONTEXT_ASSEMBLE'),
    modelCall: required('MODEL'),
    publish: unitOf(publish),
    tools: units.flatMap((unit) =>
      unit.toolRefs.map((ref) => {
        const tool = toolOf(ref);
        return {
          modelName: tool.modelName,
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
  };
  return {
    ref: { kind: 'AGENT', id: agent.id, version: agent.version, digest: agent.digest },
    modelRef: { id: model.id, version: model.version },
    effort: agent.thinking.defaultEffort,
    // The tool definitions the model sees, by digest: a change adds a REQUEST_CONTEXT record.
    toolsDigest: sha256Hex(canonicalJson(tools.map((tool) => tool.digest).sort())),
    definitions,
  };
}
