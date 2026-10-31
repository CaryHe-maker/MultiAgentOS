import { Type, type Static } from 'typebox';
import { DefinitionRefSchema } from '../catalog/definition-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { closed, text } from '../platform-common/schema-helpers.js';

/** The text is stored by Execution as an artifact and never enters the log. */
export const UserInputSchema = closed({ inputId: IdSchemas.inputId, text: text(100000) });
export type UserInput = Static<typeof UserInputSchema>;

/** Sent when the draft's first prompt is submitted; `FORK` opens in stage 2. */
export const StartSessionRequestSchema = closed(
  { requestId: IdSchemas.requestId, mode: Type.Literal('NEW'), prompt: UserInputSchema },
  'kernel.control.StartSessionRequest.v1',
);
export type StartSessionRequest = Static<typeof StartSessionRequestSchema>;

export const OpenSessionRequestSchema = closed(
  { requestId: IdSchemas.requestId, sessionId: IdSchemas.sessionId },
  'kernel.control.OpenSessionRequest.v1',
);
export type OpenSessionRequest = Static<typeof OpenSessionRequestSchema>;

/** `mas run <template> "<goal>"` always starts a new Session. */
export const StartRunRequestSchema = closed(
  { requestId: IdSchemas.requestId, template: DefinitionRefSchema, goal: UserInputSchema },
  'kernel.control.StartRunRequest.v1',
);
export type StartRunRequest = Static<typeof StartRunRequestSchema>;

export const ListSessionsRequestSchema = closed(
  { requestId: IdSchemas.requestId },
  'kernel.control.ListSessionsRequest.v1',
);
export type ListSessionsRequest = Static<typeof ListSessionsRequestSchema>;

export const DeleteSessionRequestSchema = closed(
  { requestId: IdSchemas.requestId, sessionId: IdSchemas.sessionId },
  'kernel.control.DeleteSessionRequest.v1',
);
export type DeleteSessionRequest = Static<typeof DeleteSessionRequestSchema>;
