/**
 * The matching of `file-edit` (ExecutorSet 5b): pure, and blind to where the text comes from.
 * The model sees files with LF (FILE_READ returns LF), so matching happens on an LF view and the
 * result is cut back into the original text, leaving every line ending it did not touch alone.
 */

export interface EditRequest {
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}

export type EditMatch =
  | { readonly ok: true; readonly content: string; readonly replacements: number }
  | { readonly ok: false; readonly reasonCode: 'EDIT_NO_MATCH' | 'EDIT_NOT_UNIQUE' };

/** A range of the LF view, end exclusive. */
interface Range {
  readonly start: number;
  readonly end: number;
}

type Finder = (view: string, target: string) => readonly Range[];

const TYPOGRAPHIC_QUOTES: readonly (readonly [RegExp, string])[] = [
  [/[‘’‚‛]/gu, "'"],
  [/[“”„‟]/gu, '"'],
];

/** Keeps every offset: each quote is one UTF-16 unit before and after. */
const withPlainQuotes = (text: string): string =>
  TYPOGRAPHIC_QUOTES.reduce((result, [quotes, plain]) => result.replace(quotes, plain), text);

/** Overlapping occurrences count, so `aa` in `aaa` is not unique. */
const findExact: Finder = (view, target) => {
  const ranges: Range[] = [];
  for (let start = view.indexOf(target); start !== -1; start = view.indexOf(target, start + 1))
    ranges.push({ start, end: start + target.length });
  return ranges;
};

const findWithPlainQuotes: Finder = (view, target) =>
  findExact(withPlainQuotes(view), withPlainQuotes(target));

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');

/**
 * The target with each run of whitespace free to differ in width, and a line break free to bring
 * other indentation or blank lines. A run at either end stays on its line, so a match cannot eat
 * the lines around it. Undefined for a target that is only whitespace.
 */
function whitespacePattern(target: string): RegExp | undefined {
  const parts = target.split(/(\s+)/u);
  if (parts.every((part) => part.trim() === '')) return undefined;
  const leading = parts[0] === '' ? 1 : -1;
  const trailing = parts.at(-1) === '' ? parts.length - 2 : -1;
  const source = parts
    .map((part, index) => {
      if (part === '') return '';
      if (part.trim() !== '') return escapeRegExp(part);
      if (index === leading) return part.includes('\n') ? '[ \\t]*\\n[ \\t]*' : '[ \\t]*';
      if (index === trailing) return part.includes('\n') ? '[ \\t]*\\n' : '[ \\t]*';
      return part.includes('\n') ? '[ \\t]*\\n\\s*' : '[ \\t]+';
    })
    .join('');
  return new RegExp(source, 'gu');
}

const findIgnoringWhitespace: Finder = (view, target) => {
  const pattern = whitespacePattern(target);
  if (pattern === undefined) return [];
  return [...view.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
};

/** The order is the order of trust: the first that finds anything decides. */
const FINDERS: readonly Finder[] = [findExact, findWithPlainQuotes, findIgnoringWhitespace];

/** The offsets of the view at which a CR was dropped, ascending. */
function droppedCarriageReturns(content: string): readonly number[] {
  const dropped: number[] = [];
  for (let raw = content.indexOf('\r\n'); raw !== -1; raw = content.indexOf('\r\n', raw + 2))
    dropped.push(raw - dropped.length);
  return dropped;
}

/** Keeps the ranges a left-to-right replacement can apply, dropping those that overlap one kept. */
function withoutOverlaps(ranges: readonly Range[]): readonly Range[] {
  const kept: Range[] = [];
  for (const range of ranges) {
    const previous = kept.at(-1);
    if (previous === undefined || range.start >= previous.end) kept.push(range);
  }
  return kept;
}

const usesCrLf = (text: string): boolean => text.includes('\r\n');

/** The ending of the replaced text; text with no line break takes the ending most of the file has. */
function endingFor(replaced: string, content: string, dropped: readonly number[]): string {
  if (replaced.includes('\n')) return usesCrLf(replaced) ? '\r\n' : '\n';
  const lineFeeds = content.split('\n').length - 1;
  return dropped.length > lineFeeds - dropped.length ? '\r\n' : '\n';
}

/** Applies one edit to the text of a file; a refusal leaves it untouched. */
export function applyEdit(content: string, request: EditRequest): EditMatch {
  if (request.oldString.length === 0) return { ok: false, reasonCode: 'EDIT_NO_MATCH' };
  const target = request.oldString.replaceAll('\r\n', '\n');
  const replacement = request.newString.replaceAll('\r\n', '\n');
  const view = content.replaceAll('\r\n', '\n');
  const dropped = droppedCarriageReturns(content);
  /** A view offset in the content: on a line feed it means the CR before it. */
  const rawOffset = (offset: number): number => {
    let below = 0;
    while (below < dropped.length && (dropped[below] ?? offset) < offset) below += 1;
    return offset + below;
  };

  for (const find of FINDERS) {
    const found = find(view, target);
    if (found.length === 0) continue;
    if (found.length > 1 && !request.replaceAll)
      return { ok: false, reasonCode: 'EDIT_NOT_UNIQUE' };
    const ranges = withoutOverlaps(found);
    let result = '';
    let cursor = 0;
    for (const range of ranges) {
      const start = rawOffset(range.start);
      const end = rawOffset(range.end);
      const replaced = content.slice(start, end);
      result += content.slice(cursor, start);
      result += replacement.replaceAll('\n', endingFor(replaced, content, dropped));
      cursor = end;
    }
    return { ok: true, content: result + content.slice(cursor), replacements: ranges.length };
  }
  return { ok: false, reasonCode: 'EDIT_NO_MATCH' };
}
