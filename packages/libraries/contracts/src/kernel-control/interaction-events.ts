import { Type, type Static } from 'typebox';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
import { runEndVariants } from './run-outcome.js';

/** `repositoryPath` is the realpath of the repository root; `exclusions` are globs. */
export const AuthorizationRequestSchema = closed(
  {
    type: Type.Literal('AuthorizationRequest'),
    questionId: IdSchemas.questionId,
    capability: Type.Literal('repo.read'),
    repositoryPath: text(4096),
    exclusions: Type.Array(text(512)),
    provider: text(64),
    expiresAt: TimestampSchema,
  },
  'kernel.control.AuthorizationRequest.v0',
);
export type AuthorizationRequest = Static<typeof AuthorizationRequestSchema>;

export const AuthorizationResolvedSchema = closed(
  {
    type: Type.Literal('AuthorizationResolved'),
    questionId: IdSchemas.questionId,
    resolution: Type.Enum(['GRANTED', 'DECLINED', 'TIMED_OUT', 'CANCELLED']),
  },
  'kernel.control.AuthorizationResolved.v0',
);
export type AuthorizationResolved = Static<typeof AuthorizationResolvedSchema>;

/** Exactly one per run, the last event sent to UserInteraction; same RunEnd as RunClosed. */
export const RunFinishedSchema = Type.Union(runEndVariants('RunFinished'), {
  $id: 'kernel.control.RunFinished.v0',
});
export type RunFinished = Static<typeof RunFinishedSchema>;

export const KernelToInteractionEventSchema = Type.Union([
  AuthorizationRequestSchema,
  AuthorizationResolvedSchema,
  RunFinishedSchema,
]);
export type KernelToInteractionEvent = Static<typeof KernelToInteractionEventSchema>;

export const InteractionInboxEventSchema = closed(
  {
    eventId: IdSchemas.eventId,
    workflowRunId: IdSchemas.workflowRunId,
    seq: count(1),
    occurredAt: TimestampSchema,
    event: KernelToInteractionEventSchema,
  },
  'kernel.control.InteractionInboxEvent.v0',
);
export type InteractionInboxEvent = Static<typeof InteractionInboxEventSchema>;
