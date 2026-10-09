import { Type, type Static } from 'typebox';
import { pinnedRefOf } from '../catalog/definition-schemas.js';
import { ReportRefSchema, WorkflowRunFailureSchema } from '../kernel-control/run-outcome.js';
import { IdSchemas } from '../platform-common/ids.js';
import { closed } from '../platform-common/schema-helpers.js';
import { UnitInputSchema } from './unit-io.js';

export const RegisterAgentRunRequestSchema = closed(
  {
    requestId: IdSchemas.requestId,
    workflowRunId: IdSchemas.workflowRunId,
    agentRunId: IdSchemas.agentRunId,
    agentRef: pinnedRefOf('AGENT'),
  },
  'kernel.unit.RegisterAgentRunRequest.v0',
);
export type RegisterAgentRunRequest = Static<typeof RegisterAgentRunRequestSchema>;

/** `input` follows the `inputContract` of the Unit that `unitRef` names; Core checks that. */
export const SubmitUnitRequestSchema = closed(
  {
    requestId: IdSchemas.requestId,
    workflowRunId: IdSchemas.workflowRunId,
    agentRunId: IdSchemas.agentRunId,
    unitRef: pinnedRefOf('UNIT'),
    input: UnitInputSchema,
  },
  'kernel.unit.SubmitUnitRequest.v0',
);
export type SubmitUnitRequest = Static<typeof SubmitUnitRequestSchema>;

export const EndAgentRunRequestSchema = closed(
  {
    requestId: IdSchemas.requestId,
    workflowRunId: IdSchemas.workflowRunId,
    agentRunId: IdSchemas.agentRunId,
  },
  'kernel.unit.EndAgentRunRequest.v0',
);
export type EndAgentRunRequest = Static<typeof EndAgentRunRequestSchema>;

const closeRun = { requestId: IdSchemas.requestId, workflowRunId: IdSchemas.workflowRunId };
/**
 * COMPLETED carries the published report and nothing else; FAILED carries a failure whose
 * source is WORKFLOW and nothing else.
 */
export const CloseRunRequestSchema = Type.Union(
  [
    closed({ ...closeRun, outcome: Type.Literal('COMPLETED'), reportRef: ReportRefSchema }),
    closed({ ...closeRun, outcome: Type.Literal('FAILED'), failure: WorkflowRunFailureSchema }),
  ],
  { $id: 'kernel.unit.CloseRunRequest.v0' },
);
export type CloseRunRequest = Static<typeof CloseRunRequestSchema>;
