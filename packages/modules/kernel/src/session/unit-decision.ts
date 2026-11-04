import {
  capabilitiesUnderPreset,
  isProjectInstructionPath,
  isWritable,
  normalizeRequestPath,
  PROTECTED_CAPABILITIES,
  REPOSITORY_ROOT_PATH,
  writeRootCovers,
  type ProtectedCapability,
  type UNREUSABLE_REASONS,
} from '@multiagentos/contracts';

/** What the analysis of a command line says (ExecutorSet 5c); Core never parses it itself. */
export interface CommandAnalysis {
  /** The whole line, whitespace-normalised: the resource key of "this command". */
  readonly text: string;
  readonly subcommands: readonly {
    readonly text: string;
    /** Name and arguments, quotes taken off. */
    readonly words: readonly string[];
    readonly prefix?: string;
  }[];
  readonly unreusable: readonly (typeof UNREUSABLE_REASONS)[number][];
  /** The first deniedCommands pattern that matched, from the tree or the text. */
  readonly denied?: string;
  /** The first criticalCommands pattern that matched. */
  readonly critical?: string;
}

/** What the Unit asks for when it is a command (Kernel/Core 5b). */
export interface CommandDemand {
  readonly analysis: CommandAnalysis;
  /** Relative to the repository root, '' for the root. */
  readonly workdir: string;
  readonly network: boolean;
  readonly sandbox: 'AVAILABLE' | 'UNAVAILABLE';
  readonly unavailablePolicy: 'deny' | 'ask-unisolated';
}

export type Capability = ProtectedCapability;
export type StartPreset = 'standard' | 'readonly';

const isCapability = (name: string): name is Capability =>
  (PROTECTED_CAPABILITIES as readonly string[]).includes(name);

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
  const allowed = new Set(capabilitiesUnderPreset(request.agentCapabilities, request.preset));
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
  /** "This command" or "this prefix" from now on, in one work directory. */
  | {
      readonly scope: 'RUN';
      readonly effect: 'ALLOW';
      readonly capability: 'command.exec';
      readonly command: {
        readonly kind: 'COMMAND' | 'PREFIX';
        readonly workdir: string;
        readonly value: string;
      };
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
  readonly command?: CommandDemand;
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
        | 'COMMAND_DENIED'
        | 'SANDBOX_UNAVAILABLE'
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
      'resourceKey' in entry &&
      writeRootCovers(entry.resourceKey, resourceKey),
  );

/** True when `words` start with every word of `prefix`. */
const startsWith = (words: readonly string[], prefix: string): boolean =>
  prefix.split(' ').every((word, index) => words[index] === word);

/** Every simple command of the line is covered by an entry of this work directory. */
const commandsCovered = (
  entries: readonly AuthorizationEntry[],
  command: CommandDemand,
  workdir: string,
): boolean =>
  command.analysis.subcommands.length > 0 &&
  command.analysis.subcommands.every((sub) =>
    entries.some(
      (entry) =>
        entry.scope === 'RUN' &&
        entry.effect === 'ALLOW' &&
        'command' in entry &&
        entry.command.workdir === workdir &&
        (entry.command.kind === 'COMMAND'
          ? entry.command.value === sub.text
          : startsWith(sub.words, entry.command.value)),
    ),
  );

/** Kernel/Core 5b: the checks of a command, in the order of 5a.3. */
function decideCommand(
  demand: UnitDemand,
  ceiling: CapabilityCeiling,
  entries: readonly AuthorizationEntry[],
): UnitDecision {
  const { command } = demand;
  if (command === undefined) return { kind: 'REFUSE', reasonCode: 'ADMISSION_CHECK_FAILED' };
  // ① what the user or the system forbade beforehand
  if (command.analysis.denied !== undefined)
    return { kind: 'REFUSE', reasonCode: 'COMMAND_DENIED' };
  // ② the ceiling, and a sandbox that is there (or the user's word that it need not be)
  if (
    !ceiling.capabilities.has('command.exec') ||
    (command.network && !ceiling.capabilities.has('command.network'))
  )
    return { kind: 'REFUSE', reasonCode: 'CAPABILITY_NOT_GRANTED' };
  if (command.sandbox === 'UNAVAILABLE' && command.unavailablePolicy === 'deny')
    return { kind: 'REFUSE', reasonCode: 'SANDBOX_UNAVAILABLE' };
  // ③ the work directory stays inside the repository
  const workdir =
    command.workdir === '' ? REPOSITORY_ROOT_PATH : normalizeRequestPath(command.workdir);
  if (workdir === undefined) return { kind: 'REFUSE', reasonCode: 'ADMISSION_CHECK_FAILED' };
  const critical =
    command.analysis.critical !== undefined || command.network || command.sandbox === 'UNAVAILABLE';
  const perAttempt = critical || command.analysis.unreusable.length > 0;
  // ④ a critical command never relies on an earlier grant; a refusal of the capability still binds
  const decided = answered(entries, demand, 'command.exec');
  if (decided === 'DENY') return { kind: 'REFUSE', reasonCode: 'USER_DECLINED' };
  if (decided === 'ALLOW' || (!perAttempt && commandsCovered(entries, command, workdir)))
    return { kind: 'ALLOW', capability: 'command.exec', resourceKey: workdir };
  // ⑤
  return {
    kind: 'ASK',
    capability: 'command.exec',
    resourceKey: `${workdir}\u0000${command.analysis.text}`,
    critical: perAttempt,
  };
}

function decide(
  demand: UnitDemand,
  ceiling: CapabilityCeiling,
  entries: readonly AuthorizationEntry[],
): UnitDecision {
  const { capability } = demand;
  if (!isCapability(capability)) return { kind: 'REFUSE', reasonCode: 'ADMISSION_CHECK_FAILED' };
  if (capability === 'command.exec') return decideCommand(demand, ceiling, entries);
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
