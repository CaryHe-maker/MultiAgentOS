import type {
  AgentPinRequest,
  BoundaryContext,
  CatalogPort,
  DefinitionByKind,
  DefinitionKind,
  PinnedDefinitionSet,
  PortResult,
} from '@multiagentos/contracts';

/** Returns fixed sets without reading a catalog or reimplementing pinning rules. */
export class FixedCatalog implements CatalogPort {
  readonly requests: AgentPinRequest[] = [];
  readonly replies: PortResult<PinnedDefinitionSet>[] = [];

  constructor(readonly sets: readonly PinnedDefinitionSet[]) {}

  pinAgent(
    request: AgentPinRequest,
    context: BoundaryContext,
  ): Promise<PortResult<PinnedDefinitionSet>> {
    this.requests.push(structuredClone(request));
    const scripted = this.replies.shift();
    if (scripted !== undefined) return Promise.resolve(scripted);
    const value = this.sets.find(
      ({ agent }) => agent.id === request.id && agent.version === request.version,
    );
    return Promise.resolve(
      value === undefined
        ? {
            ok: false,
            error: {
              code: 'CATALOG_DEFINITION_NOT_FOUND',
              category: 'VALIDATION',
              message: 'Definition not found in the test catalog',
              retryable: false,
              correlationId: context.correlationId,
            },
          }
        : { ok: true, value },
    );
  }

  getDefinition<K extends DefinitionKind>(): Promise<PortResult<DefinitionByKind[K]>> {
    return Promise.reject(
      new Error('Workflow tests must not query definitions outside pinned sets'),
    );
  }

  capabilities(): ReturnType<CatalogPort['capabilities']> {
    return [];
  }
}
