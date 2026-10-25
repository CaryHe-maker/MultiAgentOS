import type { DefinitionSource } from '../ports/definition-source.js';
import { CatalogLoadError } from './catalog-issue.js';
import { buildCatalogIndex, type CatalogIndex } from './catalog-index.js';

/** Startup entry point: read the source, validate everything, or throw with every issue. */
export async function loadCatalogIndex(source: DefinitionSource): Promise<CatalogIndex> {
  const result = buildCatalogIndex(await source.load());
  if (!result.ok) throw new CatalogLoadError(result.issues);
  return result.index;
}
