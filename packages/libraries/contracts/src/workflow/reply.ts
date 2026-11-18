import { type Static } from 'typebox';
import { closed, text } from '../platform-common/schema-helpers.js';

/** Parameters of `reply`, the control tool that ends main's AgentRun. */
export const ReplyArgsSchema = closed({ text: text(20000) }, 'workflow.ReplyArgs.v1');
export type ReplyArgs = Static<typeof ReplyArgsSchema>;
