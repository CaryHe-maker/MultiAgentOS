import { Type, type Static } from 'typebox';
import { Sha256Schema, closed, count, text } from '../platform-common/schema-helpers.js';

/** Also the parameters of the `read_file` tool. */
export const FileReadInputSchema = closed(
  {
    path: text(1024),
    startLine: Type.Optional(count(1)),
    endLine: Type.Optional(count(1)),
  },
  'executor.FileReadInput.v0',
);
export type FileReadInput = Static<typeof FileReadInputSchema>;

/** An empty file read without a range reports startLine 1, endLine 0 and totalLines 0. */
export const FileReadOutputSchema = closed(
  {
    path: text(1024),
    startLine: count(1),
    endLine: count(),
    totalLines: count(),
    contentSha256: Sha256Schema,
    fileSha256: Sha256Schema,
  },
  'executor.FileReadOutput.v0',
);
export type FileReadOutput = Static<typeof FileReadOutputSchema>;
