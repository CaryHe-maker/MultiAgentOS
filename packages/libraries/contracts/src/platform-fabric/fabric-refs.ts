import type { Static } from 'typebox';
import { OpaqueRefSchema } from '../platform-common/opaque-ref.js';

export const ConsumerOffsetRefSchema = OpaqueRefSchema(
  'consumer-offset',
  'platform.fabric.ConsumerOffsetRef.v0',
);
export type ConsumerOffsetRef = Static<typeof ConsumerOffsetRefSchema>;
