import type { DefinitionSource, SourceSnapshot } from '../../ports/definition-source.js';

/**
 * A catalog with some of its files replaced (Orchestration D81): every document of the overlay
 * takes the place of the base document at the same path, and the rest of the base stays as it is.
 * A comparison arm is written as whole files beside the catalog, never as edits made at run time,
 * so what its agents see can be read before it runs and is pinned like any other definition.
 */
export class OverlayDefinitionSource implements DefinitionSource {
  public constructor(
    private readonly base: DefinitionSource,
    private readonly overlay: DefinitionSource,
  ) {}

  async load(): Promise<SourceSnapshot> {
    const [base, overlay] = await Promise.all([this.base.load(), this.overlay.load()]);
    const replaced = new Set(overlay.documents.map((document) => document.origin));
    const documents = [
      ...base.documents.filter((document) => !replaced.has(document.origin)),
      ...overlay.documents,
    ];
    const issues = [...base.issues, ...overlay.issues];
    return base.statusDocument === undefined
      ? { documents, issues }
      : { documents, statusDocument: base.statusDocument, issues };
  }
}
