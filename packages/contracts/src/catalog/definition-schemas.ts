import { Type, type Static, type TSchema } from 'typebox';

/**
 * AgentToolPool definition protocol (catalog.*).
 *
 * A definition is a versioned, content-addressed document. From v1.0.0 on it is immutable;
 * v0.x versions are drafts edited in place during M1. Its `digest` is the SHA-256 of the
 * canonical JSON of the definition without the `digest` field, where every reference is
 * expanded with the digest of its target (a Merkle tree). Pinning an agent's digest therefore
 * pins the whole Agent -> Unit -> Tool / Model / Prompt closure.
 *
 * This file must not import `../schemas.js`: `schemas.ts` imports the pinned reference schema
 * from here, and an import cycle between ES modules would read `const` bindings before they
 * are initialised.
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

export const DEFINITION_KINDS = ['AGENT', 'UNIT', 'TOOL', 'MODEL', 'PROMPT'] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];
export const DefinitionKindSchema = Type.Union(
  [
    Type.Literal('AGENT'),
    Type.Literal('UNIT'),
    Type.Literal('TOOL'),
    Type.Literal('MODEL'),
    Type.Literal('PROMPT'),
  ],
  { $id: 'catalog.DefinitionKind.v0' },
);

/** Stable logical identity, lower kebab-case, e.g. `repository-analysis-agent`. */
export const DefinitionIdSchema = Type.String({
  pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
  maxLength: 64,
});
/** Exact version tag `v<major>.<minor>.<patch>`; M1 has no version ranges. */
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
  { $id: 'catalog.DefinitionStatus.v0' },
);
export type DefinitionStatus = Static<typeof DefinitionStatusSchema>;

/** Whether authored content is final or a stand-in until its owner designs it. */
const ContentStatusSchema = Type.Union([Type.Literal('PLACEHOLDER'), Type.Literal('FINAL')]);

const TextSchema = (maxLength: number) => Type.String({ minLength: 1, maxLength });

/** Reference written inside a definition file. The digest is derived, never hand-written. */
export const DefinitionRefSchema = Type.Object(
  { id: DefinitionIdSchema, version: DefinitionVersionTagSchema },
  { additionalProperties: false, $id: 'catalog.DefinitionRef.v0' },
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
  { additionalProperties: false, $id: 'catalog.PinnedDefinitionRef.v0' },
);
export type PinnedDefinitionRef = Static<typeof PinnedDefinitionRefSchema>;

/** Points at a registered protocol schema, e.g. `{ id: 'context.ContextPack', version: 'v0' }`. */
export const ContractRefSchema = Type.Object(
  {
    kind: Type.Literal('contract'),
    id: Type.String({ pattern: '^[a-z][a-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+$', maxLength: 160 }),
    version: Type.String({ pattern: '^v[0-9]+$' }),
  },
  { additionalProperties: false, $id: 'catalog.ContractRef.v0' },
);
export type ContractRef = Static<typeof ContractRefSchema>;

/** A JSON Schema document carried as data (tool parameters and results). */
const JsonSchemaDocumentSchema = Type.Record(Type.String(), Type.Unknown());

const UniqueRefs = (options: { readonly minItems: number }) =>
  Type.Array(DefinitionRefSchema, { ...options, uniqueItems: true });

/**
 * Fields shared by every definition. `kind` is a literal per definition type so that the
 * union below is discriminated: checking `definition.kind === 'MODEL'` narrows the TypeScript
 * type to ModelDefinition.
 */
const header = <K extends DefinitionKind>(kind: K) => ({
  schemaVersion: Type.Literal('v0'),
  kind: Type.Literal(kind),
  id: DefinitionIdSchema,
  version: DefinitionVersionTagSchema,
  digest: Sha256HexSchema,
  description: TextSchema(2_000),
});

export const AgentDefinitionSchema = Type.Object(
  {
    ...header('AGENT'),
    role: TextSchema(200),
    modelRef: DefinitionRefSchema,
    promptRef: DefinitionRefSchema,
    /** Closed set of units this agent may request; an agent never names tools directly. */
    unitRefs: UniqueRefs({ minItems: 1 }),
    inputContract: ContractRefSchema,
    outputContract: ContractRefSchema,
  },
  { additionalProperties: false, $id: 'catalog.AgentDefinition.v0' },
);
export type AgentDefinition = DeepReadonly<Static<typeof AgentDefinitionSchema>>;

