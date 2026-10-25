import { Type, type Static } from 'typebox';
import { Sha256Schema, closed, count, text } from '../platform-common/schema-helpers.js';

/**
 * Also the parameters of the `read_file` tool. When both lines are given, `startLine` must not
 * be greater than `endLine`; a range beyond the file is answered with INVALID_RANGE.
 */
export const FileReadInputSchema = Type.Refine(
  closed(
    {
      path: text(1024),
      startLine: Type.Optional(count(1)),
      endLine: Type.Optional(count(1)),
    },
    'executor.FileReadInput.v0',
  ),
  (input) =>
    input.startLine === undefined ||
    input.endLine === undefined ||
    input.startLine <= input.endLine,
  () => 'startLine must not be greater than endLine',
);
export type FileReadInput = Static<typeof FileReadInputSchema>;

/**
 * `startLine..endLine` is what was actually returned, inside `1..totalLines`. The only empty
 * result is an empty file: `startLine = 1`, `endLine = 0`, `totalLines = 0`.
 */
export const FileReadOutputSchema = Type.Refine(
  closed(
    {
      path: text(1024),
      startLine: count(1),
      endLine: count(),
      totalLines: count(),
      contentSha256: Sha256Schema,
      fileSha256: Sha256Schema,
    },
    'executor.FileReadOutput.v0',
  ),
  (output) =>
    output.totalLines === 0
      ? output.startLine === 1 && output.endLine === 0
      : output.startLine <= output.endLine && output.endLine <= output.totalLines,
  () => 'the returned range must lie inside the file, or be 1..0 for an empty file',
);
export type FileReadOutput = Static<typeof FileReadOutputSchema>;
