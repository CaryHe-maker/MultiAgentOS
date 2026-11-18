/**
 * The arguments of a model's tool call, read leniently (Orchestration D75). A model writing a long
 * call now and then breaks JSON in a way whose meaning is plain: a backslash before a character
 * JSON does not escape (`\:`), a double quote inside a string that it did not escape, a raw line
 * break or tab inside a string, a comma before a closing bracket. Refusing the call makes the
 * model write all of it again (K8 and K9: a 6k–9k token `run_subagents`, a minute or more on the
 * critical path), so such a text is repaired once and read again. What still does not parse is
 * not valid JSON, as before. Every reader of a call's arguments uses this one function, so that a
 * call one part of the system accepted is read the same way by every other.
 */

/** The value of a call's arguments, or undefined when they are not JSON even after repair. */
export function parseToolArguments(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // repaired below
  }
  try {
    return JSON.parse(repairJson(text)) as unknown;
  } catch {
    return undefined;
  }
}

const ESCAPABLE = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const HEX4 = /^[0-9a-fA-F]{4}$/u;

/** The next character after `from` that is not white space, or '' at the end. */
function nextSignificant(text: string, from: number): string {
  for (let i = from; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') return ch;
  }
  return '';
}

/**
 * One pass over the text. Inside a string: an escape JSON does not know keeps its backslash as a
 * character; a double quote closes the string only when what follows can follow a string (`,`
 * `:` `}` `]` or the end), otherwise it is a character of the string; raw control characters are
 * escaped. Outside strings: a comma right before `}` or `]` is dropped.
 */
export function repairJson(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (!inString) {
      if (ch === '"') inString = true;
      else if (ch === ',') {
        const next = nextSignificant(text, i + 1);
        if (next === '}' || next === ']') continue;
      }
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const next = text.charAt(i + 1);
      if (ESCAPABLE.has(next)) {
        out += ch + next;
        i += 1;
      } else if (next === 'u' && HEX4.test(text.slice(i + 2, i + 6))) {
        out += text.slice(i, i + 6);
        i += 5;
      } else out += '\\\\';
      continue;
    }
    if (ch === '"') {
      const next = nextSignificant(text, i + 1);
      if (next === '' || next === ',' || next === ':' || next === '}' || next === ']') {
        inString = false;
        out += ch;
      } else out += '\\"';
      continue;
    }
    if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out;
}
