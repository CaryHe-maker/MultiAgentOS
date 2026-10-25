import { Type, type Static } from 'typebox';
import { closed, text } from './schema-helpers.js';

const VersionSchema = Type.String({ pattern: '^v[0-9]+(?:\\.[0-9]+){0,2}$' });

export const VersionedRefSchema = closed(
  { kind: text(128), id: text(160), version: VersionSchema },
  'platform.common.VersionedRef.v0',
);
export type VersionedRef = Static<typeof VersionedRefSchema>;
export type OpaqueRef<K extends string> = VersionedRef & { readonly kind: K };

/**
 * Reference of an unsupported protocol family (SharedContracts 3.9): the family owns the name
 * and the reference shape, but no payload is frozen before a milestone uses it.
 */
export const OpaqueRefSchema = <K extends string>(kind: K, schemaId: string) =>
  closed({ kind: Type.Literal(kind), id: text(160), version: VersionSchema }, schemaId);
