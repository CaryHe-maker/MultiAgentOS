/**
 * Deterministic JSON encoding used wherever a payload is hashed or compared.
 *
 * Rules (SharedContracts §7):
 * - object keys are sorted by UTF-16 code unit order (the default `Array.prototype.sort`);
 * - no insignificant whitespace; strings use `JSON.stringify` escaping;
 * - only JSON values are accepted: `undefined`, functions, symbols, bigint, `NaN` and
 *   `Infinity` are rejected instead of being silently dropped or turned into `null`;
 * - `-0` is encoded as `0`, because JSON cannot distinguish them.
 *
 * Callers normally hash the result as UTF-8 bytes.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, '$');
}

export class CanonicalJsonError extends Error {
  public readonly path: string;
  public constructor(path: string, reason: string) {
    super(`Value at ${path} is not canonical JSON: ${reason}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(path, 'non-finite number');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object':
      return Array.isArray(value) ? encodeArray(value, path) : encodeObject(value, path);
    default:
      throw new CanonicalJsonError(path, `unsupported type ${typeof value}`);
  }
}

function encodeArray(items: readonly unknown[], path: string): string {
  return `[${items.map((item, index) => encode(item, `${path}[${index}]`)).join(',')}]`;
}

function encodeObject(value: object, path: string): string {
  const prototype = Object.getPrototypeOf(value) as unknown;
  // Class instances (Date, Map, ...) have no single JSON meaning, so they must be converted
  // by the caller before hashing.
  if (prototype !== Object.prototype && prototype !== null)
    throw new CanonicalJsonError(path, 'only plain objects are allowed');
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const members = entries.map(
    ([key, member]) => `${JSON.stringify(key)}:${encode(member, `${path}.${key}`)}`,
  );
  return `{${members.join(',')}}`;
}
