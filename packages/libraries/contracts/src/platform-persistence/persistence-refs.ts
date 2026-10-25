import type { Static } from 'typebox';
import { OpaqueRefSchema } from '../platform-common/opaque-ref.js';

export const JournalPositionRefSchema = OpaqueRefSchema(
  'journal-position',
  'platform.persistence.JournalPositionRef.v0',
);
export type JournalPositionRef = Static<typeof JournalPositionRefSchema>;
