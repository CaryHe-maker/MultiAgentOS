import { type Static } from 'typebox';
import { TimestampSchema, closed, count, text } from '../platform-common/schema-helpers.js';

const owner = {
  pid: count(1),
  /** From `/proc/<pid>/stat`, which tells a reused pid apart. */
  processStartedAt: text(64),
  acquiredAt: TimestampSchema,
};

export const InstanceLockInfoSchema = closed(
  { ...owner, hostname: text(255), version: text(64) },
  'platform.persistence.InstanceLockInfo.v1',
);
export type InstanceLockInfo = Static<typeof InstanceLockInfoSchema>;

export const SessionLockInfoSchema = closed(owner, 'platform.persistence.SessionLockInfo.v1');
export type SessionLockInfo = Static<typeof SessionLockInfoSchema>;
