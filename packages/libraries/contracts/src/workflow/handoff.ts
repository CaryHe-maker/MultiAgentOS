import { Type, type Static } from 'typebox';
import { closed, text } from '../platform-common/schema-helpers.js';

/** Parameters of the `handoff_to_code_viewer` tool. */
export const HandoffBriefSchema = closed(
  {
    task: text(2000),
    focusAreas: Type.Array(text(200), { maxItems: 5 }),
    openQuestions: Type.Array(text(300), { maxItems: 5 }),
  },
  'workflow.HandoffBrief.v0',
);
export type HandoffBrief = Static<typeof HandoffBriefSchema>;
