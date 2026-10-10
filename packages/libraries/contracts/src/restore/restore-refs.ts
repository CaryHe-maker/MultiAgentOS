import type { Static } from 'typebox';
import { OpaqueRefSchema } from '../platform-common/opaque-ref.js';

export const RestoreOperationRefSchema = OpaqueRefSchema(
  'restore-operation',
  'restore.RestoreOperationRef.v0',
);
export type RestoreOperationRef = Static<typeof RestoreOperationRefSchema>;
