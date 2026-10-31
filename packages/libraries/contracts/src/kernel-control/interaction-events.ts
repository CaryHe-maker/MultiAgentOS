import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { ExclusionRuleSchema } from '../platform-common/repository-exclusions.js';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';
import { runEndV1, runEndVariants } from './run-outcome.js';

/** `repositoryPath` is the realpath of the repository root; `exclusions` follow M1Interface 3.5. */
export const AuthorizationRequestSchema = closed(
  {
    type: Type.Literal('AuthorizationRequest'),
    questionId: IdSchemas.questionId,
    capability: Type.Literal('repo.read'),
    repositoryPath: text(4096),
    exclusions: Type.Array(ExclusionRuleSchema),
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

// --- Major 1 (Interface/InteractionKernel 3.1) ------------------------------------------------

/** A question waits until the user answers or the run converges; it never times out (M2Design 5.3). */
const question = {
  type: Type.Literal('AuthorizationRequest'),
  questionId: IdSchemas.questionId,
};
export const AuthorizationRequestV1Schema = Type.Union(
  [
    closed({
      ...question,
      capability: Type.Literal('repo.read'),
      repositoryPath: text(4096),
      exclusions: Type.Array(ExclusionRuleSchema),
      provider: text(64),
    }),
    closed({
      ...question,
      capability: Type.Literal('project.instructions'),
      path: text(512),
      contentRef: ArtifactRefSchema,
      truncated: Type.Boolean(),
    }),
  ],
  { $id: 'kernel.control.AuthorizationRequest.v1' },
);
export type AuthorizationRequestV1 = Static<typeof AuthorizationRequestV1Schema>;

/** CANCELLED only when the run converges or the answer can no longer reach the Kernel. */
export const AuthorizationResolvedV1Schema = closed(
  {
    type: Type.Literal('AuthorizationResolved'),
    questionId: IdSchemas.questionId,
    resolution: Type.Enum(['GRANTED', 'DECLINED', 'CANCELLED']),
  },
  'kernel.control.AuthorizationResolved.v1',
);
export type AuthorizationResolvedV1 = Static<typeof AuthorizationResolvedV1Schema>;

export const HumanRequestSchema = closed(
  {
    type: Type.Literal('HumanRequest'),
    humanRequestId: IdSchemas.humanRequestId,
    kind: Type.Literal('prompt'),
  },
  'kernel.control.HumanRequest.v1',
);
export type HumanRequest = Static<typeof HumanRequestSchema>;

export const HumanResolvedSchema = closed(
  {
    type: Type.Literal('HumanResolved'),
    humanRequestId: IdSchemas.humanRequestId,
    resolution: Type.Enum(['ANSWERED', 'CANCELLED']),
  },
  'kernel.control.HumanResolved.v1',
);
export type HumanResolved = Static<typeof HumanResolvedSchema>;

export const MessagePublishedSchema = closed(
  {
    type: Type.Literal('MessagePublished'),
    messageRef: ArtifactRefSchema,
    agentLabel: text(80),
    kind: Type.Enum(['REPLY', 'DEGRADED_REPLY', 'RUN_RESULT']),
  },
  'kernel.control.MessagePublished.v1',
);
export type MessagePublished = Static<typeof MessagePublishedSchema>;

const stateChanged = { type: Type.Literal('RunStateChanged') };
export const RunStateChangedSchema = Type.Union(
  [
    closed({ ...stateChanged, state: Type.Literal('AWAITING_INPUT') }),
    closed({
      ...stateChanged,
      state: Type.Enum(['RUNNING', 'CONVERGING']),
      turnId: Type.Optional(IdSchemas.turnId),
    }),
  ],
  { $id: 'kernel.control.RunStateChanged.v1' },
);
export type RunStateChanged = Static<typeof RunStateChangedSchema>;

export const ACTIVITY_PHASES = [
  'ASSEMBLING',
  'THINKING',
  'RETRYING',
  'CALLING_TOOL',
  'AWAITING_AUTHORIZATION',
  'QUEUED',
  'WRAPPING_UP',
  'ENDED',
] as const;
const activity = {
  type: Type.Literal('ActivityEvent'),
  agentRunId: IdSchemas.agentRunId,
  label: text(80),
  unit: Type.Optional(
    closed({
      unitAttemptId: IdSchemas.unitAttemptId,
      toolName: text(64),
      argsSummary: text(80, 0),
      state: Type.Enum(['QUEUED', 'RUNNING', 'DONE']),
    }),
  ),
  at: TimestampSchema,
};
/** `retry` is present exactly in the RETRYING phase. */
export const ActivityEventSchema = Type.Union(
  [
    closed({
      ...activity,
      phase: Type.Literal('RETRYING'),
      retry: closed({ attempt: count(1), retryAt: TimestampSchema }),
    }),
    closed({
      ...activity,
      phase: Type.Enum(ACTIVITY_PHASES.filter((phase) => phase !== 'RETRYING')),
    }),
  ],
  { $id: 'kernel.control.ActivityEvent.v1' },
);
export type ActivityEvent = Static<typeof ActivityEventSchema>;

export const RunFinishedV1Schema = Type.Union([...runEndV1('RunFinished')], {
  $id: 'kernel.control.RunFinished.v1',
});
export type RunFinishedV1 = Static<typeof RunFinishedV1Schema>;

export const KernelToInteractionEventV1Schema = Type.Union([
  AuthorizationRequestV1Schema,
  AuthorizationResolvedV1Schema,
  HumanRequestSchema,
  HumanResolvedSchema,
  MessagePublishedSchema,
  RunStateChangedSchema,
  ActivityEventSchema,
  RunFinishedV1Schema,
]);
export type KernelToInteractionEventV1 = Static<typeof KernelToInteractionEventV1Schema>;

export const InteractionInboxEventV1Schema = closed(
  {
    eventId: IdSchemas.eventId,
    sessionId: IdSchemas.sessionId,
    workflowRunId: IdSchemas.workflowRunId,
    seq: count(1),
    occurredAt: TimestampSchema,
    event: KernelToInteractionEventV1Schema,
  },
  'kernel.control.InteractionInboxEvent.v1',
);
export type InteractionInboxEventV1 = Static<typeof InteractionInboxEventV1Schema>;
