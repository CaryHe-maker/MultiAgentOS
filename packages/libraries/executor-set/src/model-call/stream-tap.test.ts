import type { ModelProgressEvent } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { JsonStringField } from './json-string-field.js';
import { streamTap } from './stream-tap.js';

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

function sse(delta: object): Uint8Array {
  return new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`,
  );
}

describe('streamTap', () => {
  const run = (feed: (tap: (bytes: Uint8Array) => void) => void) => {
    const events: ModelProgressEvent[] = [];
    const tap = streamTap((event) => void events.push(event), new Map([['reply', 'text']]));
    feed(tap);
    return events;
  };

  it('tells the thinking, the plain text and the text argument of a live tool as they come', () => {
    const events = run((tap) => {
      tap(sse({ role: 'assistant', content: '' }));
      tap(sse({ reasoning_content: 'Let me ' }));
      tap(sse({ reasoning_content: 'think.' }));
      tap(sse({ content: 'First, ' }));
      tap(
        sse({
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'reply', arguments: '' } }],
        }),
      );
      tap(sse({ tool_calls: [{ index: 0, function: { arguments: '{"text":"Hel' } }] }));
      tap(sse({ tool_calls: [{ index: 0, function: { arguments: 'lo!"}' } }] }));
    });
    expect(events).toEqual([
      { kind: 'REASONING', delta: 'Let me ' },
      { kind: 'REASONING', delta: 'think.' },
      { kind: 'TEXT', delta: 'First, ' },
      { kind: 'TEXT', delta: 'Hel' },
      { kind: 'TEXT', delta: 'lo!' },
    ]);
  });

  it('shows nothing of the arguments of a tool that is not live', () => {
    const events = run((tap) => {
      tap(
        sse({
          tool_calls: [
            { index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"' } },
          ],
        }),
      );
      tap(sse({ tool_calls: [{ index: 0, function: { arguments: 'a.txt"}' } }] }));
    });
    expect(events).toEqual([]);
  });

  it('keeps two tool calls apart by their index', () => {
    const events = run((tap) => {
      tap(
        sse({
          tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '' } }],
        }),
      );
      tap(sse({ tool_calls: [{ index: 1, id: 'b', function: { name: 'reply', arguments: '' } }] }));
      tap(sse({ tool_calls: [{ index: 0, function: { arguments: '{"text":"not shown"}' } }] }));
      tap(sse({ tool_calls: [{ index: 1, function: { arguments: '{"text":"shown"}' } }] }));
    });
    expect(events).toEqual([{ kind: 'TEXT', delta: 'shown' }]);
  });

  it('reads lines that are cut anywhere between the bytes, and ignores what it cannot read', () => {
    const body = new TextEncoder().encode(
      `: keep-alive\n\ndata: not json\n\n${[
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'héllo 你好' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')}`,
    );
    for (const size of [1, 2, 3, 7]) {
      const events = run((tap) => {
        for (let at = 0; at < body.length; at += size) tap(body.slice(at, at + size));
      });
      expect(events, String(size)).toEqual([{ kind: 'REASONING', delta: 'héllo 你好' }]);
    }
  });
});
