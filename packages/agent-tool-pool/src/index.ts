import { createHash } from 'node:crypto';
import type {
  BoundaryContext,
  CatalogPort,
  CapabilityDescriptor,
  DefinitionQuery,
  DefinitionVersion,
  PortResult,
  VersionedRef,
} from '@multiagentos/contracts';
import { unsupported } from '@multiagentos/contracts';

interface SeedDefinition {
  readonly kind: DefinitionQuery['kind'];
  readonly id: string;
  readonly version: string;
  readonly input: VersionedRef;
  readonly output: VersionedRef;
  readonly capabilities: readonly string[];
}
const seed: readonly SeedDefinition[] = [
  {
    kind: 'AGENT',
    id: 'repository-analysis-agent',
    version: 'v0.1.0',
    input: { kind: 'contract', id: 'context.ContextPack', version: 'v0' },
    output: { kind: 'contract', id: 'workflow.AnalysisAction', version: 'v0' },
    capabilities: ['single-task', 'read-only-analysis', 'structured-actions'],
  },
  {
    kind: 'MODEL',
    id: 'default-model',
    version: 'v0.1.0',
    input: { kind: 'contract', id: 'kernel.ModelRequest', version: 'v0' },
    output: { kind: 'contract', id: 'workflow.AnalysisAction', version: 'v0' },
    capabilities: ['structured-output'],
  },
  {
    kind: 'TOOL',
    id: 'repository-read-tools',
    version: 'v0.1.0',
    input: { kind: 'contract', id: 'kernel.unit.UnitIntent', version: 'v0' },
    output: { kind: 'contract', id: 'kernel.unit.UnitResult', version: 'v0' },
    capabilities: ['repository-tree', 'text-search', 'file-read'],
  },
  {
    kind: 'PROMPT',
    id: 'repository-analysis-prompt',
    version: 'v0.1.0',
    input: { kind: 'contract', id: 'context.ContextPack', version: 'v0' },
    output: { kind: 'contract', id: 'workflow.AnalysisAction', version: 'v0' },
    capabilities: ['read-only-analysis', 'source-citations'],
  },
  {
    kind: 'CONTRACT',
    id: 'analysis-action',
    version: 'v0.1.0',
    input: { kind: 'contract', id: 'workflow.AnalysisAction', version: 'v0' },
    output: { kind: 'contract', id: 'workflow.AnalysisAction', version: 'v0' },
    capabilities: ['schema-validation'],
  },
];
const materialize = (definition: SeedDefinition): DefinitionVersion =>
  Object.freeze({
    ref: { kind: definition.kind.toLowerCase(), id: definition.id, version: definition.version },
    digest: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    inputContractRef: definition.input,
    outputContractRef: definition.output,
    capabilities: [...definition.capabilities],
  });

export class BuiltInCatalog implements CatalogPort {
  readonly #definitions = seed.map(materialize);
  resolve(
    query: DefinitionQuery,
    context: BoundaryContext,
  ): Promise<PortResult<DefinitionVersion>> {
    const definition = this.#definitions.find(
      (item) =>
        item.ref.kind === query.kind.toLowerCase() &&
        item.ref.id === query.definitionId &&
        query.requiredCapabilities.every((capability) => item.capabilities.includes(capability)),
    );
    if (!definition)
      return Promise.resolve({
        ok: false,
        error: unsupported(
          `catalog.resolve.${query.kind}.${query.definitionId}`,
          'catalog.DefinitionQuery.v0',
          context.correlationId,
        ),
      });
    return Promise.resolve({ ok: true, value: definition });
  }
  capabilities(): readonly CapabilityDescriptor[] {
    return Object.freeze([
      {
        capability: 'catalog.builtin-readonly',
        status: 'SUPPORTED',
        schemaNames: ['catalog.DefinitionQuery.v0'],
      },
      {
        capability: 'catalog.publish',
        status: 'UNSUPPORTED',
        schemaNames: ['catalog.Boundary'],
        reason: 'M2+',
      },
    ]);
  }
}
