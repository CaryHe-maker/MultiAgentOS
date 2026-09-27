import type { CatalogIssue } from '../domain/catalog-issue.js';

/** One authored document, already decoded from its storage format. */
export interface SourceDocument {
  /** Stable, human-readable location used in issues, e.g. `models/deepseek-flash/v1.0.0.yaml`. */
  readonly origin: string;
  readonly content: unknown;
}

/** Everything a source holds at one moment. Problems found while reading are issues, not throws. */
export interface SourceSnapshot {
  readonly documents: readonly SourceDocument[];
  /** Optional status overrides (`status.yaml`); absent means every version is ACTIVE. */
  readonly statusDocument?: SourceDocument;
  readonly issues: readonly CatalogIssue[];
}

/** Digest the seal step decided to write into a draft document. */
export interface SealPatch {
  readonly origin: string;
  readonly digest: string;
}

/**
 * Where definitions come from. The file adapter reads the repository; the in-memory adapter
 * serves tests. Sources only read and decode; all rules live in the domain.
 */
export interface DefinitionSource {
  load(): Promise<SourceSnapshot>;
}

/** A source whose drafts can be sealed in place (only the file adapter in M1). */
export interface SealableDefinitionSource extends DefinitionSource {
  writeDigests(patches: readonly SealPatch[]): Promise<void>;
}
