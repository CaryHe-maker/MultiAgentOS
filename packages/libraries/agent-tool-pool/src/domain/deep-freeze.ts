/**
 * Freezes a JSON-like value and everything inside it, so a published definition cannot be
 * mutated at runtime even by code that casts away `readonly`.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}
