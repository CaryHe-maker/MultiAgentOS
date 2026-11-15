import { describe, expect, it } from 'vitest';
import { parseToolArguments } from './tool-arguments.js';

describe('the arguments of a tool call, read leniently (D75)', () => {
  it('reads valid JSON as it is', () => {
    expect(parseToolArguments('{"a":"x\\ny","b":[1,2]}')).toEqual({ a: 'x\ny', b: [1, 2] });
  });

  it('keeps a backslash before a character JSON does not escape (K8)', () => {
    expect(parseToolArguments('{"goal":"sections `\\:\\:\\:` are optional"}')).toEqual({
      goal: 'sections `\\:\\:\\:` are optional',
    });
  });

  it('reads a double quote inside a string that was not escaped (K9)', () => {
    expect(
      parseToolArguments('{"goal":"head only supports negative as "all but last"), bytes","n":1}'),
    ).toEqual({ goal: 'head only supports negative as "all but last"), bytes', n: 1 });
  });

  it('escapes raw line breaks and tabs inside a string, and drops a comma before a bracket', () => {
    expect(parseToolArguments('{"text":"one\ntwo\tthree","list":[1,2,],}')).toEqual({
      text: 'one\ntwo\tthree',
      list: [1, 2],
    });
  });

  it('keeps valid escapes, \\u among them', () => {
    expect(parseToolArguments('{"a":"\\u00e9 \\" \\\\ \\x"}')).toEqual({ a: 'é " \\ \\x' });
  });

  it('gives up on what is not JSON even after repair', () => {
    expect(parseToolArguments('{"a": ')).toBeUndefined();
    expect(parseToolArguments('not json')).toBeUndefined();
  });
});
