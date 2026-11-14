import { Type, type Static, type TSchema } from 'typebox';
import { ExecutionKindSchema } from '../platform-common/execution-kind.js';
import { FAILURE_POLICY_CODES } from '../platform-common/reason-code.js';

/**
 * AgentToolPool definition protocol (catalog.*).
 *
 * A definition is a versioned, content-addressed document. From v1.0.0 on it is immutable;
 * v0.x versions are drafts edited in place. Its `digest` is the SHA-256 of the canonical JSON
 * of the definition without the `digest` field, where every reference is expanded with the
 * digest of its target (a Merkle tree). Pinning an agent's digest therefore pins the whole
 * Agent -> Unit -> Tool / Model / Prompt closure.
 *
 * This file may import only `../platform-common/` (SharedContracts 2): the other families
 * import the pinned reference schema from here, and an import cycle between ES modules would
 * read `const` bindings before they are initialised.
 */

/**
 * Recursively readonly view of a JSON value. Published definitions are frozen at runtime;
 * this type makes the compiler reject writes as well (Style §2.2).
 */
export type DeepReadonly<T> = T extends (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export const DEFINITION_KINDS = ['AGENT', 'UNIT', 'TOOL', 'MODEL', 'PROMPT', 'TEMPLATE'] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];
export const DefinitionKindSchema = Type.Enum(DEFINITION_KINDS, {
  $id: 'catalog.DefinitionKind.v1',
});

/** Stable logical identity, lower kebab-case, e.g. `code-viewer`. */
export const DefinitionIdSchema = Type.String({
  pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
  maxLength: 64,
});
/** Exact version tag `v<major>.<minor>.<patch>`; there are no version ranges. */
export const DefinitionVersionTagSchema = Type.String({
  pattern: '^v(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$',
});
export const Sha256HexSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });

export const DefinitionStatusSchema = Type.Union(
  [
    Type.Literal('ACTIVE'),
    Type.Literal('DEPRECATED'),
    Type.Literal('QUARANTINED'),
    Type.Literal('REVOKED'),
  ],
  { $id: 'catalog.DefinitionStatus.v1' },
);
export type DefinitionStatus = Static<typeof DefinitionStatusSchema>;

/** Whether authored content is final or a stand-in until its owner designs it. */
const ContentStatusSchema = Type.Union([Type.Literal('PLACEHOLDER'), Type.Literal('FINAL')]);

const TextSchema = (maxLength: number) => Type.String({ minLength: 1, maxLength });

/** Reference written inside a definition file. The digest is derived, never hand-written. */
export const DefinitionRefSchema = Type.Object(
  { id: DefinitionIdSchema, version: DefinitionVersionTagSchema },
  { additionalProperties: false, $id: 'catalog.DefinitionRef.v1' },
);
export type DefinitionRef = Static<typeof DefinitionRefSchema>;

/** Fully resolved reference used across module boundaries (runs, projections, audit). */
export const PinnedDefinitionRefSchema = Type.Object(
  {
    kind: DefinitionKindSchema,
    id: DefinitionIdSchema,
    version: DefinitionVersionTagSchema,
    digest: Sha256HexSchema,
  },
  { additionalProperties: false, $id: 'catalog.PinnedDefinitionRef.v1' },
);
export type PinnedDefinitionRef = Static<typeof PinnedDefinitionRefSchema>;

/** A PinnedDefinitionRef that must name a definition of one given kind; the static type stays the same. */
export const pinnedRefOf = (kind: DefinitionKind) =>
  Type.Unsafe<PinnedDefinitionRef>(
    Type.Object(
      {
        kind: Type.Literal(kind),
        id: DefinitionIdSchema,
        version: DefinitionVersionTagSchema,
        digest: Sha256HexSchema,
      },
      { additionalProperties: false },
    ),
  );

/** Points at a registered protocol schema, e.g. `{ id: 'context.ContextPack', version: 'v1' }`. */
export const ContractRefSchema = Type.Object(
  {
    kind: Type.Literal('contract'),
    id: Type.String({ pattern: '^[a-z][a-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+$', maxLength: 160 }),
    version: Type.String({ pattern: '^v[0-9]+$' }),
  },
  { additionalProperties: false, $id: 'catalog.ContractRef.v1' },
);
export type ContractRef = Static<typeof ContractRefSchema>;

