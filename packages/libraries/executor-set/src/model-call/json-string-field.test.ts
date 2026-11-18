import { describe, expect, it } from 'vitest';
import { JsonStringField } from './json-string-field.js';

/** What the reader gives out when the text is fed in pieces of the given sizes. */
function readIn(field: string, text: string, size: number): string {
  const reader = new JsonStringField(field);
  let out = '';
  const units = [...text];
  for (let at = 0; at < units.length; at += size)
    out += reader.feed(units.slice(at, at + size).join(''));
  return out;
}

/** Deterministic pseudo-random sizes, so a failure can be repeated. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('JsonStringField', () => {
  it('gives out the string of the field as it is written', () => {
    const reader = new JsonStringField('text');
    expect(reader.feed('{"te')).toBe('');
    expect(reader.feed('xt": "Hel')).toBe('Hel');
    expect(reader.feed('lo, wor')).toBe('lo, wor');
    expect(reader.feed('ld"}')).toBe('ld');
    expect(reader.done).toBe(true);
    expect(reader.feed('more')).toBe('');
  });

  it('decodes escapes, also when they are cut between two pieces', () => {
    const reader = new JsonStringField('text');
    let out = reader.feed('{"text":"a\\');
    out += reader.feed('nb\\"q\\\\ \\u00');
    out += reader.feed('e9 \\u4f60 \\/"}');
    expect(out).toBe('a\nb"q\\ é 你 /');
  });

  it('keeps the two halves of a character outside the basic plane together', () => {
    // 😀 is 😀; the pieces are cut between its halves.
    const reader = new JsonStringField('text');
    const first = reader.feed('{"text":"x\\ud83d');
    const second = reader.feed('\\ude00y"}');
    expect(first).toBe('x');
    expect(second).toBe('😀y');
    expect(readIn('text', '{"text":"😀 and \\ud83d\\ude00"}', 1)).toBe('😀 and 😀');
  });

  it('gives out what a full parse gives, whatever the pieces are', () => {
    const value = 'Line one\nLine "two" \\ \t tab é 你好 😀   end';
    const text = JSON.stringify({ other: 1, text: value, tail: [1, 2] });
    const random = lcg(7);
    for (let round = 0; round < 200; round += 1) {
      const reader = new JsonStringField('text');
      let out = '';
      const units = [...text];
      for (let at = 0; at < units.length;) {
        const size = 1 + Math.floor(random() * 6);
        out += reader.feed(units.slice(at, at + size).join(''));
        at += size;
      }
      expect(out).toBe(value);
    }
    expect(readIn('text', text, 1)).toBe(value);
  });

  it('reads only a string value of the top-level object', () => {
    // Nested, before-the-key, not a string, absent: nothing.
    expect(readIn('text', '{"a":{"text":"nested"}}', 3)).toBe('');
    expect(readIn('text', '{"text":42}', 3)).toBe('');
    expect(readIn('text', '{"text":["x"]}', 3)).toBe('');
    expect(readIn('text', '{"other":"text"}', 3)).toBe('');
    expect(readIn('text', '{"a":"x","text":"yes"}', 3)).toBe('yes');
    // A key that is only a part of the name does not count.
    expect(readIn('text', '{"textual":"no","text":"yes"}', 2)).toBe('yes');
  });

  it('is not confused by text that looks like structure', () => {
    const tricky = '{"a":"{\\"text\\":\\"fake\\"}","b":["\\"",{"text":"deep"}],"text":"real"}';
    expect(readIn('text', tricky, 1)).toBe('real');
    expect(readIn('text', tricky, 5)).toBe('real');
  });

  it('ends cleanly when the text is never finished', () => {
    const reader = new JsonStringField('text');
    expect(reader.feed('{"text":"cut off')).toBe('cut off');
    expect(reader.done).toBe(false);
  });
});
