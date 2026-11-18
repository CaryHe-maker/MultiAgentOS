import { RunCommandArgsSchema, SleepArgsSchema } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { unknownParameterHint } from './argument-hints.js';

describe('a parameter the tool does not have', () => {
  it('is named with the one it most likely stands for, and the parameters the tool takes', () => {
    const hint = unknownParameterHint(RunCommandArgsSchema, {
      command: 'npm test',
      run_in_background: true,
    });
    expect(hint).toContain(
      'run_in_background is not a parameter of this tool; did you mean runInBackground?',
    );
    expect(hint).toContain('Its parameters are: ');
    expect(hint).toContain('command');
  });

  it('finds a name one or two letters off, and says plainly when none is near', () => {
    expect(unknownParameterHint(SleepArgsSchema, { untl: [] })).toContain('did you mean until?');
    const far = unknownParameterHint(SleepArgsSchema, { until: [], checklist: ['a'] });
    expect(far).toContain('checklist is not a parameter of this tool.');
    expect(far).not.toContain('did you mean');
  });

  it('says nothing when every parameter is known, or the arguments are no object', () => {
    expect(unknownParameterHint(SleepArgsSchema, { until: [] })).toBeUndefined();
    expect(unknownParameterHint(SleepArgsSchema, null)).toBeUndefined();
    expect(unknownParameterHint(SleepArgsSchema, ['until'])).toBeUndefined();
  });
});
