import type {
  DefinitionSource,
  SourceDocument,
  SourceSnapshot,
} from '../../ports/definition-source.js';

/**
 * Serves definitions held in memory, for tests and embedding. Contents are deep-copied on
 * every load, so the caller's objects are never frozen or shared with the catalog.
 */
export class InMemoryDefinitionSource implements DefinitionSource {
  readonly #documents: readonly SourceDocument[];
  readonly #statusDocument: SourceDocument | undefined;

  public constructor(documents: readonly SourceDocument[], statusDocument?: SourceDocument) {
    this.#documents = structuredClone(documents);
    this.#statusDocument = structuredClone(statusDocument);
  }

  load(): Promise<SourceSnapshot> {
    const documents = structuredClone(this.#documents);
    const statusDocument = structuredClone(this.#statusDocument);
    return Promise.resolve(
      statusDocument === undefined
        ? { documents, issues: [] }
        : { documents, statusDocument, issues: [] },
    );
  }
}
