/**
 * AgentToolPool: immutable, versioned Agent / Unit / Tool / Model / Prompt / Template definitions.
 * The composition root calls `DefinitionCatalog.load(new FileDefinitionSource(dir))` once at
 * startup; Core pins Agents through it and Workflow takes its built-ins from it.
 */
export { FileDefinitionSource } from './adapters/file/file-definition-source.js';
export { InMemoryDefinitionSource } from './adapters/memory/in-memory-definition-source.js';
export {
  CATALOG_ISSUE_CODES,
  CatalogLoadError,
  type CatalogIssue,
  type CatalogIssueCode,
} from './domain/catalog-issue.js';
export { isPeakTime, modelCallCost, type CallCost } from './domain/model-cost.js';
export { DEFAULT_DEFINITIONS_DIRECTORY } from './definitions-directory.js';
export type {
  DefinitionSource,
  SealPatch,
  SealableDefinitionSource,
  SourceDocument,
  SourceSnapshot,
} from './ports/definition-source.js';
export {
  DefinitionCatalog,
  buildCatalogIndex,
  planSeal,
  type CatalogIndex,
  type SealPlan,
} from './catalog/catalog.js';
