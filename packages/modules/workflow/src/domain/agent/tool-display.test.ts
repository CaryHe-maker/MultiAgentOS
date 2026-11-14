import { describe, expect, it } from 'vitest';
import { argsSummaryOf, controlSummaryOf, oneLine } from './tool-display.js';

describe('what the line of a tool call shows', () => {
  it('names the argument that says what the call does', () => {
    expect(argsSummaryOf({ path: 'src/a.ts', offset: 3 })).toBe('src/a.ts');
    expect(argsSummaryOf({ command: 'pytest -q', workdir: 'svc' })).toBe('pytest -q');
    expect(argsSummaryOf({ pattern: 'TODO', path: 'src' })).toBe('TODO in src');
    expect(argsSummaryOf({ query: 'bwrap seccomp' })).toBe('bwrap seccomp');
    expect(argsSummaryOf({ url: 'https://example.com/a' })).toBe('https://example.com/a');
    expect(argsSummaryOf({ toolCallId: 'call_7' })).toBe('call_7');
    expect(argsSummaryOf({})).toBe('');
    expect(argsSummaryOf(null)).toBe('');
  });

  it('keeps to one line of at most 80 characters', () => {
    expect(oneLine('a\n  b\tc')).toBe('a b c');
    const long = argsSummaryOf({ command: `echo ${'x'.repeat(200)}` });
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('says whom a message goes to and what it says first', () => {
    expect(controlSummaryOf('MESSAGE', { to: 'ui', text: 'The API is ready.' })).toBe(
      'to ui: The API is ready.',
    );
    expect(
      controlSummaryOf('MESSAGE', {
        to: 'api',
        kind: 'request',
        summary: 'Which port?',
        text: 'long text',
      }),
    ).toBe('to api (request): Which port?');
    expect(controlSummaryOf('MESSAGE', { to: 'w', interrupt: true, text: 'stop' })).toBe(
      'to w interrupt: stop',
    );
  });

  it('says which tasks start or stop, and what a sleep waits for', () => {
    expect(controlSummaryOf('SPAWN', { tasks: [{ name: 'api' }, { name: 'ui' }] })).toBe(
      '2 tasks: api, ui',
    );
    expect(
      controlSummaryOf('SLEEP', {
        until: [{ kind: 'children' }, { kind: 'message' }],
        timeoutSeconds: 600,
      }),
    ).toBe('until children or message, at most 600 s');
    expect(controlSummaryOf('STOP', { names: ['a', 'b'], reason: 'done' })).toBe('a, b');
    expect(controlSummaryOf('JOB', { jobId: 'job_2' })).toBe('job_2');
  });
});
