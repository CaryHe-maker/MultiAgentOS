/**
 * Reads one string field of a JSON object while the object is still being written, and gives out
 * the text of the string as it grows. A model writes a tool call's arguments a few characters at a
 * time (`{"te`, `xt": "Hel`, `lo\n`, ...), and the text of a reply is such an argument: this is how
 * it can be shown before the call is complete.
 *
 * Only a string value of a key of the top-level object counts; the same key nested deeper, a key
 * that comes later than its text, and a value that is not a string give nothing. Escapes are
 * decoded, also when they are cut between two pieces of input (`\` and `n`, or half of `é`).
 * What it gives out is what a full parse of the finished text would give for that field, in pieces.
 */
export class JsonStringField {
  readonly #field: string;
  /** Depth of nesting: 1 is inside the top-level object. */
  #depth = 0;
  #mode: 'IDLE' | 'AFTER_KEY' | 'VALUE_NEXT' | 'CAPTURE' | 'DONE' = 'IDLE';
  #inString = false;
  #isKey = false;
  #key = '';
  #escape = false;
  #unicode = '';
  /** The first half of a character outside the basic plane, held until the second arrives. */
  #high = '';
  #expectKey = false;

  public constructor(field: string) {
    this.#field = field;
  }

  /** True once the string of the field has ended. */
  public get done(): boolean {
    return this.#mode === 'DONE';
  }

  /** More of the object's text; returns what was added to the string of the field. */
  public feed(chunk: string): string {
    let out = '';
    for (const character of chunk) {
      if (this.#mode === 'DONE') break;
      if (this.#mode === 'CAPTURE') {
        out += this.#capture(character);
        continue;
      }
      if (this.#inString) {
        this.#skipString(character);
        continue;
      }
      this.#structure(character);
    }
    return out;
  }

  #structure(character: string): void {
    switch (character) {
      case '{':
        this.#depth += 1;
        if (this.#depth === 1) this.#expectKey = true;
        this.#settleValue();
        return;
      case '[':
        this.#depth += 1;
        this.#settleValue();
        return;
      case '}':
      case ']':
        this.#depth -= 1;
        return;
      case '"':
        if (this.#mode === 'VALUE_NEXT' && this.#depth === 1 && this.#key === this.#field) {
          this.#mode = 'CAPTURE';
          return;
        }
        this.#inString = true;
        this.#isKey = this.#depth === 1 && this.#expectKey && this.#mode === 'IDLE';
        this.#key = this.#isKey ? '' : this.#key;
        return;
      case ':':
        if (this.#mode === 'AFTER_KEY') this.#mode = 'VALUE_NEXT';
        return;
      case ',':
        if (this.#depth === 1) {
          this.#expectKey = true;
          this.#mode = 'IDLE';
        }
        return;
      case ' ':
      case '\n':
      case '\r':
      case '\t':
        return;
      default:
        // A number or a literal: the value of the key is not a string.
        this.#settleValue();
    }
  }

  /** A value that is not the string we want has begun. */
  #settleValue(): void {
    if (this.#mode === 'VALUE_NEXT') this.#mode = 'IDLE';
  }

  /** A string that is not the one we want: a key, or the value of another key. */
  #skipString(character: string): void {
    if (this.#escape) {
      this.#escape = false;
      if (this.#isKey) this.#key += character === 'n' ? '\n' : character;
      return;
    }
    if (character === '\\') {
      this.#escape = true;
      return;
    }
    if (character === '"') {
      this.#inString = false;
      if (this.#isKey) {
        this.#expectKey = false;
        this.#mode = 'AFTER_KEY';
      } else if (this.#mode === 'VALUE_NEXT') this.#mode = 'IDLE';
      return;
    }
    if (this.#isKey) this.#key += character;
  }

  #capture(character: string): string {
    if (this.#unicode.length > 0 || (this.#escape && character === 'u')) {
      if (this.#escape) {
        this.#escape = false;
        this.#unicode = 'u';
        return '';
      }
      this.#unicode += character;
      if (this.#unicode.length < 5) return '';
      const code = Number.parseInt(this.#unicode.slice(1), 16);
      this.#unicode = '';
      return this.#emit(Number.isNaN(code) ? '�' : String.fromCharCode(code));
    }
    if (this.#escape) {
      this.#escape = false;
      const decoded: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
        '/': '/',
        '\\': '\\',
        '"': '"',
      };
      return this.#emit(decoded[character] ?? character);
    }
    if (character === '\\') {
      this.#escape = true;
      return '';
    }
    if (character === '"') {
      this.#mode = 'DONE';
      return this.#flushHigh();
    }
    return this.#emit(character);
  }

  /** Gives out a unit of text, holding back the first half of a pair until the second comes. */
  #emit(unit: string): string {
    const code = unit.charCodeAt(0);
    if (unit.length === 1 && code >= 0xd800 && code <= 0xdbff) {
      const before = this.#flushHigh();
      this.#high = unit;
      return before;
    }
    if (this.#high.length > 0) {
      const pair = unit.length === 1 && code >= 0xdc00 && code <= 0xdfff;
      const held = this.#high;
      this.#high = '';
      return pair ? held + unit : `�${unit}`;
    }
    return unit;
  }

  #flushHigh(): string {
    if (this.#high.length === 0) return '';
    this.#high = '';
    return '�';
  }
}
