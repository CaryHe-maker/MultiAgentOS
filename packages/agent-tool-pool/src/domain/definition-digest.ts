import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type Definition,
  type DefinitionByKind,
  type DefinitionKind,
  type DefinitionRef,
} from '@multiagentos/contracts';

/**
 * A definition before its digest is known. The mapped type below builds
 * `Omit<AgentDefinition, 'digest'> | Omit<UnitDefinition, 'digest'> | ...`; writing
 * `Omit<Definition, 'digest'>` instead would merge the union and lose the `kind` narrowing.
 */
export type DefinitionBody = {
  [K in DefinitionKind]: Omit<DefinitionByKind[K], 'digest'>;
}[DefinitionKind];

/** One outgoing reference of a definition, with the kind it must point to. */
export interface OutgoingReference {
  readonly field: string;
  readonly kind: DefinitionKind;
  readonly ref: DefinitionRef;
}

/** Lists references in a fixed order. This is the only place that knows where refs live. */
export function outgoingReferences(body: DefinitionBody): readonly OutgoingReference[] {
  switch (body.kind) {
    case 'AGENT':
      return [
        { field: 'modelRef', kind: 'MODEL', ref: body.modelRef },
        { field: 'promptRef', kind: 'PROMPT', ref: body.promptRef },
        ...body.unitRefs.map((ref, index) => ({
          field: `unitRefs[${index}]`,
          kind: 'UNIT' as const,
          ref,
        })),
      ];
    case 'UNIT':
      return body.toolRefs.map((ref, index) => ({
        field: `toolRefs[${index}]`,
        kind: 'TOOL' as const,
        ref,
      }));
    default:
      return [];
  }
}

export function definitionKey(kind: DefinitionKind, id: string, version: string): string {
  return `${kind}:${id}@${version}`;
}

/** Returns the digest of an already published target, or undefined when it is unknown. */
export type ReferenceDigestResolver = (
  kind: DefinitionKind,
  ref: DefinitionRef,
) => string | undefined;

/**
 * SHA-256 over the canonical JSON of the definition without `digest`, where each reference
 * is replaced by `{ id, version, digest }` of its target. Because a reference contributes its
 * target's digest, changing a tool changes the digest of every unit and agent above it.
 *
 * Returns undefined if any reference cannot be resolved.
 */
export function computeDefinitionDigest(
  definition: DefinitionBody | Definition,
  resolveReference: ReferenceDigestResolver,
): string | undefined {
  const body = withoutDigest(definition);
  const digests = new Map<string, string>();
  for (const { kind, ref } of outgoingReferences(body)) {
    const digest = resolveReference(kind, ref);
    if (digest === undefined) return undefined;
    digests.set(definitionKey(kind, ref.id, ref.version), digest);
  }
  // Every reference was resolved above, so the lookup below cannot miss.
  const pin = (kind: DefinitionKind, ref: DefinitionRef) => ({
    id: ref.id,
    version: ref.version,
    digest: digests.get(definitionKey(kind, ref.id, ref.version)) ?? '',
  });
  const expanded = expandReferences(body, pin);
  return createHash('sha256').update(canonicalJson(expanded), 'utf8').digest('hex');
}

function expandReferences(
  body: DefinitionBody,
  pin: (kind: DefinitionKind, ref: DefinitionRef) => object,
): object {
  switch (body.kind) {
    case 'AGENT':
      return {
        ...body,
        modelRef: pin('MODEL', body.modelRef),
        promptRef: pin('PROMPT', body.promptRef),
        unitRefs: body.unitRefs.map((ref) => pin('UNIT', ref)),
      };
    case 'UNIT':
      return { ...body, toolRefs: body.toolRefs.map((ref) => pin('TOOL', ref)) };
    default:
      return body;
  }
}

function withoutDigest(definition: DefinitionBody | Definition): DefinitionBody {
  // The input is already schema-valid, so `digest` is the only field this removes.
  return Object.fromEntries(
    Object.entries(definition).filter(([key]) => key !== 'digest'),
  ) as DefinitionBody;
}
