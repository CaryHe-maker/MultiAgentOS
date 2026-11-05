import { Type, type Static } from 'typebox';
import { PROTECTED_CAPABILITIES, pinnedRefOf } from '../catalog/definition-schemas.js';
import { WorkflowRunFailureSchema } from '../kernel-control/run-outcome.js';
import { ThinkingEffortSchema } from '../executor/model-call.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { pathDerivedId } from '../platform-common/new-id.js';
import { Sha256Schema, closed, text } from '../platform-common/schema-helpers.js';
import { UnitInputSchema } from './unit-io.js';

const inRun = {
  requestId: IdSchemas.requestId,
  sessionId: IdSchemas.sessionId,
  workflowRunId: IdSchemas.workflowRunId,
};

export const RegisterAgentRunRequestSchema = closed(
  {
    ...inRun,
    agentRunId: IdSchemas.agentRunId,
    nodeId: IdSchemas.nodeId,
    agentRef: pinnedRefOf('AGENT'),
    effort: ThinkingEffortSchema,
    workspaceViewId: Type.Literal('main'),
    display: closed({ label: text(80) }),
    /** May only narrow the ceiling, or registration is CAPABILITY_NOT_SUBSET (Kernel/Core 5a.1). */
    requestedCapabilities: Type.Array(Type.Enum(PROTECTED_CAPABILITIES), { uniqueItems: true }),
    /** Relative to the repository root; main has `['.']`, and none without `workspace.write`. */
    writeRoots: Type.Array(text(1024)),
  },
  'kernel.unit.RegisterAgentRunRequest.v1',
);
export type RegisterAgentRunRequest = Static<typeof RegisterAgentRunRequestSchema>;

const matchesPath = (request: { requestId: string; path: string }) =>
  request.requestId === pathDerivedId('req', request.path);
const matchesUnitRun = (request: { unitRunId: string; path: string }) =>
  request.unitRunId === pathDerivedId('unr', request.path.replace(/#[0-9]+$/u, ''));

/** The `requestId` and `unitRunId` come from `path`, so a replayed log rebuilds them. */
export const SubmitUnitRequestSchema = Type.Refine(
  closed(
    {
      ...inRun,
      agentRunId: IdSchemas.agentRunId,
      unitRunId: IdSchemas.unitRunId,
      path: text(512),
      unitRef: pinnedRefOf('UNIT'),
      input: UnitInputSchema,
      display: closed({ toolName: text(64), argsSummary: text(80, 0) }),
    },
    'kernel.unit.SubmitUnitRequest.v1',
  ),
  (request) => matchesPath(request) && matchesUnitRun(request),
  () => 'requestId and unitRunId must be derived from path',
);
export type SubmitUnitRequest = Static<typeof SubmitUnitRequestSchema>;

export const EndAgentRunRequestSchema = closed(
  { ...inRun, agentRunId: IdSchemas.agentRunId },
  'kernel.unit.EndAgentRunRequest.v1',
);
export type EndAgentRunRequest = Static<typeof EndAgentRunRequestSchema>;

export const CloseRunRequestSchema = Type.Union(
  [
    closed({
      ...inRun,
      outcome: Type.Enum(['COMPLETED', 'BUDGET', 'CANCELLED', 'TIMEOUT', 'INTERRUPTED']),
      resultRef: Type.Optional(ArtifactRefSchema),
    }),
    closed({ ...inRun, outcome: Type.Literal('FAILED'), failure: WorkflowRunFailureSchema }),
  ],
  { $id: 'kernel.unit.CloseRunRequest.v1' },
);
export type CloseRunRequest = Static<typeof CloseRunRequestSchema>;

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

/** `AGENTS.md` at the root or below it, with no `.` or `..` segment and no empty one. */
const INSTRUCTIONS_PATH = '(?:(?!\\.\\.?/)[^/]+/)*AGENTS\\.md';

/** Only `AGENTS.md` and repository templates; whether it may be read is decided behind this. */
export const ReadProjectFileRequestSchema = closed(
  {
    ...inRun,
    path: Type.String({
      pattern: `^(?:${INSTRUCTIONS_PATH}|\\.multiagentos/workflows/[a-z0-9][a-z0-9-]{0,63}\\.yaml)$`,
      maxLength: 512,
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
      path: Type.String({ pattern: `^${INSTRUCTIONS_PATH}$`, maxLength: 512 }),
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

/** Only for the interface: Kernel puts it into the ActivityEvents as it is (WorkflowKernel 2.5). */
export const UpdateActivityRequestSchema = closed(
  {
    ...inRun,
    agentRunId: IdSchemas.agentRunId,
    todos: closed({
      total: Type.Integer({ minimum: 0, maximum: 30 }),
      done: Type.Integer({ minimum: 0, maximum: 30 }),
      current: Type.Optional(text(80)),
    }),
  },
  'kernel.unit.UpdateActivityRequest.v1',
);
export type UpdateActivityRequest = Static<typeof UpdateActivityRequestSchema>;
