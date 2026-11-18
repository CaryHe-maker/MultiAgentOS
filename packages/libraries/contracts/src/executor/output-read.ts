import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { ToolCallIdSchema } from '../platform-common/ids.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';

const window = {
  /** First line to return, from 1. */
  offset: Type.Optional(count(1)),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  /** Literal text, not a regular expression. */
  pattern: Type.Optional(text(500)),
};

/** The parameters of the `read_output` tool. */
export const OutputReadArgsSchema = closed(
  { toolCallId: ToolCallIdSchema, ...window },
  'executor.OutputReadArgs.v1',
);
export type OutputReadArgs = Static<typeof OutputReadArgsSchema>;

/** What Workflow submits: the id is translated into the full output it stands for. */
export const OutputReadInputSchema = closed(
  { toolCallId: ToolCallIdSchema, fullRef: ArtifactRefSchema, ...window },
  'executor.OutputReadInput.v1',
);
export type OutputReadInput = Static<typeof OutputReadInputSchema>;

export const OutputReadOutputSchema = closed(
  {
    toolCallId: ToolCallIdSchema,
    totalLines: count(),
    /** The lines that contain `pattern`; only with a pattern. */
    matchedLines: Type.Optional(count()),
    /** 1..0 when nothing is left to return. */
    startLine: count(1),
    endLine: count(),
    omittedLines: count(),
  },
  'executor.OutputReadOutput.v1',
);
export type OutputReadOutput = Static<typeof OutputReadOutputSchema>;
