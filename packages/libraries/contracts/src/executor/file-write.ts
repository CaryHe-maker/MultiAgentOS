import { Type, type Static } from 'typebox';
import { Sha256Schema, closed, text } from '../platform-common/schema-helpers.js';

/** The parameters of the `write_file` tool; `baseSha` and `expectAbsent` are not the model's. */
export const FileWriteArgsSchema = closed(
  { path: text(1024), content: Type.String(), append: Type.Optional(Type.Boolean()) },
  'executor.FileWriteArgs.v1',
);
export type FileWriteArgs = Static<typeof FileWriteArgsSchema>;

/**
 * What Workflow submits (Module/Workflow 7, item 10): overwriting needs the digest it last saw,
 * creating needs the promise that nothing is there, and a write with neither is INVALID_INPUT.
 */
export const FileWriteInputSchema = Type.Refine(
  closed(
    {
      path: text(1024),
      content: Type.String(),
      append: Type.Optional(Type.Boolean()),
      baseSha: Type.Optional(Sha256Schema),
      expectAbsent: Type.Optional(Type.Literal(true)),
    },
    'executor.FileWriteInput.v1',
  ),
  (input) => (input.baseSha === undefined) !== (input.expectAbsent === undefined),
  () => 'exactly one of baseSha and expectAbsent is required',
);
export type FileWriteInput = Static<typeof FileWriteInputSchema>;

const edit = {
  path: text(1024),
  oldString: Type.String({ minLength: 1 }),
  newString: Type.String(),
  replaceAll: Type.Optional(Type.Boolean()),
};

/** The parameters of the `edit_file` tool. */
export const FileEditArgsSchema = closed(edit, 'executor.FileEditArgs.v1');
export type FileEditArgs = Static<typeof FileEditArgsSchema>;

export const FileEditInputSchema = closed(
  { ...edit, baseSha: Sha256Schema },
  'executor.FileEditInput.v1',
);
export type FileEditInput = Static<typeof FileEditInputSchema>;

/** The output of both tools; `sha256` is the digest of the file's new content. */
export const FileWriteOutputSchema = closed(
  {
    path: text(1024),
    operation: Type.Enum(['CREATED', 'OVERWRITTEN', 'APPENDED', 'EDITED']),
    sha256: Sha256Schema,
  },
  'executor.FileWriteOutput.v1',
);
export type FileWriteOutput = Static<typeof FileWriteOutputSchema>;
