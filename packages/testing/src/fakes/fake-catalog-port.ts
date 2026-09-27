import {
  CATALOG_ERROR_CODES,
  type AgentPinRequest,
  type BoundaryContext,
  type CapabilityDescriptor,
  type CatalogPort,
  type Definition,
  type DefinitionByKind,
  type DefinitionKind,
  type DefinitionLookup,
  type ModuleError,
  type PinnedDefinitionSet,
  type PortResult,
} from '@multiagentos/contracts';

const KIND_ORDER: readonly DefinitionKind[] = ['AGENT', 'MODEL', 'PROMPT', 'UNIT', 'TOOL'];
const LOOKUP_PATTERN = {
  id: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u,
  version: /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u,
};

/**
 * Hand-written CatalogPort for other modules' tests: give it definitions (for example the
 * shipped catalog, JSON round-tripped), optionally block some, and it answers like the real
 * catalog without files, schema compilation or digest checks. It is deliberately independent
 * of agent-tool-pool internals; the shared contract suite keeps the two in step.
 */
export class FakeCatalogPort implements CatalogPort {
  readonly #definitions: readonly Definition[];
  readonly #blocked: ReadonlySet<string>;
  readonly lookups: DefinitionLookup[] = [];

  public constructor(
    definitions: readonly Definition[],
    blocked: readonly DefinitionLookup[] = [],
  ) {
    this.#definitions = freeze(structuredClone(definitions));
    this.#blocked = new Set(blocked.map((lookup) => key(lookup.kind, lookup.id, lookup.version)));
  }

  getDefinition<K extends DefinitionKind>(
    lookup: DefinitionLookup & { readonly kind: K },
    context: BoundaryContext,
  ): Promise<PortResult<DefinitionByKind[K]>> {
    this.lookups.push(lookup);
    return Promise.resolve(this.#find(lookup, context) as PortResult<DefinitionByKind[K]>);
  }

  pinAgent(
    request: AgentPinRequest,
    context: BoundaryContext,
  ): Promise<PortResult<PinnedDefinitionSet>> {
    const agent = this.#find({ kind: 'AGENT', ...request }, context);
    if (!agent.ok) return Promise.resolve(agent);
    if (agent.value.kind !== 'AGENT') throw new Error('unreachable: kind was checked');
    const members = new Map<string, Definition>([[refKey(agent.value), agent.value]]);
    const lookups: DefinitionLookup[] = [
      { kind: 'MODEL', ...agent.value.modelRef },
      { kind: 'PROMPT', ...agent.value.promptRef },
      ...agent.value.unitRefs.map((ref) => ({ kind: 'UNIT' as const, ...ref })),
    ];
    for (let index = 0; index < lookups.length; index += 1) {
      const lookup = lookups[index];
      if (lookup === undefined) continue;
      const member = this.#find(lookup, context);
      if (!member.ok)
        return Promise.resolve(
          error(
            member.error.code,
            member.error.category,
            `cannot pin: ${member.error.message}`,
            context,
          ),
        );
      members.set(refKey(member.value), member.value);
      if (member.value.kind === 'UNIT')
        lookups.push(...member.value.toolRefs.map((ref) => ({ kind: 'TOOL' as const, ...ref })));
    }
    const sorted = [...members.values()].sort(
      (left, right) =>
        KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) ||
        compare(left.id, right.id) ||
        compare(left.version, right.version),
    );
    const only = <K extends DefinitionKind>(kind: K) =>
      sorted.filter((member) => member.kind === kind) as DefinitionByKind[K][];
    const [model] = only('MODEL');
    const [prompt] = only('PROMPT');
    if (model === undefined || prompt === undefined) throw new Error('unreachable: refs resolved');
    const pinned: PinnedDefinitionSet = {
      schemaVersion: 'v0',
      agent: agent.value,
      model,
      prompt,
      units: only('UNIT'),
      tools: only('TOOL'),
      refs: sorted.map(({ kind, id, version, digest }) => ({ kind, id, version, digest })),
    };
    return Promise.resolve({ ok: true, value: freeze(pinned) });
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
    ]);
  }

  #find(lookup: DefinitionLookup, context: BoundaryContext): PortResult<Definition> {
    if (!LOOKUP_PATTERN.id.test(lookup.id) || !LOOKUP_PATTERN.version.test(lookup.version))
      return error(CATALOG_ERROR_CODES.lookupInvalid, 'VALIDATION', 'invalid lookup', context);
    const sameId = this.#definitions.filter(
      (definition) => definition.kind === lookup.kind && definition.id === lookup.id,
    );
    const found = sameId.find((definition) => definition.version === lookup.version);
    if (found === undefined)
      return sameId.length === 0
        ? error(CATALOG_ERROR_CODES.definitionNotFound, 'VALIDATION', `no ${lookup.id}`, context)
        : error(CATALOG_ERROR_CODES.versionNotFound, 'VALIDATION', `no ${lookup.version}`, context);
    if (this.#blocked.has(key(lookup.kind, lookup.id, lookup.version)))
      return error(CATALOG_ERROR_CODES.definitionUnavailable, 'POLICY', 'blocked', context);
    return { ok: true, value: found };
  }
}

function key(kind: DefinitionKind, id: string, version: string): string {
  return `${kind}:${id}@${version}`;
}

/** UTF-16 code unit order, the same order the real catalog uses. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function refKey(definition: Definition): string {
  return key(definition.kind, definition.id, definition.version);
}

function error(
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

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) freeze(member);
  }
  return value;
}
