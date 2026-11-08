import type { ModelProgressEvent } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { streamTap } from './stream-tap.js';

function sse(delta: object): Uint8Array {
  return new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`,
  );
}

describe('streamTap', () => {
  const run = (feed: (tap: (bytes: Uint8Array) => void) => void) => {
    const events: ModelProgressEvent[] = [];
    const tap = streamTap((event) => void events.push(event), new Set(['reply']));
    feed(tap);
    return events;
  };

  it('tells the thinking as it comes and, once, that the reply began (its text is not passed on)', () => {
    const events = run((tap) => {
      tap(sse({ role: 'assistant', content: '' }));
      tap(sse({ reasoning_content: 'Let me ' }));
      tap(sse({ reasoning_content: 'think.' }));
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
      { kind: 'ANSWER' },
    ]);
  });

  it('does not take text that comes with tool calls for an answer', () => {
    const events = run((tap) => {
      tap(sse({ content: 'I will write the file now. ' }));
      tap(
        sse({
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'file_write', arguments: '' } }],
        }),
      );
      tap(sse({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.docx"}' } }] }));
    });
    expect(events).toEqual([]);
  });

  it('tells nothing of a tool that does not answer the user', () => {
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