export const UnitDefinitionSchema = Type.Object(
  {
    ...header('UNIT'),
    /** Routes admission in Kernel; mirrors kernel.unit ExecutionKind. */
    executionKind: Type.Union([
      Type.Literal('CONTEXT'),
      Type.Literal('MODEL'),
      Type.Literal('FILE_READ'),
      Type.Literal('FILE_WRITE'),
      Type.Literal('COMMAND'),
      Type.Literal('TEST'),
    ]),
    operations: Type.Array(Type.String({ pattern: '^[A-Z][A-Z0-9_]*$', maxLength: 64 }), {
      minItems: 1,
      uniqueItems: true,
    }),
    inputContract: ContractRefSchema,
    outputContract: ContractRefSchema,
    requiredCapabilities: Type.Array(TextSchema(160), { uniqueItems: true }),
    /** Closed set of tools that may run inside this unit. */
    toolRefs: UniqueRefs({ minItems: 0 }),
    effect: Type.Union([
      Type.Literal('READ_ONLY'),
      Type.Literal('WORKSPACE_WRITE'),
      Type.Literal('EXTERNAL'),
    ]),
    isIdempotent: Type.Boolean(),
    limits: Type.Object(
      {
        timeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
        maxOutputBytes: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'catalog.UnitDefinition.v0' },
);
export type UnitDefinition = DeepReadonly<Static<typeof UnitDefinitionSchema>>;

export const ToolDefinitionSchema = Type.Object(
  {
    ...header('TOOL'),
    /** Name shown to the model in tool calling; follows the common provider name rules. */
    modelName: Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' }),
    modelDescription: TextSchema(4_000),
    parametersSchema: JsonSchemaDocumentSchema,
    resultSchema: JsonSchemaDocumentSchema,
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
    canDryRun: Type.Boolean(),
    contentStatus: ContentStatusSchema,
  },
  { additionalProperties: false, $id: 'catalog.ToolDefinition.v0' },
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
  { additionalProperties: false, $id: 'catalog.PromptDefinition.v0' },
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
            isEnabledByDefault: Type.Boolean(),
            effortLevels: Type.Array(TextSchema(32), { uniqueItems: true }),
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
            /** Named holiday calendar during which peak pricing does not apply. */
            excludedHolidayCalendar: Type.Optional(Type.Literal('CN_PUBLIC_HOLIDAYS')),
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
  { additionalProperties: false, $id: 'catalog.ModelDefinition.v0' },
);
export type ModelDefinition = DeepReadonly<Static<typeof ModelDefinitionSchema>>;

export const DefinitionSchema = Type.Union(
  [
    AgentDefinitionSchema,
    UnitDefinitionSchema,
    ToolDefinitionSchema,
    ModelDefinitionSchema,
    PromptDefinitionSchema,
  ],
  { $id: 'catalog.Definition.v0' },
);
export type Definition =
  AgentDefinition | UnitDefinition | ToolDefinition | ModelDefinition | PromptDefinition;

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
}

export const DEFINITION_SCHEMAS: { readonly [K in DefinitionKind]: TSchema } = {
  AGENT: AgentDefinitionSchema,
  UNIT: UnitDefinitionSchema,
  TOOL: ToolDefinitionSchema,
  MODEL: ModelDefinitionSchema,
  PROMPT: PromptDefinitionSchema,
};

/**
 * The same shapes without `digest`, as authored in files: v0.x draft versions never store a
 * digest (it is computed at load), and v1+ versions lack one only until `catalog:seal` runs.
 */
export const DEFINITION_DRAFT_SCHEMAS: { readonly [K in DefinitionKind]: TSchema } = {
  AGENT: Type.Omit(AgentDefinitionSchema, ['digest'], { additionalProperties: false }),
  UNIT: Type.Omit(UnitDefinitionSchema, ['digest'], { additionalProperties: false }),
  TOOL: Type.Omit(ToolDefinitionSchema, ['digest'], { additionalProperties: false }),
  MODEL: Type.Omit(ModelDefinitionSchema, ['digest'], { additionalProperties: false }),
  PROMPT: Type.Omit(PromptDefinitionSchema, ['digest'], { additionalProperties: false }),
};
