/**
 * A call with a parameter the tool does not have is refused by the schema in its own words
 * ("/run_in_background schema is false"), which do not say what to write instead. This names each
 * unknown parameter, the one the model most likely meant, and the parameters the tool takes, so
 * the next call is right (seen in a real run: run_in_background for runInBackground).
 */

/** Case, underscores and dashes aside: run_in_background and runInBackground are one name. */
const squash = (name: string): string => name.toLowerCase().replace(/[_-]/gu, '');

/** The edits that turn one word into the other (Levenshtein). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0;
      row[j] = Math.min(
        above + 1,
        (row[j - 1] ?? 0) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

/** The known name the unknown one stands for: the same when squashed, or one or two edits off. */
function closest(unknown: string, known: readonly string[]): string | undefined {
  const wanted = squash(unknown);
  const same = known.find((name) => squash(name) === wanted);
  if (same !== undefined) return same;
  let best: { readonly name: string; readonly edits: number } | undefined;
  for (const name of known) {
    const edits = distance(wanted, squash(name));
    if (edits <= 2 && (best === undefined || edits < best.edits)) best = { name, edits };
  }
  return best?.name;
}

/** What to say of the parameters a call gave that its tool does not have; none when all are known. */
export function unknownParameterHint(parameters: unknown, args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const properties = (parameters as { readonly properties?: unknown } | null)?.properties;
  if (properties === null || typeof properties !== 'object') return undefined;
  const known = Object.keys(properties);
  const notes = Object.keys(args)
    .filter((key) => !known.includes(key))
    .map((key) => {
      const meant = closest(key, known);
      return meant === undefined
        ? `${key} is not a parameter of this tool`
        : `${key} is not a parameter of this tool; did you mean ${meant}?`;
    });
  if (notes.length === 0) return undefined;
  return `${notes.join('; ')}. Its parameters are: ${known.join(', ')}.`;
}
