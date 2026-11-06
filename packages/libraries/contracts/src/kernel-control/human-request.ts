import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { closed, text } from '../platform-common/schema-helpers.js';

/**
 * What a human request asks for (M2Design 4.2). `prompt` is open input and ends the Turn; the other
 * three are local questions: they block only the AgentRun that asked, and need no stillness.
 */
export const HUMAN_REQUEST_KINDS = ['prompt', 'ask', 'confirm', 'review'] as const;
export type HumanRequestKind = (typeof HUMAN_REQUEST_KINDS)[number];

export const LOCAL_QUESTION_KINDS = ['ask', 'confirm', 'review'] as const;
export type LocalQuestionKind = (typeof LOCAL_QUESTION_KINDS)[number];

export const HUMAN_FIELD_TYPES = ['text', 'textarea', 'select', 'multiselect', 'confirm'] as const;

/** One field of a local question; the answer carries them as JSON in the input text. */
export const HumanFieldSchema = closed({
  name: text(64),
  type: Type.Enum(HUMAN_FIELD_TYPES),
  label: text(200),
  options: Type.Optional(Type.Array(text(200), { minItems: 1, maxItems: 20 })),
  required: Type.Optional(Type.Boolean()),
});
export type HumanField = Static<typeof HumanFieldSchema>;

export const MAX_QUESTION_CHARS = 1000;
export const MAX_QUESTION_FIELDS = 8;

/** What a local question adds to a human request, on the way to the user and into the log. */
export const localQuestionProperties = {
  attachedAgentRunId: IdSchemas.agentRunId,
  question: text(MAX_QUESTION_CHARS),
  fields: Type.Optional(Type.Array(HumanFieldSchema, { maxItems: MAX_QUESTION_FIELDS })),
  /** `review`: the artifact the user is asked to look at. */
  reviewRef: Type.Optional(ArtifactRefSchema),
};
