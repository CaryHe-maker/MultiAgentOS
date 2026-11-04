import {
  isProjectInstructionPath,
  isWritable,
  normalizeRequestPath,
  REPOSITORY_ROOT_PATH,
  writeRootCovers,
} from '@multiagentos/contracts';

export type Capability = 'repo.read' | 'workspace.write';
export type StartPreset = 'standard' | 'readonly';

/** Levels live here, not in Unit definitions, which only declare a capability (Kernel/Core 5a.2). */
const CAPABILITY_LEVELS: Readonly<Record<Capability, 'SAFE' | 'UNCERTAIN'>> = {
  'repo.read': 'SAFE',
  'workspace.write': 'UNCERTAIN',
};

const isCapability = (name: string): name is Capability => Object.hasOwn(CAPABILITY_LEVELS, name);

/** What an AgentRun can ever do; computed once at registration and never widened. */
export interface CapabilityCeiling {
  readonly capabilities: ReadonlySet<Capability>;
  readonly writeRoots: readonly string[];
  readonly exclusions: readonly string[];
}

export interface CeilingRequest {
  /** The Agent definition's capabilities. */
  readonly agentCapabilities: readonly Capability[];
  readonly requestedCapabilities: readonly Capability[];
  readonly writeRoots: readonly string[];
  readonly preset: StartPreset;
  readonly exclusions: readonly string[];
}

export type CeilingResult =
  | { readonly ok: true; readonly ceiling: CapabilityCeiling }
  | { readonly ok: false; readonly reasonCode: 'CAPABILITY_NOT_SUBSET' };

/** Kernel/Core 5a.1. What the run asks for may only narrow what the definition and preset allow. */
export function ceilingOf(request: CeilingRequest): CeilingResult {
  const allowed = new Set(
    request.agentCapabilities.filter(
      (capability) => request.preset === 'standard' || CAPABILITY_LEVELS[capability] === 'SAFE',
    ),
  );
  if (!request.requestedCapabilities.every((capability) => allowed.has(capability)))
    return { ok: false, reasonCode: 'CAPABILITY_NOT_SUBSET' };
  const writeRoots = request.writeRoots.flatMap((root) => normalizeRequestPath(root) ?? []);
  if (writeRoots.length !== request.writeRoots.length)
    return { ok: false, reasonCode: 'CAPABILITY_NOT_SUBSET' };
  return {
    ok: true,
    ceiling: {
      capabilities: new Set(request.requestedCapabilities),
      writeRoots,
      exclusions: request.exclusions,
    },
  };
}

/**
 * One line of what the user decided, in this run's memory only (Kernel/Core 5a.4). A grant covers
 * the resource key and everything below it, for the run. A refusal binds the AgentRun that asked,
 * for the whole capability, and the next AgentRun may ask again. `ONCE` belongs to one request.
 */
export type AuthorizationEntry =
  | {
      readonly scope: 'RUN';
      readonly effect: 'ALLOW';
      readonly capability: Capability;
      readonly resourceKey: string;
    }
  | {
      readonly scope: 'RUN';
      readonly effect: 'DENY';
      readonly capability: Capability;
      readonly agentRunId: string;
    }
  | {
      readonly scope: 'ONCE';
      readonly effect: 'ALLOW' | 'DENY';
      readonly capability: Capability;
      readonly requestId: string;
    };

export interface UnitDemand {
  readonly requestId: string;
  readonly agentRunId: string;
  /** The Unit's declared capability, unchecked: a name Core does not know is a failed check. */
  readonly capability: string;
  /** The path of a write, from the Unit's input. */
  readonly path?: string;
}

export type UnitDecision =
  | { readonly kind: 'ALLOW'; readonly capability: Capability; readonly resourceKey: string }
  | {
      readonly kind: 'REFUSE';
      readonly reasonCode:
        | 'CAPABILITY_NOT_GRANTED'
        | 'WRITE_OUT_OF_SCOPE'
        | 'PROTECTED_PATH'
        | 'USER_DECLINED'
        | 'ADMISSION_CHECK_FAILED';
    }
  | {
      readonly kind: 'ASK';
      readonly capability: Capability;
      readonly resourceKey: string;
      /** Asked per attempt with ONCE and DENY only, and never merged (Kernel/Core 5a.2). */
      readonly critical: boolean;
    };

/** What applies whatever the resource is: the answer to this request, or a bound refusal. */
const answered = (
  entries: readonly AuthorizationEntry[],
  demand: UnitDemand,
  capability: Capability,
): 'ALLOW' | 'DENY' | undefined => {
  const relevant = entries.filter((entry) => entry.capability === capability);
  const once = relevant.find(
    (entry) => entry.scope === 'ONCE' && entry.requestId === demand.requestId,
  );
  if (once !== undefined) return once.effect;
  if (
    relevant.some(
      (entry) =>
        entry.scope === 'RUN' && entry.effect === 'DENY' && entry.agentRunId === demand.agentRunId,
    )
  )
    return 'DENY';
  return undefined;
};

const granted = (
  entries: readonly AuthorizationEntry[],
  capability: Capability,
  resourceKey: string,
): boolean =>
  entries.some(
    (entry) =>
      entry.capability === capability &&
      entry.scope === 'RUN' &&
      entry.effect === 'ALLOW' &&
      writeRootCovers(entry.resourceKey, resourceKey),
  );

function decide(
  demand: UnitDemand,
  ceiling: CapabilityCeiling,
  entries: readonly AuthorizationEntry[],
): UnitDecision {
  const { capability } = demand;
  if (!isCapability(capability)) return { kind: 'REFUSE', reasonCode: 'ADMISSION_CHECK_FAILED' };
  // ②
  if (!ceiling.capabilities.has(capability))
    return { kind: 'REFUSE', reasonCode: 'CAPABILITY_NOT_GRANTED' };

  // ③ The resource key of a write is the write root it falls under.
  let resourceKey: string = REPOSITORY_ROOT_PATH;
  let critical = false;
  if (capability === 'workspace.write') {
    if (demand.path === undefined) return { kind: 'REFUSE', reasonCode: 'ADMISSION_CHECK_FAILED' };
    const access = isWritable(ceiling, demand.path);
    if (!access.writable) return { kind: 'REFUSE', reasonCode: access.reasonCode };
    resourceKey = access.writeRoot;
    critical = isProjectInstructionPath(access.path);
  }

  // ④ A critical write never relies on an earlier grant; a refusal of the capability still binds.
  const decided = answered(entries, demand, capability);
  if (decided === 'DENY') return { kind: 'REFUSE', reasonCode: 'USER_DECLINED' };
  if (decided === 'ALLOW' || (!critical && granted(entries, capability, resourceKey)))
    return { kind: 'ALLOW', capability, resourceKey };
  // ⑤
  return { kind: 'ASK', capability, resourceKey, critical };
}

/**
 * The decision order of Kernel/Core 5a.3, ② to ⑤: pure, so the Session actor only acts on what it
 * returns. Anything going wrong inside is a refusal, never a pass.
 */
export function decideUnit(
  demand: UnitDemand,
  ceiling: CapabilityCeiling,
  entries: readonly AuthorizationEntry[],
): UnitDecision {
  try {
    return decide(demand, ceiling, entries);
  } catch {
    return { kind: 'REFUSE', reasonCode: 'ADMISSION_CHECK_FAILED' };
  }
}
