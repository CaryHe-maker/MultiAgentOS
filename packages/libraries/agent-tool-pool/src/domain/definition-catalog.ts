import {
  AgentPinRequestSchema,
  CATALOG_ERROR_CODES,
  DefinitionLookupSchema,
  validate,
  type AgentDefinition,
  type AgentPinRequest,
  type BoundaryContext,
  type CapabilityDescriptor,
  type CatalogPort,
  type Definition,
  type DefinitionByKind,
  type DefinitionKind,
  type DefinitionLookup,
  type DefinitionRef,
  type ModelDefinition,
  type ModuleError,
  type PinnedDefinitionRef,
  type PinnedDefinitionSet,
  type PortResult,
  type PromptDefinition,
} from '@multiagentos/contracts';
import type { DefinitionSource } from '../ports/definition-source.js';
import type { CatalogIndex } from './catalog-index.js';
import { deepFreeze } from './deep-freeze.js';
import { definitionKey } from './definition-digest.js';
import { loadCatalogIndex } from './load-catalog-index.js';

const KIND_ORDER: readonly DefinitionKind[] = ['AGENT', 'MODEL', 'PROMPT', 'UNIT', 'TOOL'];

/**
 * CatalogPort over a validated, immutable CatalogIndex. All work that can fail on bad data
 * happened at load time; lookups only fail for unknown or blocked versions.
 */
export class DefinitionCatalog implements CatalogPort {
  /** Loads and validates `source`; throws CatalogLoadError listing every issue. */
  static async load(source: DefinitionSource): Promise<DefinitionCatalog> {
    return new DefinitionCatalog(await loadCatalogIndex(source));
  }

  public constructor(private readonly index: CatalogIndex) {}

  getDefinition<K extends DefinitionKind>(
    lookup: DefinitionLookup & { readonly kind: K },
    context: BoundaryContext,
  ): Promise<PortResult<DefinitionByKind[K]>> {
    const checked = validate<DefinitionLookup>(DefinitionLookupSchema, lookup);
    if (!checked.ok)
      return Promise.resolve(
        failure(
          CATALOG_ERROR_CODES.lookupInvalid,
          'VALIDATION',
          checked.issues.join('; '),
          context,
        ),
      );
    const result = this.#resolve(lookup.kind, lookup, context);
    // The index is keyed by kind, so a hit for kind K is a DefinitionByKind[K]; TypeScript
    // cannot follow that through the Map, hence the cast.
    return Promise.resolve(result as PortResult<DefinitionByKind[K]>);
  }

