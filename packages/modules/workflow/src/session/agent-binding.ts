import {
  canonicalJson,
  requestedCapabilitiesOf,
  sha256Hex,
  type ExecutionKind,
  type PinnedDefinitionSet,
  type ProtocolRegistry,
  type ToolDefinition,
  type UnitDefinition,
  type validate,
} from '@multiagentos/contracts';
import type { AgentDefinitions, AgentUnit } from '../domain/agent/agent-cycle.js';
import type { AgentBinding } from './session-runner.js';

type TSchema = Parameters<typeof validate>[0];

const unitOf = (unit: UnitDefinition): AgentUnit => ({
  ref: { kind: 'UNIT', id: unit.id, version: unit.version, digest: unit.digest },
  failurePolicy: unit.failurePolicy,
  ...(unit.protectedCapabilities.includes('external.read') ? { external: true as const } : {}),
});

type Form = Readonly<Record<string, unknown>> & {
  readonly properties?: Readonly<Record<string, Form>>;
  readonly required?: readonly string[];
  readonly items?: Form;
  readonly enum?: readonly unknown[];
};

/**
 * One form serves every role (D99), and the Agent of the AgentRun narrows it for its own checks:
 * the fields its end action owes become required. The model is shown the form as it is; what it
 * may write is checked against this.
 */
export function requiring(parameters: TSchema, fields: readonly string[] | undefined): TSchema {
  if (fields === undefined) return parameters;
  const form = withoutId(parameters as unknown as Form);
  return { ...form, required: [...new Set([...(form.required ?? []), ...fields])] };
}

/** A narrowed copy is not the registered contract, so it does not carry the contract's id. */
function withoutId(form: Form): Form {
  return Object.fromEntries(Object.entries(form).filter(([key]) => key !== '$id'));
}

/**
 * The spawn form as this Agent may use it (D99): a task names only an Agent of its spawn action's
 * list, and `split`, which makes a worker a lead, is gone where a lead is not in it.
 */
export function startingOnly(parameters: TSchema, agents: readonly string[] | undefined): TSchema {
  if (agents === undefined) return parameters;
  const form = parameters as unknown as Form;
  const tasks = form.properties?.['tasks'];
  const task = tasks?.items;
  const agent = task?.properties?.['agent'];
  if (tasks === undefined || task === undefined || agent?.enum === undefined)
    throw new Error('the spawn tool declares no Agent of a task');
  const kept = Object.entries(task.properties ?? {}).filter(
    ([name]) => name !== 'split' || agents.includes('lead'),
  );
  const properties = {
    ...Object.fromEntries(kept),
    agent: { ...agent, enum: agent.enum.filter((name) => agents.includes(String(name))) },
  };
  return {
    ...withoutId(form),
    properties: { ...form.properties, tasks: { ...tasks, items: { ...task, properties } } },
  };
}

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
  const { agent, model, prompt, units, tools } = set;
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
  // The catalog allows one publishing Unit per Agent. A SubAgent has none.
  const publish = byKind('MESSAGE_PUBLISH');
  if (publish === undefined && agent.actions.onDegraded !== 'RETURN_PARTIAL')
    throw new Error(`Agent ${agent.id} has no publishing Unit`);

  const definitions: AgentDefinitions = {
    label: agent.id,
    limits: {
      maxRounds: agent.limits.maxRounds,
      maxToolCallsPerRound: agent.limits.maxToolCallsPerRound,
    },
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
        parameters: requiring(registry.resolveContract(tool.parametersContract), end.requires),
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
            parameters: startingOnly(
              registry.resolveContract(toolOf(agent.actions.spawn.toolRef).parametersContract),
              agent.actions.spawn.agents,
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
    ...(agent.actions.viewTasks === undefined
      ? {}
      : {
          viewTasksTool: {
            toolName: toolOf(agent.actions.viewTasks.toolRef).modelName,
            parameters: registry.resolveContract(
              toolOf(agent.actions.viewTasks.toolRef).parametersContract,
            ),
          },
        }),
    ...(agent.actions.stop === undefined || !requestedCapabilities.includes('agent.spawn')
      ? {}
      : {
          stopTool: {
            toolName: toolOf(agent.actions.stop.toolRef).modelName,
            parameters: registry.resolveContract(
              toolOf(agent.actions.stop.toolRef).parametersContract,
            ),
          },
        }),
    // Job tools only where commands run (Orchestration 6.2).
    ...(requestedCapabilities.includes('command.exec')
      ? {
          jobTools: (
            [
              ['OUTPUT', agent.actions.jobOutput],
              ['LIST', agent.actions.jobList],
              ['KILL', agent.actions.jobKill],
            ] as const
          ).flatMap(([action, declared]) =>
            declared === undefined
              ? []
              : [
                  {
                    action,
                    toolName: toolOf(declared.toolRef).modelName,
                    parameters: registry.resolveContract(
                      toolOf(declared.toolRef).parametersContract,
                    ),
                  },
                ],
          ),
        }
      : {}),
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
    // What a task that starts with its caller's context is told of its role (D99).
    instructions: prompt.template,
    toolNames: Object.fromEntries(tools.map((tool) => [tool.id, tool.modelName])),
    finishRequires: agent.actions.end.flatMap((end) =>
      end.then === 'FINISH_SUBAGENT' ? (end.requires ?? []) : [],
    ),
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

/** Every tool an Agent's binding lets it call, by the name the model writes. */
export function toolNamesOf(definitions: AgentDefinitions): readonly string[] {
  return [
    ...definitions.tools.map((tool) => tool.modelName),
    ...definitions.endTools.map((tool) => tool.toolName),
    ...[
      definitions.spawnTool,
      definitions.askTool,
      definitions.sleepTool,
      definitions.messageTool,
      definitions.viewTasksTool,
      definitions.stopTool,
      definitions.todoTool,
      ...(definitions.jobTools ?? []),
    ].flatMap((tool) => (tool === undefined ? [] : [tool.toolName])),
  ];
}
