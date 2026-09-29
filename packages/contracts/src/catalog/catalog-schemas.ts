import { Type, type Static } from 'typebox';
import {
  AgentDefinitionSchema,
  type DeepReadonly,
  DefinitionIdSchema,
  DefinitionKindSchema,
  DefinitionStatusSchema,
  DefinitionVersionTagSchema,
  ModelDefinitionSchema,
  PinnedDefinitionRefSchema,
  PromptDefinitionSchema,
  ToolDefinitionSchema,
  UnitDefinitionSchema,
} from './definition-schemas.js';

/** Exact lookup of one definition version. */
export const DefinitionLookupSchema = Type.Object(
  { kind: DefinitionKindSchema, id: DefinitionIdSchema, version: DefinitionVersionTagSchema },
  { additionalProperties: false, $id: 'catalog.DefinitionLookup.v0' },
);
export type DefinitionLookup = Static<typeof DefinitionLookupSchema>;

/** Request to pin one agent version and its whole reference closure for a run. */
export const AgentPinRequestSchema = Type.Object(
  { id: DefinitionIdSchema, version: DefinitionVersionTagSchema },
  { additionalProperties: false, $id: 'catalog.AgentPinRequest.v0' },
);
export type AgentPinRequest = Static<typeof AgentPinRequestSchema>;

/**
 * Everything a run needs from the catalog, captured once when the run starts. The run reads
 * prompts, tool schemas and model parameters from this value only, so later catalog changes
 * can never switch versions under a running agent. `refs` lists every member (sorted by kind,
 * id, version) and is what projections and audit records carry.
 */
export const PinnedDefinitionSetSchema = Type.Object(
  {
    schemaVersion: Type.Literal('v0'),
    agent: AgentDefinitionSchema,
    model: ModelDefinitionSchema,
    prompt: PromptDefinitionSchema,
    units: Type.Array(UnitDefinitionSchema, { minItems: 1 }),
    tools: Type.Array(ToolDefinitionSchema),
    refs: Type.Array(PinnedDefinitionRefSchema, { minItems: 3 }),
  },
  { additionalProperties: false, $id: 'catalog.PinnedDefinitionSet.v0' },
);
export type PinnedDefinitionSet = DeepReadonly<Static<typeof PinnedDefinitionSetSchema>>;

/**
 * `definitions/status.yaml`: the only mutable part of the catalog. Definition content never
 * changes; a risk found later is handled by listing the version here. Unlisted versions are
 * ACTIVE. QUARANTINED and REVOKED versions cannot be looked up or pinned.
 */
export const DefinitionStatusFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal('v0'),
    entries: Type.Array(
      Type.Object(
        {
          kind: DefinitionKindSchema,
          id: DefinitionIdSchema,
          version: DefinitionVersionTagSchema,
          status: DefinitionStatusSchema,
          reason: Type.String({ minLength: 1, maxLength: 1_000 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, $id: 'catalog.DefinitionStatusFile.v0' },
);
export type DefinitionStatusFile = DeepReadonly<Static<typeof DefinitionStatusFileSchema>>;

/**
 * Stable error codes returned in ModuleError.code by CatalogPort. Callers branch on these
 * codes, never on messages.
 */
export const CATALOG_ERROR_CODES = {
  /** The lookup itself failed schema validation. */
  lookupInvalid: 'CATALOG_LOOKUP_INVALID',
  /** No definition with this kind and id exists. */
  definitionNotFound: 'CATALOG_DEFINITION_NOT_FOUND',
  /** The id exists, but not in the requested version. */
  versionNotFound: 'CATALOG_VERSION_NOT_FOUND',
  /** The version exists but is QUARANTINED or REVOKED and must not be used. */
  definitionUnavailable: 'CATALOG_DEFINITION_UNAVAILABLE',
} as const;
export type CatalogErrorCode = (typeof CATALOG_ERROR_CODES)[keyof typeof CATALOG_ERROR_CODES];
