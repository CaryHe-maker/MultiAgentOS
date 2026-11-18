import { describe, expect, it } from 'vitest';
import { withCamelNames } from './argument-aliases.js';

const editFile = {
  type: 'object',
  properties: { path: {}, oldString: {}, newString: {}, replaceAll: {} },
};

describe('withCamelNames (D57)', () => {
  it('takes old_string and new_string as oldString and newString', () => {
    expect(
      withCamelNames(editFile, {
        path: 'a.py',
        old_string: 'x',
        new_string: 'y',
        replace_all: true,
      }),
    ).toEqual({ path: 'a.py', oldString: 'x', newString: 'y', replaceAll: true });
  });

  it('leaves the arguments as they are when nothing is to be taken over', () => {
    const args = { path: 'a.py', oldString: 'x', newString: 'y' };
    expect(withCamelNames(editFile, args)).toBe(args);
  });

  it('takes over no name the tool does not have, and does not overwrite one given twice', () => {
    expect(withCamelNames(editFile, { path: 'a', old_text: 'x' })).toEqual({
      path: 'a',
      old_text: 'x',
    });
    expect(withCamelNames(editFile, { path: 'a', oldString: 'x', old_string: 'z' })).toEqual({
      path: 'a',
      oldString: 'x',
      old_string: 'z',
    });
  });
});
