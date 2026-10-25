import { readFile, writeFile } from 'node:fs/promises';
import type { ProtocolRegistry } from '../protocol-registry.js';

/**
 * The protocol freeze guard of the compatibility matrix (M1TechStack 11). Before M1 is accepted
 * (`frozen: false`) the registered Schemas must equal the snapshot; afterwards every frozen
 * Schema must stay registered and may only gain optional fields (M1Interface 1.2).
 */
export interface SchemaSnapshot {
  readonly frozen: boolean;
  /** JSON documents of the registered Schemas, keyed by Schema ID and sorted. */
  readonly schemas: Readonly<Record<string, unknown>>;
}

/** Resolves from `src/compatibility` and from `dist/compatibility` alike. */
export const SCHEMA_SNAPSHOT_URL = new URL(
  '../../test/compatibility/schema-snapshot.json',
  import.meta.url,
);

/** A plain JSON copy without TypeBox's own `~` keys. */
function jsonDocument(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonDocument);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !key.startsWith('~') && child !== undefined)
      .map(([key, child]) => [key, jsonDocument(child)]),
  );
}

export function currentSchemas(registry: ProtocolRegistry): Record<string, unknown> {
  const entries = registry
    .list()
    .map((entry) => [entry.schemaId, jsonDocument(entry.schema)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries);
}

export async function readSchemaSnapshot(): Promise<SchemaSnapshot> {
  return JSON.parse(await readFile(SCHEMA_SNAPSHOT_URL, 'utf8')) as SchemaSnapshot;
}

export async function writeSchemaSnapshot(snapshot: SchemaSnapshot): Promise<void> {
  await writeFile(SCHEMA_SNAPSHOT_URL, JSON.stringify(snapshot, null, 2) + '\n');
}

type JsonObject = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isObjectSchema = (value: unknown): value is JsonObject & { properties: JsonObject } =>
  isObject(value) && isObject(value['properties']);
const requiredOf = (schema: JsonObject): ReadonlySet<string> =>
  new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []);

/**
 * Where `current` is not a compatible change of `frozen`: anything but an added optional
 * property of an object Schema is reported, with the JSON path of the difference.
 */
export function compatibilityIssues(frozen: unknown, current: unknown, path = ''): string[] {
  if (isObjectSchema(frozen) && isObjectSchema(current)) {
    const issues: string[] = [];
    const frozenRequired = requiredOf(frozen);
    const currentRequired = requiredOf(current);
    for (const [key, child] of Object.entries(frozen.properties)) {
      if (!(key in current.properties)) issues.push(`${path}/properties/${key}: removed`);
      else {
        if (frozenRequired.has(key) !== currentRequired.has(key))
          issues.push(`${path}/properties/${key}: required changed`);
        issues.push(
          ...compatibilityIssues(child, current.properties[key], `${path}/properties/${key}`),
        );
      }
    }
    for (const key of Object.keys(current.properties))
      if (!(key in frozen.properties) && currentRequired.has(key))
        issues.push(`${path}/properties/${key}: added as required`);
    const rest = (schema: JsonObject) =>
      Object.fromEntries(
        Object.entries(schema).filter(([key]) => key !== 'properties' && key !== 'required'),
      );
    return [...issues, ...compatibilityIssues(rest(frozen), rest(current), path)];
  }
  if (Array.isArray(frozen) && Array.isArray(current)) {
    if (frozen.length !== current.length) return [`${path}: length changed`];
    return frozen.flatMap((child, index) =>
      compatibilityIssues(child, current[index], `${path}/${index}`),
    );
  }
  if (isObject(frozen) && isObject(current)) {
    const keys = new Set([...Object.keys(frozen), ...Object.keys(current)]);
    return [...keys].flatMap((key) =>
      key in frozen && key in current
        ? compatibilityIssues(frozen[key], current[key], `${path}/${key}`)
        : [`${path}/${key}: ${key in frozen ? 'removed' : 'added'}`],
    );
  }
  return Object.is(frozen, current) ? [] : [`${path}: changed`];
}

/** Everything the freeze guard reports for the registered Schemas against a snapshot. */
export function snapshotIssues(snapshot: SchemaSnapshot, registry: ProtocolRegistry): string[] {
  const current = currentSchemas(registry);
  if (!snapshot.frozen) {
    const ids = new Set([...Object.keys(snapshot.schemas), ...Object.keys(current)]);
    return [...ids].flatMap((id) =>
      !(id in current)
        ? [`${id}: no longer registered`]
        : !(id in snapshot.schemas)
          ? [`${id}: not in the snapshot`]
          : JSON.stringify(snapshot.schemas[id]) !== JSON.stringify(current[id])
            ? [`${id}: differs from the snapshot; run pnpm run contracts:snapshot`]
            : [],
    );
  }
  return Object.entries(snapshot.schemas).flatMap(([id, frozen]) =>
    id in current
      ? compatibilityIssues(frozen, current[id]).map((issue) => `${id}${issue}`)
      : [`${id}: frozen but no longer registered`],
  );
}
