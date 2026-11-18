/**
 * Arguments named in snake_case for a tool whose parameters are camelCase (D57): `old_string` for
 * `oldString`, as models trained on other tools write them. A name is taken over only when its
 * camelCase form is a parameter of the tool and is not given as well; anything else is left for
 * the check of the arguments to refuse, so no tool is offered a parameter it does not have.
 */
const camel = (name: string): string =>
  name.replace(/_([a-z0-9])/gu, (_, letter: string) => letter.toUpperCase());

export function withCamelNames(parameters: unknown, args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const properties = (parameters as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  if (properties === undefined) return args;
  const entries = Object.entries(args as Record<string, unknown>);
  if (!entries.some(([key]) => key.includes('_') && !(key in properties))) return args;
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const other = camel(key);
    const take = key.includes('_') && !(key in properties) && other in properties;
    if (take && other in (args as Record<string, unknown>)) {
      renamed[key] = value;
      continue;
    }
    renamed[take ? other : key] = value;
  }
  return renamed;
}
