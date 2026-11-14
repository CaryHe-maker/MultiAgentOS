import type { GraphNodeRecord, ThinkingEffort } from '@multiagentos/contracts';

/**
 * How an AgentRun is registered with the Kernel (M2Design 3.6, 6.4). A top-level AgentRun takes
 * everything from its Agent's binding; a SubAgent takes what its task asked for, and says who
 * started it. This is the one place that tells the two apart.
 */
export interface Placement {
  readonly effort: ThinkingEffort;
  /** What the activity area calls it. */
  readonly label: string;
  readonly writeRoots: readonly string[];
  /** Of a SubAgent: who started it, under which delegation, for which task. */
  readonly link?: {
    readonly parentAgentRunId?: string;
    readonly delegationId: string;
    readonly taskName: string;
  };
}

/** `dispatch`: the AgentRun that dispatched the node, and the delegation that funds it. */
export function placementOf(
  node: GraphNodeRecord,
  agent: {
    readonly label: string;
    readonly effort: ThinkingEffort;
    readonly writeRoots: readonly string[];
  },
  dispatch?: { readonly parentAgentRunId?: string; readonly delegationId: string },
): Placement {
  const { spawn } = node;
  if (spawn === undefined || dispatch === undefined)
    return { effort: agent.effort, label: agent.label, writeRoots: agent.writeRoots };
  return {
    effort: spawn.effort ?? agent.effort,
    label: `${agent.label} ${node.name}`,
    writeRoots: spawn.writeScope,
    link: { ...dispatch, taskName: node.name },
  };
}
