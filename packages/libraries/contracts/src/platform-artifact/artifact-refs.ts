import type { Static } from 'typebox';
import { OpaqueRefSchema } from '../platform-common/opaque-ref.js';

export const RetentionTokenRefSchema = OpaqueRefSchema(
  'retention-token',
  'platform.artifact.RetentionTokenRef.v1',
);
export type RetentionTokenRef = Static<typeof RetentionTokenRefSchema>;
