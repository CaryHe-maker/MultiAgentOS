import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyEdit } from './edit-match.js';

const edit = (content: string, oldString: string, newString: string, replaceAll = false) =>
  applyEdit(content, { oldString, newString, replaceAll });

describe('exact matching', () => {
  it('replaces the one occurrence', () => {
    expect(edit('alpha beta', 'beta', 'gamma')).toEqual({
      ok: true,
      content: 'alpha gamma',
      replacements: 1,
    });
  });

  it('refuses when nothing matches, and when more than one does', () => {
    expect(edit('alpha', 'beta', 'x')).toEqual({ ok: false, reasonCode: 'EDIT_NO_MATCH' });
    expect(edit('a a', 'a', 'x')).toEqual({ ok: false, reasonCode: 'EDIT_NOT_UNIQUE' });
    expect(edit('aaa', 'aa', 'x')).toEqual({ ok: false, reasonCode: 'EDIT_NOT_UNIQUE' });
  });

  it('replaceAll takes every occurrence, left to right without overlap', () => {
    expect(edit('a a a', 'a', 'b', true)).toMatchObject({ content: 'b b b', replacements: 3 });
    expect(edit('aaa', 'aa', 'x', true)).toMatchObject({ content: 'xa', replacements: 1 });
  });

  it('finds nothing for an empty target', () => {
    expect(edit('abc', '', 'x')).toEqual({ ok: false, reasonCode: 'EDIT_NO_MATCH' });
  });

  it('takes the new text literally', () => {
    expect(edit('price', 'price', "$& $1 $'")).toMatchObject({ content: "$& $1 $'" });
  });
});

describe('line endings', () => {
  it('matches LF text in a CRLF file and keeps CRLF', () => {
    expect(edit('one\r\ntwo\r\nthree\r\n', 'one\ntwo', 'uno\ndos')).toMatchObject({
      content: 'uno\r\ndos\r\nthree\r\n',
    });
  });

  it('accepts a CRLF request for an LF file', () => {
    expect(edit('one\ntwo\n', 'one\r\ntwo', 'uno\r\ndos')).toMatchObject({
      content: 'uno\ndos\n',
    });
  });

  it('leaves the endings it did not touch alone in a mixed file', () => {
    expect(edit('a\r\nb\nc\r\n', 'b', 'B')).toMatchObject({ content: 'a\r\nB\nc\r\n' });
    expect(edit('a\r\nb\nc\r\n', 'b\nc', 'B\nC')).toMatchObject({ content: 'a\r\nB\nC\r\n' });
  });

  it('a new line break inside one line takes what most of the file uses', () => {
    expect(edit('a\r\nb\r\nc\n', 'b', 'x\ny')).toMatchObject({ content: 'a\r\nx\r\ny\r\nc\n' });
    expect(edit('a\nb\nc\r\n', 'b', 'x\ny')).toMatchObject({ content: 'a\nx\ny\nc\r\n' });
  });

  it('a match that starts or ends on a line break takes the whole of it', () => {
    expect(edit('a\r\nb\r\n', '\nb', '\nB')).toMatchObject({ content: 'a\r\nB\r\n' });
    expect(edit('a\r\nb\r\n', 'a\n', 'A\n')).toMatchObject({ content: 'A\r\nb\r\n' });
  });
});

describe('retries', () => {
  it('ignores typographic quotes when the exact text is not there', () => {
    expect(edit('say “hi” and ‘bye’', `"hi" and 'bye'`, 'x')).toMatchObject({
      content: 'say x',
    });
    expect(edit(`say "hi"`, '“hi”', 'x')).toMatchObject({ content: 'say x' });
  });

  it('ignores differences in whitespace', () => {
    expect(edit('if  (a)\t{\n', 'if (a) {', 'x')).toMatchObject({ content: 'x\n' });
    expect(edit('  a\n\n      b\nc', 'a\n  b', 'x')).toMatchObject({ content: '  x\nc' });
  });

  it('does not eat the lines around the match', () => {
    expect(edit('head\n\n    a\n\ntail', '\ta\n', 'b\n')).toMatchObject({
      content: 'head\n\nb\n\ntail',
    });
  });

  it('prefers the exact text, and a retry must be unique too', () => {
    expect(edit('a  b a b', 'a b', 'x')).toMatchObject({ content: 'a  b x' });
    expect(edit('a  b a   b', 'a b', 'x')).toEqual({ ok: false, reasonCode: 'EDIT_NOT_UNIQUE' });
    expect(edit('“a” ‘a’', '"a"', 'x')).toMatchObject({
      content: 'x ‘a’',
    });
  });

  it('does not treat a target of only whitespace as anything loose', () => {
    expect(edit('ab', '  ', 'x')).toEqual({ ok: false, reasonCode: 'EDIT_NO_MATCH' });
  });

  it('takes regular expression characters in the target literally', () => {
    expect(edit('f(a.b)  [c]', 'f(a.b) [c]', 'x')).toMatchObject({ content: 'x' });
    expect(edit('f(aXb)  [c]', 'f(a.b) [c]', 'x')).toEqual({
      ok: false,
      reasonCode: 'EDIT_NO_MATCH',
    });
  });

  it('keeps the file line endings through a retry', () => {
    expect(edit('a  b\r\nc\r\n', 'a b\nc', 'x\ny')).toMatchObject({ content: 'x\r\ny\r\n' });
  });
});

describe('properties', () => {
  const lineBreak = fc.constantFrom('\n', '\r\n');
  const word = fc.stringMatching(/^[a-z]{1,6}$/u);

  it('touches nothing but the match, on any mix of line endings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(word, lineBreak), { minLength: 1, maxLength: 8 }),
        fc.nat(7),
        (lines, pick) => {
          const content = lines.map(([text, ending]) => text + ending).join('');
          const index = pick % lines.length;
          const target = `<${String(index)}>`;
          const marked = lines
            .map(([text, ending], i) => (i === index ? target : text) + ending)
            .join('');
          expect(edit(marked, target, lines[index]?.[0] ?? '')).toMatchObject({ content });
        },
      ),
    );
  });

  it('replacing and replacing back returns the same bytes', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(word, lineBreak), { maxLength: 8 }), (lines) => {
        const content = `${lines.map(([text, ending]) => text + ending).join('')}<x>`;
        const forward = edit(content, '<x>', '<y>');
        expect(forward.ok).toBe(true);
        if (forward.ok) expect(edit(forward.content, '<y>', '<x>')).toMatchObject({ content });
      }),
    );
  });
});
