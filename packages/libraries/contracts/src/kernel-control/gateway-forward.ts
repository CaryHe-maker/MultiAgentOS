import { Type, type Static, type TSchema } from 'typebox';
import {
  CloseRunRequestSchema,
  EndAgentRunRequestSchema,
  RegisterAgentRunRequestSchema,
  SubmitUnitRequestSchema,
} from '../kernel-unit/workflow-syscalls.js';
import { IdSchemas } from '../platform-common/ids.js';
import { closed } from '../platform-common/schema-helpers.js';
import {
  AnswerAuthorizationRequestSchema,
  CancelRunRequestSchema,
  CreateRunRequestSchema,
  ReadArtifactRequestSchema,
  ShutdownRequestSchema,
} from './interaction-requests.js';
import { CloseReasonSchema } from './run-outcome.js';

const forward = <C extends string, R extends string, S extends TSchema>(
  caller: C,
  requestType: R,
  request: S,
) => closed({ caller: Type.Literal(caller), requestType: Type.Literal(requestType), request });

/**
 * What Gateway hands to the Kernel core after the caller, Schema and admission checks. The
 * response is the response of the wrapped request. Gateway generates the `workflowRunId` of
 * `createRun`.
 */
export const GatewayForwardSchema = Type.Union(
  [
    forward('workflow', 'registerAgentRun', RegisterAgentRunRequestSchema),
    forward('workflow', 'submitUnit', SubmitUnitRequestSchema),
    forward('workflow', 'endAgentRun', EndAgentRunRequestSchema),
    forward('workflow', 'closeRun', CloseRunRequestSchema),
    closed({
      caller: Type.Literal('user-interaction'),
      requestType: Type.Literal('createRun'),
      request: CreateRunRequestSchema,
      workflowRunId: IdSchemas.workflowRunId,
    }),
    forward('user-interaction', 'answerAuthorization', AnswerAuthorizationRequestSchema),
    forward('user-interaction', 'cancelRun', CancelRunRequestSchema),
    forward('user-interaction', 'readArtifact', ReadArtifactRequestSchema),
    forward('user-interaction', 'shutdown', ShutdownRequestSchema),
  ],
  { $id: 'kernel.control.GatewayForward.v0' },
);
export type GatewayForward = Static<typeof GatewayForwardSchema>;
export type GatewayRequestType = GatewayForward['requestType'];

/** Pushed by Core; Gateway only reads it. `closeReason` is present once the run left RUNNING. */
export const AdmissionProjectionSchema = Type.Union(
  [
    closed({ workflowRunId: IdSchemas.workflowRunId, runState: Type.Literal('RUNNING') }),
    closed({
      workflowRunId: IdSchemas.workflowRunId,
      runState: Type.Enum(['CONVERGING', 'CLOSED']),
      closeReason: CloseReasonSchema,
    }),
  ],
  { $id: 'kernel.control.AdmissionProjection.v0' },
);
export type AdmissionProjection = Static<typeof AdmissionProjectionSchema>;
