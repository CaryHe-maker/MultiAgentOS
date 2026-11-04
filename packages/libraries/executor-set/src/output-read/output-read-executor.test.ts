import type { ExecutorOutcome } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { environmentFor } from '../test-support/environments.js';
import { createOutputReadExecutor } from './output-read-executor.js';

const toolCallId = 'call_1';
const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${String(i + 1)}`).join('\n');

const run = (
  input: { content: string; offset?: number; limit?: number; pattern?: string },
  preview?: { maxBytes: number; maxLines: number },
): Promise<ExecutorOutcome> => {
  const environment = environmentFor('OUTPUT_READ', { kind: 'NONE' });
  return createOutputReadExecutor().execute(
    { toolCallId, ...input },
    preview === undefined
      ? environment
      : { ...environment, limits: { ...environment.limits, preview } },
  );
};

const textOf = (outcome: ExecutorOutcome): string => {
  if (outcome.outcome !== 'COMPLETED') throw new Error(outcome.outcome);
  return outcome.result.artifact.text;
};

describe('output-read', () => {
  it('numbers lines as in the original', async () => {
    const outcome = await run({ content: lines(3) });
    expect(outcome).toMatchObject({
      result: { output: { totalLines: 3, startLine: 1, endLine: 3, omittedLines: 0 } },
    });
    expect(textOf(outcome)).toBe('call_1: lines 1-3 of 3\n1 | line 1\n2 | line 2\n3 | line 3');
  });

  it('treats CRLF and LF alike, and a final line break as no extra line', async () => {
    expect(textOf(await run({ content: 'a\r\nb\nc\n' }))).toContain('1 | a\n2 | b\n3 | c');
    expect(await run({ content: 'a\n' })).toMatchObject({
      result: { output: { totalLines: 1 } },
    });
  });

  it('reads a window and says how to go on', async () => {
    const outcome = await run({ content: lines(10), offset: 3, limit: 2 });
    expect(outcome).toMatchObject({
      result: { output: { startLine: 3, endLine: 4, omittedLines: 6 } },
    });
    expect(textOf(outcome)).toContain('6 more; continue with offset 5');
  });

  it('matches a pattern literally, keeping the original numbers', async () => {
    const outcome = await run({ content: 'a.c\nabc\na.c\n', pattern: 'a.c' });
    expect(outcome).toMatchObject({ result: { output: { matchedLines: 2, totalLines: 3 } } });
    expect(textOf(outcome)).toContain('1 | a.c\n3 | a.c');
  });

  it('a pattern that matches nothing is an answer', async () => {
    expect(await run({ content: 'abc', pattern: 'zzz' })).toMatchObject({
      result: { output: { matchedLines: 0, startLine: 1, endLine: 0 } },
    });
  });

  it('refuses an offset past the end', async () => {
    expect(await run({ content: lines(3), offset: 4 })).toMatchObject({
      outcome: 'REJECTED',
      reasonCode: 'INVALID_RANGE',
    });
  });

  it('stays inside the preview, keeping whole lines', async () => {
    const outcome = await run({ content: lines(100) }, { maxBytes: 40, maxLines: 2000 });
    expect(outcome).toMatchObject({ result: { output: { startLine: 1 } } });
    if (outcome.outcome !== 'COMPLETED') throw new Error('not completed');
    const { omittedLines, endLine } = outcome.result.output as {
      omittedLines: number;
      endLine: number;
    };
    expect(endLine + omittedLines).toBe(100);
    expect(textOf(outcome)).toContain(`continue with offset ${String(endLine + 1)}`);
  });

  it('gives the same bytes for the same input', async () => {
    const input = { content: lines(50), offset: 5, limit: 10 };
    expect(textOf(await run(input))).toBe(textOf(await run(input)));
  });
});
