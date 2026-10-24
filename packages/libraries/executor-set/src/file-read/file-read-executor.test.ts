import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex, type ExecutorOutcome, type FileReadInput } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { emptyDirectory, environmentFor, repositoryScope } from '../test-support/environments.js';
import { createFileReadExecutor } from './file-read-executor.js';

const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n') + '\n';

async function read(
  content: string,
  input: Omit<FileReadInput, 'path'> = {},
  maxOutputBytes = 1_048_576,
): Promise<ExecutorOutcome> {
  const root = await emptyDirectory('file-read');
  await writeFile(join(root, 'file.txt'), content);
  const environment = environmentFor('FILE_READ', repositoryScope(root));
  return createFileReadExecutor().execute(
    { path: 'file.txt', ...input },
    { ...environment, limits: { ...environment.limits, maxOutputBytes } },
  );
}

const output = (outcome: ExecutorOutcome) => {
  if (outcome.outcome !== 'COMPLETED') throw new Error(`not completed: ${JSON.stringify(outcome)}`);
  return { output: outcome.result.output, text: outcome.result.artifact.text };
};

describe('FILE_READ (ExecutorSet 4.3)', () => {
  it('reads lines 1..400 by default and reports the real end', async () => {
    const { output: result, text } = output(await read(numbered(1000)));
    expect(result).toMatchObject({ startLine: 1, endLine: 400, totalLines: 1000 });
    expect(text.split('\n')[399]).toBe('line 400');
    expect(result).toMatchObject({
      contentSha256: sha256Hex(text),
      fileSha256: sha256Hex(numbered(1000)),
    });
  });

  it('never returns more than 400 lines, even when asked', async () => {
    const { output: result } = output(await read(numbered(1000), { startLine: 10, endLine: 900 }));
    expect(result).toMatchObject({ startLine: 10, endLine: 409 });
  });

  it('clamps an end beyond the file to its last line', async () => {
    const { output: result } = output(await read(numbered(5), { startLine: 2, endLine: 50 }));
    expect(result).toMatchObject({ startLine: 2, endLine: 5, totalLines: 5 });
  });

  it('cuts to the last whole line within maxOutputBytes', async () => {
    // Each line "line N\n" is 7 bytes for N < 10.
    const { output: result, text } = output(await read(numbered(9), {}, 20));
    expect(result).toMatchObject({ startLine: 1, endLine: 2 });
    expect(text).toBe('line 1\nline 2\n');
  });

  it('rejects a first line longer than maxOutputBytes', async () => {
    expect(await read(`${'x'.repeat(100)}\nshort\n`, {}, 50)).toEqual({
      outcome: 'REJECTED',
      reasonCode: 'LIMIT_EXCEEDED',
    });
  });

  it('returns an empty file as 1..0 with empty content', async () => {
    const { output: result, text } = output(await read(''));
    expect(result).toMatchObject({ startLine: 1, endLine: 0, totalLines: 0 });
    expect(text).toBe('');
  });

  it('rejects a range on an empty file and a start beyond the end', async () => {
    expect(await read('', { startLine: 1 })).toMatchObject({ reasonCode: 'INVALID_RANGE' });
    expect(await read(numbered(3), { startLine: 4 })).toMatchObject({
      reasonCode: 'INVALID_RANGE',
    });
  });

  it('normalizes CRLF to LF and keeps a missing final newline', async () => {
    const { output: result, text } = output(await read('a\r\nb\r\nc'));
    expect(text).toBe('a\nb\nc');
    expect(result).toMatchObject({ totalLines: 3, endLine: 3 });
  });

  it('answers an aborted execution without reading', async () => {
    const root = await emptyDirectory('file-read');
    const environment = environmentFor('FILE_READ', repositoryScope(root), {
      signal: AbortSignal.abort(),
    });
    expect(await createFileReadExecutor().execute({ path: 'x' }, environment)).toEqual({
      outcome: 'FAILED',
      reasonCode: 'INTERNAL',
      retryable: false,
    });
  });
});
