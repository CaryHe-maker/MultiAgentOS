import { Type, type Static } from 'typebox';
import {
  HumanFieldSchema,
  LOCAL_QUESTION_KINDS,
  MAX_QUESTION_CHARS,
  MAX_QUESTION_FIELDS,
} from '../kernel-control/human-request.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { closed, text } from '../platform-common/schema-helpers.js';

/**
 * Parameters of `ask_user` (M2Design 3.4): a question, a confirmation, or an artifact for the user
 * to look at. The AgentRun that calls it waits for the answer, which is the result of the call.
 */
export const AskUserArgsSchema = closed(
  {
    kind: Type.Enum(LOCAL_QUESTION_KINDS),
    question: text(MAX_QUESTION_CHARS),
    fields: Type.Optional(Type.Array(HumanFieldSchema, { maxItems: MAX_QUESTION_FIELDS })),
    /** Only for `review`, and then required: what the user is asked to look at. */
    reviewArtifact: Type.Optional(ArtifactRefSchema),
  },
  'workflow.AskUserArgs.v1',
);
export type AskUserArgs = Static<typeof AskUserArgsSchema>;