const UniqueRefs = (options: { readonly minItems: number }) =>
  Type.Array(DefinitionRefSchema, { ...options, uniqueItems: true });

/**
 * Fields shared by every definition. `kind` is a literal per definition type so that the
 * union below is discriminated: checking `definition.kind === 'MODEL'` narrows the TypeScript
 * type to ModelDefinition.
 */
const header = <K extends DefinitionKind>(kind: K) => ({
  schemaVersion: Type.Literal('v1'),
  kind: Type.Literal(kind),
  id: DefinitionIdSchema,
  version: DefinitionVersionTagSchema,
  digest: Sha256HexSchema,
  description: TextSchema(2_000),
});

const EffortSchema = Type.Enum(['none', 'low', 'high', 'max']);

export const PROTECTED_CAPABILITIES = [
  'repo.read',
  'workspace.write',
  'command.exec',
  'command.network',
  /** The two web tools (M2Design 5.2, 8.1); asked per WorkflowRun and per host. */
  'web.search',
  'web.fetch',
  /**
   * Reading outside the workspace, by absolute path (M2Design 5.2): dangerous, asked once for each
   * external repository and per WorkflowRun, and only the main Agent has it.
   */
  'external.read',
  /** Only a top-level AgentRun has it: a SubAgent cannot spawn (M2Design 5.2, 5.4). */
  'agent.spawn',
] as const;
export type ProtectedCapability = (typeof PROTECTED_CAPABILITIES)[number];

/** Safe capabilities: asked at most once, for the repository as a whole (M2Design 5.2). */
const SAFE_CAPABILITIES: ReadonlySet<ProtectedCapability> = new Set(['repo.read', 'agent.spawn']);

/** What a start preset leaves of an Agent's capabilities: `readonly` keeps the safe ones. */
export function capabilitiesUnderPreset(
  capabilities: readonly ProtectedCapability[],
  preset: 'standard' | 'readonly',
): readonly ProtectedCapability[] {
  return capabilities.filter((c) => preset === 'standard' || SAFE_CAPABILITIES.has(c));
}

/**
 * Commands are offered when they can run isolated, or when the user chose to be asked about
 * running them without isolation (M2Design 6.2).
 */
export function commandsOffered(
  sandboxAvailable: boolean,
  unavailablePolicy: 'deny' | 'ask-unisolated',
): boolean {
  return sandboxAvailable || unavailablePolicy === 'ask-unisolated';
}

/**
 * What an Agent asks for when it is started, whoever starts it: its capabilities under the start
 * preset, without the command ones where commands cannot run here. The tools the model is offered
 * come from this and from nothing else, so the one function serves the registration of an AgentRun
 * and every request that must begin as that AgentRun's requests do (the compaction of its context).
 */
export function requestedCapabilitiesOf(
  capabilities: readonly ProtectedCapability[],
  preset: 'standard' | 'readonly',
  commands: boolean,
): readonly ProtectedCapability[] {
  return capabilitiesUnderPreset(capabilities, preset).filter(
    (capability) => commands || (capability !== 'command.exec' && capability !== 'command.network'),
  );
}

