import { Type, type Static } from 'typebox';
import { pinnedRefOf } from '../catalog/definition-schemas.js';
import { ReportRefSchema, WorkflowRunFailureSchema } from '../kernel-control/run-outcome.js';
import { ThinkingEffortSchema } from '../executor/model-call.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { pathDerivedId } from '../platform-common/new-id.js';
import { Sha256Schema, closed, text } from '../platform-common/schema-helpers.js';
import { UnitInputSchema, UnitInputV1Schema } from './unit-io.js';

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

// --- Major 1 (Interface/WorkflowKernel 2.2) ---------------------------------------------------

const inRun = {
  requestId: IdSchemas.requestId,
  sessionId: IdSchemas.sessionId,
  workflowRunId: IdSchemas.workflowRunId,
};

export const RegisterAgentRunRequestV1Schema = closed(
  {
    ...inRun,
    agentRunId: IdSchemas.agentRunId,
    nodeId: IdSchemas.nodeId,
    agentRef: pinnedRefOf('AGENT'),
    effort: ThinkingEffortSchema,
    workspaceViewId: Type.Literal('main'),
    display: closed({ label: text(80) }),
  },
  'kernel.unit.RegisterAgentRunRequest.v1',
);
export type RegisterAgentRunRequestV1 = Static<typeof RegisterAgentRunRequestV1Schema>;

const matchesPath = (request: { requestId: string; path: string }) =>
  request.requestId === pathDerivedId('req', request.path);
const matchesUnitRun = (request: { unitRunId: string; path: string }) =>
  request.unitRunId === pathDerivedId('unr', request.path.replace(/#[0-9]+$/u, ''));

/** The `requestId` and `unitRunId` come from `path`, so a replayed log rebuilds them. */
export const SubmitUnitRequestV1Schema = Type.Refine(
  closed(
    {
      ...inRun,
      agentRunId: IdSchemas.agentRunId,
      unitRunId: IdSchemas.unitRunId,
      path: text(512),
      unitRef: pinnedRefOf('UNIT'),
      input: UnitInputV1Schema,
      display: closed({ toolName: text(64), argsSummary: text(80, 0) }),
    },
    'kernel.unit.SubmitUnitRequest.v1',
  ),
  (request) => matchesPath(request) && matchesUnitRun(request),
  () => 'requestId and unitRunId must be derived from path',
);
export type SubmitUnitRequestV1 = Static<typeof SubmitUnitRequestV1Schema>;

export const EndAgentRunRequestV1Schema = closed(
  { ...inRun, agentRunId: IdSchemas.agentRunId },
  'kernel.unit.EndAgentRunRequest.v1',
);
export type EndAgentRunRequestV1 = Static<typeof EndAgentRunRequestV1Schema>;

export const CloseRunRequestV1Schema = Type.Union(
  [
    closed({
      ...inRun,
      outcome: Type.Enum(['COMPLETED', 'BUDGET', 'CANCELLED', 'TIMEOUT']),
      resultRef: Type.Optional(ArtifactRefSchema),
    }),
    closed({ ...inRun, outcome: Type.Literal('FAILED'), failure: WorkflowRunFailureSchema }),
  ],
  { $id: 'kernel.unit.CloseRunRequest.v1' },
);
export type CloseRunRequestV1 = Static<typeof CloseRunRequestV1Schema>;

export const RequestHumanRequestSchema = closed(
  {
    ...inRun,
    humanRequestId: IdSchemas.humanRequestId,
    nodeId: IdSchemas.nodeId,
    kind: Type.Literal('prompt'),
  },
  'kernel.unit.RequestHumanRequest.v1',
);
export type RequestHumanRequest = Static<typeof RequestHumanRequestSchema>;

/** Stage 1 opens `AGENTS.md` and repository templates; nested `AGENTS.md` comes with stage 2. */
export const ReadProjectFileRequestSchema = closed(
  {
    ...inRun,
    path: Type.String({
      pattern: '^(?:AGENTS\\.md|\\.multiagentos/workflows/[a-z0-9][a-z0-9-]{0,63}\\.yaml)$',
    }),
  },
  'kernel.unit.ReadProjectFileRequest.v1',
);
export type ReadProjectFileRequest = Static<typeof ReadProjectFileRequestSchema>;

const accepted = { requestId: IdSchemas.requestId, outcome: Type.Literal('ACCEPTED') };
export const ProjectFileContentSchema = Type.Union(
  [
    closed({ ...accepted, path: text(512), exists: Type.Literal(false) }),
    closed({
      ...accepted,
      path: Type.Literal('AGENTS.md'),
      exists: Type.Literal(true),
      ref: ArtifactRefSchema,
      sha256: Sha256Schema,
      trusted: Type.Boolean(),
    }),
    closed({
      ...accepted,
      path: text(512),
      exists: Type.Literal(true),
      ref: ArtifactRefSchema,
      sha256: Sha256Schema,
      text: Type.String(),
    }),
  ],
  { $id: 'kernel.unit.ProjectFileContent.v1' },
);
export type ProjectFileContent = Static<typeof ProjectFileContentSchema>;
