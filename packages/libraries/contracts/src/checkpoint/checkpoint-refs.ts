import type { Static } from 'typebox';
import { OpaqueRefSchema } from '../platform-common/opaque-ref.js';

export const WorkflowCheckpointRefSchema = OpaqueRefSchema(
  'workflow-checkpoint',
  'checkpoint.WorkflowCheckpointRef.v0',
);
export type WorkflowCheckpointRef = Static<typeof WorkflowCheckpointRefSchema>;
export const SessionCheckpointRefSchema = OpaqueRefSchema(
  'session-checkpoint',
  'checkpoint.SessionCheckpointRef.v0',
);
export type SessionCheckpointRef = Static<typeof SessionCheckpointRefSchema>;
