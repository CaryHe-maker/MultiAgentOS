/**
 * Problems found while loading or sealing the catalog. Loading collects every issue instead of
 * stopping at the first, so one run of `pnpm run check` shows everything that is wrong.
 */
export const CATALOG_ISSUE_CODES = [
  /** File could not be read or decoded (I/O, YAML/JSON syntax, symlink, size). */
  'SOURCE_UNREADABLE',
  /** File is in a place the layout does not allow, or its path disagrees with its content. */
  'SOURCE_LOCATION_INVALID',
  /** Content does not match the definition schema. */
  'DEFINITION_INVALID',
  /** Published (v1+) definition without a digest; run `pnpm run catalog:seal`. */
  'DEFINITION_UNSEALED',
  /** Declared digest differs from the content: a published definition was edited. */
  'DIGEST_MISMATCH',
  /** The same kind, id and version appears twice. */
  'DEFINITION_DUPLICATE',
  /** A reference points to a definition that does not exist. */
  'REFERENCE_MISSING',
  /** A reference points to a definition that itself has issues. */
  'REFERENCE_INVALID',
  /** A published (v1+) definition references a v0.x draft that may still change. */
  'REFERENCE_UNSTABLE',
  /** Prompt template slots and declared variables differ. */
  'PROMPT_VARIABLES_MISMATCH',
  /** A unit's declared effect is weaker than the side effects of its tools. */
  'EFFECT_MISMATCH',
  /** Two tools reachable from one agent share a model-facing name. */
  'TOOL_NAME_CONFLICT',
  /** An agent's model settings are missing or not supported by its model. */
  'MODEL_SETTINGS_INVALID',
  /** An agent breaks a rule on its units, start units, control tools or limits. */
  'AGENT_INVALID',
  /** A unit breaks a rule on its contracts, protected capabilities, tool or failurePolicy. */
  'UNIT_INVALID',
  /** A tool is used against its purpose, or a UNIT tool is not owned by exactly one unit. */
  'TOOL_INVALID',
  /** A ContractRef names a Schema that is not in the Protocol Registry. */
  'CONTRACT_UNKNOWN',
  /** `status.yaml` is invalid or names a definition that does not exist. */
  'STATUS_INVALID',
] as const;
export type CatalogIssueCode = (typeof CATALOG_ISSUE_CODES)[number];

export interface CatalogIssue {
  readonly origin: string;
  readonly code: CatalogIssueCode;
  readonly message: string;
}

/** Thrown once at startup when the catalog cannot be built; carries every issue found. */
export class CatalogLoadError extends Error {
  public readonly issues: readonly CatalogIssue[];
  public constructor(issues: readonly CatalogIssue[]) {
    super(
      `AgentToolPool catalog has ${issues.length} issue(s):\n` +
        issues.map((issue) => `  [${issue.code}] ${issue.origin}: ${issue.message}`).join('\n'),
    );
    this.name = 'CatalogLoadError';
    this.issues = issues;
  }
}