  pinAgent(
    request: AgentPinRequest,
    context: BoundaryContext,
  ): Promise<PortResult<PinnedDefinitionSet>> {
    const checked = validate<AgentPinRequest>(AgentPinRequestSchema, request);
    if (!checked.ok)
      return Promise.resolve(
        failure(
          CATALOG_ERROR_CODES.lookupInvalid,
          'VALIDATION',
          checked.issues.join('; '),
          context,
        ),
      );
    return Promise.resolve(this.#pin(request, context));
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return Object.freeze([
      {
        capability: 'catalog.definitions',
        status: 'SUPPORTED',
        schemaNames: ['catalog.DefinitionLookup.v0'],
      },
      {
        capability: 'catalog.run-pinning',
        status: 'SUPPORTED',
        schemaNames: ['catalog.AgentPinRequest.v0', 'catalog.PinnedDefinitionSet.v0'],
      },
      {
        capability: 'catalog.publish',
        status: 'UNSUPPORTED',
        schemaNames: [],
        reason: 'M1 publishes by sealing files in the repository; no runtime publishing',
      },
      {
        capability: 'catalog.version-range',
        status: 'UNSUPPORTED',
        schemaNames: ['catalog.DefinitionLookup.v0'],
        reason: 'M1 resolves exact versions only',
      },
    ]);
  }

  #pin(request: AgentPinRequest, context: BoundaryContext): PortResult<PinnedDefinitionSet> {
    const agent = this.#resolve('AGENT', request, context);
    if (!agent.ok) return agent;
    const agentDefinition = agent.value as AgentDefinition;
    const members: Definition[] = [agentDefinition];
    const take = (kind: DefinitionKind, ref: DefinitionRef): ModuleError | undefined => {
      const result = this.#resolve(kind, ref, context);
      if (!result.ok) return result.error;
      if (!members.includes(result.value)) members.push(result.value);
      return undefined;
    };
    const errors = [
      take('MODEL', agentDefinition.modelRef),
      take('PROMPT', agentDefinition.promptRef),
      ...agentDefinition.unitRefs.map((ref) => take('UNIT', ref)),
    ];
    for (const member of [...members])
      if (member.kind === 'UNIT') errors.push(...member.toolRefs.map((ref) => take('TOOL', ref)));
    const { finish, handoff } = agentDefinition.actions;
    errors.push(take('TOOL', finish.toolRef));
    // The handoff target is not a member: its content is pinned separately by the caller.
    let handoffTargetRef: PinnedDefinitionRef | undefined;
    if (handoff !== undefined) {
      errors.push(take('TOOL', handoff.toolRef));
      const target = this.#resolve('AGENT', handoff.targetAgentRef, context);
      if (target.ok) handoffTargetRef = toPinnedRef(target.value);
      else errors.push(target.error);
    }
    const error = errors.find((candidate) => candidate !== undefined);
    // A blocked or missing member makes the whole agent unusable: never pin a partial set.
    if (error !== undefined)
      return failure(
        error.code,
        error.category,
        `cannot pin ${request.id}@${request.version}: ${error.message}`,
        context,
      );
    const ofKind = <K extends DefinitionKind>(kind: K) =>
      sortMembers(members.filter((member) => member.kind === kind)) as DefinitionByKind[K][];
    const pinned: PinnedDefinitionSet = {
      schemaVersion: 'v0',
      agent: agentDefinition,
      model: ofKind('MODEL')[0] as ModelDefinition,
      prompt: ofKind('PROMPT')[0] as PromptDefinition,
      units: ofKind('UNIT'),
      tools: ofKind('TOOL'),
      ...(handoffTargetRef === undefined ? {} : { handoffTargetRef }),
      refs: sortMembers(members).map(toPinnedRef),
    };
    return { ok: true, value: deepFreeze(pinned) };
  }

  #resolve(
    kind: DefinitionKind,
    ref: DefinitionRef,
    context: BoundaryContext,
  ): PortResult<Definition> {
    const key = definitionKey(kind, ref.id, ref.version);
    const definition = this.index.definitions.get(key);
    if (definition === undefined) {
      const versions = [...this.index.definitions.values()]
        .filter((candidate) => candidate.kind === kind && candidate.id === ref.id)
        .map((candidate) => candidate.version)
        .sort();
      return versions.length === 0
        ? failure(
            CATALOG_ERROR_CODES.definitionNotFound,
            'VALIDATION',
            `no ${kind} named ${ref.id}`,
            context,
          )
        : failure(
            CATALOG_ERROR_CODES.versionNotFound,
            'VALIDATION',
            `${kind} ${ref.id} has no version ${ref.version} (available: ${versions.join(', ')})`,
            context,
          );
    }
    const status = this.index.statuses.get(key);
    if (status === 'QUARANTINED' || status === 'REVOKED')
      return failure(
        CATALOG_ERROR_CODES.definitionUnavailable,
        'POLICY',
        `${key} is ${status}`,
        context,
      );
    return { ok: true, value: definition };
  }
}

function sortMembers<T extends Definition>(members: readonly T[]): T[] {
  return [...members].sort(
    (left, right) =>
      KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) ||
      compare(left.id, right.id) ||
      compare(left.version, right.version),
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPinnedRef(definition: Definition): PinnedDefinitionRef {
  return {
    kind: definition.kind,
    id: definition.id,
    version: definition.version,
    digest: definition.digest,
  };
}

function failure(
  code: string,
  category: ModuleError['category'],
  message: string,
  context: BoundaryContext,
): { readonly ok: false; readonly error: ModuleError } {
  return {
    ok: false,
    error: { code, category, message, retryable: false, correlationId: context.correlationId },
  };
}
