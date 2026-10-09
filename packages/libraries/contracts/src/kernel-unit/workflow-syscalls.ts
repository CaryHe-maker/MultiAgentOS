import { Type, type Static } from 'typebox';
import { PinnedDefinitionRefSchema } from '../catalog/definition-schemas.js';
import { RunFailureSchema } from '../kernel-control/run-outcome.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { closed } from '../platform-common/schema-helpers.js';
import { UnitInputSchema } from './unit-io.js';

/** `agentRef.kind` is AGENT. */
export const RegisterAgentRunRequestSchema = closed(
  {
    requestId: IdSchemas.requestId,
    workflowRunId: IdSchemas.workflowRunId,
    agentRunId: IdSchemas.agentRunId,
    agentRef: PinnedDefinitionRefSchema,
  },
  'kernel.unit.RegisterAgentRunRequest.v0',
);
export type RegisterAgentRunRequest = Static<typeof RegisterAgentRunRequestSchema>;

/** `unitRef.kind` is UNIT; `input` follows that Unit's `inputContract`. */
export const SubmitUnitRequestSchema = closed(
  {
    requestId: IdSchemas.requestId,
    workflowRunId: IdSchemas.workflowRunId,
    agentRunId: IdSchemas.agentRunId,
    unitRef: PinnedDefinitionRefSchema,
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
/** A FAILED close carries `failure.source = 'WORKFLOW'`. */
export const CloseRunRequestSchema = Type.Union(
  [
    closed({ ...closeRun, outcome: Type.Literal('COMPLETED'), reportRef: ArtifactRefSchema }),
    closed({ ...closeRun, outcome: Type.Literal('FAILED'), failure: RunFailureSchema }),
  ],
  { $id: 'kernel.unit.CloseRunRequest.v0' },
);
export type CloseRunRequest = Static<typeof CloseRunRequestSchema>;