export const AgentDefinitionSchema = Type.Object(
  {
    ...header('AGENT'),
    role: TextSchema(200),
    modelRef: DefinitionRefSchema,
    thinking: Type.Object(
      {
        defaultEffort: EffortSchema,
        allowedEfforts: Type.Array(EffortSchema, { minItems: 1, uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
    promptRef: DefinitionRefSchema,
    unitRefs: UniqueRefs({ minItems: 1 }),
    startUnitRefs: UniqueRefs({ minItems: 0 }),
    /** How this Agent may end; a tool that is not declared here cannot end it. */
    actions: Type.Object(
      {
        end: Type.Array(
          Type.Object(
            {
              toolRef: DefinitionRefSchema,
              then: Type.Enum(['PUBLISH_REPLY', 'PUBLISH_REPORT', 'HANDOFF', 'FINISH_SUBAGENT']),
              allowedInFinal: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
        onDegraded: Type.Enum(['PUBLISH_NOTICE', 'PUBLISH_REPORT', 'RETURN_PARTIAL']),
        /** The `update_todos` tool, which ends nothing (M2Design 3.5). */
        todos: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
        /** The `ask_user` tool: main and worker have it, explorer does not (M2Design 3.4). */
        askUser: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
        /** The `run_subagents` tool of an Agent whose ceiling has `agent.spawn` (M2Design 3.6). */
        spawn: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
        /** The `sub_mission` tool: a part of the work handed to a pre-orchestrated template (3.9). */
        subMission: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
        /** The `sleep` tool: the segment ends and the task waits to be woken (Orchestration 4.1). */
        sleep: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
        /** The `send_message` tool: a message to tasks along the tree (Orchestration 5). */
        message: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
        /** The `view_tasks` tool: the task tree as it is now (Orchestration 3.7). */
        viewTasks: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
        /** The `stop_subagents` tool of an Agent that spawns (Orchestration 5.1). */
        stop: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
        /** The job tools of an Agent that runs commands (Orchestration 6.2). */
        jobOutput: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
        jobList: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
        jobKill: Type.Optional(
          Type.Object({ toolRef: DefinitionRefSchema }, { additionalProperties: false }),
        ),
      },
      { additionalProperties: false },
    ),
    /** An Agent that `run_subagents` may start, with the share of budget it gets by default. */
    spawnable: Type.Optional(
      Type.Object({ defaultShare: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
    ),
    /** The source of the capability ceiling (Kernel/Core 5a.1). */
    capabilities: Type.Array(Type.Enum(PROTECTED_CAPABILITIES), { uniqueItems: true }),
    limits: Type.Object(
      {
        maxRounds: Type.Integer({ minimum: 1, maximum: 100 }),
        maxToolCallsPerRound: Type.Integer({ minimum: 0, maximum: 32 }),
        maxToolUnits: Type.Integer({ minimum: 1, maximum: 1000 }),
        maxWallClockMs: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
    budget: Type.Object(
      {
        perCallInputLimit: Type.Integer({ minimum: 1 }),
        maxOutputTokens: Type.Integer({ minimum: 1 }),
        finalInputBudget: Type.Integer({ minimum: 1 }),
        finalMaxOutputTokens: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'catalog.AgentDefinition.v1' },
);
export type AgentDefinition = DeepReadonly<Static<typeof AgentDefinitionSchema>>;

/** The smallest share of budget an Agent can work with: its final call and two ordinary ones. */
export function agentMinShare(budget: {
  readonly perCallInputLimit: number;
  readonly maxOutputTokens: number;
  readonly finalInputBudget: number;
  readonly finalMaxOutputTokens: number;
}): number {
  return (
    budget.finalInputBudget +
    budget.finalMaxOutputTokens +
    2 * (budget.perCallInputLimit + budget.maxOutputTokens)
  );
}

export const FAILURE_HANDLINGS = [
  'RETURN_TO_MODEL',
  'FINAL_CALL',
  'DEGRADED_REPORT',
  'FATAL',
] as const;
export type FailureHandling = (typeof FAILURE_HANDLINGS)[number];
/** Keyed by the reason codes of a UnitReport; a code that is not listed is handled as FATAL. */
export type FailurePolicy = {
  readonly [Code in (typeof FAILURE_POLICY_CODES)[number]]?: FailureHandling;
};
const FailurePolicySchema = Type.Unsafe<FailurePolicy>(
  Type.Object(
    Object.fromEntries(
      FAILURE_POLICY_CODES.map((code) => [code, Type.Optional(Type.Enum(FAILURE_HANDLINGS))]),
    ),
    { additionalProperties: false },
  ),
);

export const UnitDefinitionSchema = Type.Object(
  {
    ...header('UNIT'),
    /** Selects the Executor; COMMAND and TEST are rejected by Core until their stage. */
    executionKind: ExecutionKindSchema,
    /** Capabilities that need a Lease. The caller and the model cannot remove them. */
    protectedCapabilities: Type.Array(Type.Enum(PROTECTED_CAPABILITIES), { uniqueItems: true }),
    inputContract: ContractRefSchema,
    outputContract: ContractRefSchema,
    /** Zero or one tool of purpose UNIT, whose parameters are this Unit input. */
    toolRefs: UniqueRefs({ minItems: 0 }),
    effect: Type.Enum(['READ_ONLY', 'WORKSPACE_WRITE', 'EXTERNAL']),
    isIdempotent: Type.Boolean(),
    failurePolicy: FailurePolicySchema,
  },
  { additionalProperties: false, $id: 'catalog.UnitDefinition.v1' },
);
export type UnitDefinition = DeepReadonly<Static<typeof UnitDefinitionSchema>>;

export const ToolDefinitionSchema = Type.Object(
  {
    ...header('TOOL'),
    /** UNIT maps to one Unit; CONTROL ends the Agent or hands its task over. */
    purpose: Type.Union([Type.Literal('UNIT'), Type.Literal('CONTROL')]),
    /** Name shown to the model in tool calling; follows the common provider name rules. */
    modelName: Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' }),
    modelDescription: TextSchema(4_000),
    /** For a UNIT tool, the inputContract of its Unit, or the part of it the model writes. */
    parametersContract: ContractRefSchema,
    /** The tool is the answer to the user, such as the reply: the console says so while the model writes it. */
    answer: Type.Optional(Type.Boolean()),
    riskClass: Type.Union([
      Type.Literal('READ_ONLY'),
      Type.Literal('LOW'),
      Type.Literal('MEDIUM'),
      Type.Literal('HIGH'),
    ]),
    sideEffect: Type.Union([
      Type.Literal('NONE'),
      Type.Literal('WORKSPACE_WRITE'),
      Type.Literal('EXTERNAL'),
    ]),
    isIdempotent: Type.Boolean(),
    contentStatus: ContentStatusSchema,
  },
  { additionalProperties: false, $id: 'catalog.ToolDefinition.v1' },
);
export type ToolDefinition = DeepReadonly<Static<typeof ToolDefinitionSchema>>;

export const PromptDefinitionSchema = Type.Object(
  {
    ...header('PROMPT'),
    role: Type.Literal('system'),
    /** Body with `{{variable}}` slots; must be byte-stable because it is a cache prefix. */
    template: TextSchema(100_000),
    variables: Type.Array(
      Type.Object(
        {
          name: Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,63}$' }),
          description: TextSchema(500),
        },
        { additionalProperties: false },
      ),
    ),
    contentStatus: ContentStatusSchema,
  },
  { additionalProperties: false, $id: 'catalog.PromptDefinition.v1' },
);
export type PromptDefinition = DeepReadonly<Static<typeof PromptDefinitionSchema>>;

/**
 * Prices are integers in micro-USD per one million tokens (0.15 USD -> 150000) so that
 * digests never depend on floating-point formatting.
 */
const TokenRatesSchema = Type.Object(
  {
    inputCacheHit: Type.Integer({ minimum: 0 }),
    inputCacheMiss: Type.Integer({ minimum: 0 }),
    output: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const ClockTimeSchema = Type.String({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' });

const ThinkingRequestSchema = Type.Union([
  Type.Object({ thinking: Type.Literal('DISABLED') }, { additionalProperties: false }),
  Type.Object(
    { thinking: Type.Literal('ENABLED'), providerEffort: Type.Optional(TextSchema(32)) },
    { additionalProperties: false },
  ),
]);

export const ModelDefinitionSchema = Type.Object(
  {
    ...header('MODEL'),
    provider: DefinitionIdSchema,
    /** Model name sent to the provider API. */
    apiModelId: TextSchema(128),
    /** Provider's own name for the model behind `apiModelId` at `pricing.source.verifiedOn`. */
    providerModelLabel: TextSchema(128),
    apiProtocol: Type.Union([
      Type.Literal('OPENAI_CHAT_COMPLETIONS'),
      Type.Literal('ANTHROPIC_MESSAGES'),
    ]),
    baseUrl: Type.String({ pattern: '^https://[^\\s]+$', maxLength: 512 }),
    limits: Type.Object(
      {
        contextWindowTokens: Type.Integer({ minimum: 1 }),
        maxOutputTokens: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    features: Type.Object(
      {
        hasJsonOutput: Type.Boolean(),
        hasToolCalls: Type.Boolean(),
        hasVision: Type.Boolean(),
        thinking: Type.Object(
          {
            isSupported: Type.Boolean(),
            effortMapping: Type.Array(
              Type.Object(
                { effort: EffortSchema, request: ThinkingRequestSchema },
                { additionalProperties: false },
              ),
            ),
            replayReasoning: Type.Enum(['REQUIRED', 'OPTIONAL', 'UNSUPPORTED']),
            missingReasoningFill: Type.Enum(['EMPTY_STRING', 'OMIT']),
            reasoningCountsAsOutput: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    pricing: Type.Object(
      {
        currency: Type.Literal('USD'),
        unit: Type.Literal('MICRO_USD_PER_MILLION_TOKENS'),
        offPeak: TokenRatesSchema,
        peak: Type.Object(
          {
            /** Peak price = off-peak price * ratePercent / 100. */
            ratePercent: Type.Integer({ minimum: 100 }),
            timeZone: Type.Literal('UTC'),
            /** ISO weekday numbers, Monday = 1. */
            weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), {
              minItems: 1,
              uniqueItems: true,
            }),
            /** Half-open intervals [start, end). */
            windows: Type.Array(
              Type.Object(
                { start: ClockTimeSchema, end: ClockTimeSchema },
                { additionalProperties: false },
              ),
              { minItems: 1 },
            ),
          },
          { additionalProperties: false },
        ),
        source: Type.Object(
          {
            url: Type.String({ pattern: '^https://[^\\s]+$', maxLength: 512 }),
            verifiedOn: Type.String({ format: 'date' }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'catalog.ModelDefinition.v1' },
);
export type ModelDefinition = DeepReadonly<Static<typeof ModelDefinitionSchema>>;

const NodeNameSchema = Type.String({ pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 64 });
const ScalarSchema = Type.Union([Type.String(), Type.Boolean()]);

/** Exactly one of `equals` and `in`; the field is a path into the predecessor's result. */
export const EdgeConditionSchema = Type.Refine(
  Type.Object(
    {
      field: TextSchema(128),
      equals: Type.Optional(ScalarSchema),
      in: Type.Optional(Type.Array(ScalarSchema, { minItems: 1 })),
    },
    { additionalProperties: false },
  ),
  (condition) => (condition.equals === undefined) !== (condition.in === undefined),
  () => 'exactly one of equals and in must be present',
);
export type EdgeCondition = Static<typeof EdgeConditionSchema>;

const TemplateDependencySchema = Type.Union([
  NodeNameSchema,
  Type.Object({ node: NodeNameSchema, when: EdgeConditionSchema }, { additionalProperties: false }),
]);

/**
 * The playbook of a pre-orchestrated template (Orchestration 3.9, D31): what the root of a
 * subMission follows. Phases come in order; a phase with `tasks` is one `run_subagents` call of the
 * root, of tasks of that Agent and in that number, which the system checks; `repeat` lets it come
 * again (a bounded loop); `optional` lets it be passed over. `example` is a worked plan the root
 * reads first (D32).
 */
export const PlaybookPhaseSchema = Type.Object(
  {
    name: NodeNameSchema,
    /** What the root does at this phase: how it writes the goals, what it decides. */
    instructions: TextSchema(2_000),
    tasks: Type.Optional(
      Type.Object(
        {
          agent: Type.Enum(['explorer', 'worker']),
          min: Type.Integer({ minimum: 1, maximum: 8 }),
          max: Type.Integer({ minimum: 1, maximum: 8 }),
          /**
           * `inherit`: the tasks of this phase start with the whole context of the root of the
           * subMission as it stood at the call, so they read nothing again (Orchestration 3.9,
           * D35). Set by the template, never chosen by the model.
           */
          context: Type.Optional(Type.Literal('inherit')),
        },
        { additionalProperties: false },
      ),
    ),
    /** How many times in all the phase may run (a bounded loop); 1 when absent. */
    repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    optional: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type PlaybookPhase = Static<typeof PlaybookPhaseSchema>;

export const PlaybookSchema = Type.Object(
  {
    /** One line for the caller: what the template is for and when to use it. */
    summary: TextSchema(400),
    params: Type.Array(
      Type.Object(
        {
          name: Type.String({ pattern: '^[a-z][a-zA-Z0-9]{0,39}$' }),
          description: TextSchema(400),
          required: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 8 },
    ),
    phases: Type.Array(PlaybookPhaseSchema, { minItems: 1, maxItems: 8 }),
    /** A worked plan: a brief, what the root writes at each phase, and the report (D32). */
    example: TextSchema(6_000),
  },
  { additionalProperties: false },
);
export type Playbook = Static<typeof PlaybookSchema>;

export const TemplateNodeSchema = Type.Union([
  Type.Object(
    {
      name: NodeNameSchema,
      kind: Type.Literal('AGENT'),
      agent: DefinitionRefSchema,
      goal: Type.Optional(TextSchema(4_000)),
      dependsOn: Type.Optional(Type.Array(TemplateDependencySchema)),
      inputFrom: Type.Optional(Type.Literal('HANDOFF')),
      output: Type.Optional(Type.Boolean()),
      /** A step of the template's root task, its one responsible owner (Orchestration 3.5). */
      role: Type.Optional(Type.Literal('owner')),
      /**
       * What the Agent of this step reads with its goal (D32): worked examples of how to use the
       * system well, written as the behaviour wanted.
       */
      guide: Type.Optional(TextSchema(60_000)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { name: NodeNameSchema, kind: Type.Literal('HUMAN') },
    { additionalProperties: false },
  ),
]);
export type TemplateNode = Static<typeof TemplateNodeSchema>;

export const TemplateDefinitionSchema = Type.Object(
  {
    ...header('TEMPLATE'),
    origin: Type.Enum(['BUILTIN', 'REPOSITORY']),
    /**
     * The one responsible owner of the graph (Orchestration 3.5): the Agent of every node marked
     * `role: owner`, which are the steps of the root task; every other AGENT node is a task below
     * it. A template without one has its first AGENT node as the root.
     */
    owner: Type.Optional(
      Type.Object({ agent: DefinitionRefSchema }, { additionalProperties: false }),
    ),
    nodes: Type.Array(TemplateNodeSchema, { minItems: 1 }),
    /**
     * A pre-orchestrated template (Orchestration 3.9): what the root of a subMission started with
     * it follows. Such a template runs through `sub_mission`; its one node is that root.
     */
    playbook: Type.Optional(PlaybookSchema),
  },
  { additionalProperties: false, $id: 'catalog.TemplateDefinition.v1' },
);
export type TemplateDefinition = DeepReadonly<Static<typeof TemplateDefinitionSchema>>;

/**
 * Maps a kind literal to its definition type, so `DefinitionByKind['MODEL']` is
 * `ModelDefinition`. Used to type lookups: asking for kind K returns DefinitionByKind[K].
 */
export interface DefinitionByKind {
  readonly AGENT: AgentDefinition;
  readonly UNIT: UnitDefinition;
  readonly TOOL: ToolDefinition;
  readonly MODEL: ModelDefinition;
  readonly PROMPT: PromptDefinition;
  readonly TEMPLATE: TemplateDefinition;
}
export type Definition = DefinitionByKind[DefinitionKind];

export const DEFINITION_SCHEMAS: { readonly [K in DefinitionKind]: TSchema } = {
  AGENT: AgentDefinitionSchema,
  UNIT: UnitDefinitionSchema,
  TOOL: ToolDefinitionSchema,
  MODEL: ModelDefinitionSchema,
  PROMPT: PromptDefinitionSchema,
  TEMPLATE: TemplateDefinitionSchema,
};

/** As authored: drafts (v0.x) never store a digest, published versions only after sealing. */
export const DEFINITION_DRAFT_SCHEMAS: { readonly [K in DefinitionKind]: TSchema } = {
  AGENT: Type.Omit(AgentDefinitionSchema, ['digest'], { additionalProperties: false }),
  UNIT: Type.Omit(UnitDefinitionSchema, ['digest'], { additionalProperties: false }),
  TOOL: Type.Omit(ToolDefinitionSchema, ['digest'], { additionalProperties: false }),
  MODEL: Type.Omit(ModelDefinitionSchema, ['digest'], { additionalProperties: false }),
  PROMPT: Type.Omit(PromptDefinitionSchema, ['digest'], { additionalProperties: false }),
  TEMPLATE: Type.Omit(TemplateDefinitionSchema, ['digest'], { additionalProperties: false }),
};
