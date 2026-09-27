/**
 * AgentToolPool: immutable, versioned Agent / Unit / Tool / Model / Prompt definitions.
 * Composition roots call `DefinitionCatalog.load(new FileDefinitionSource(dir))` once at
 * startup and hand the result to consumers as a CatalogPort.
 */
export { DefinitionCatalog } from './domain/definition-catalog.js';
export { FileDefinitionSource } from './adapters/file/file-definition-source.js';
export { InMemoryDefinitionSource } from './adapters/memory/in-memory-definition-source.js';
export {
  CATALOG_ISSUE_CODES,
  CatalogLoadError,
  type CatalogIssue,
  type CatalogIssueCode,
} from './domain/catalog-issue.js';
export {
  buildCatalogIndex,
  planSeal,
  type CatalogBuildResult,
  type CatalogIndex,
  type SealPlan,
} from './domain/catalog-index.js';
export { computeDefinitionDigest, definitionKey } from './domain/definition-digest.js';
export { loadCatalogIndex } from './domain/load-catalog-index.js';
export { DEFAULT_DEFINITIONS_DIRECTORY } from './definitions-directory.js';
export type {
  DefinitionSource,
  SealPatch,
  SealableDefinitionSource,
  SourceDocument,
  SourceSnapshot,
} from './ports/definition-source.js';
