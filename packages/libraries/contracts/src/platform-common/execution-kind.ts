import { Type, type Static } from 'typebox';

/**
 * Every execution kind a Unit can have (Interface/Definitions 5). FILE_WRITE, COMMAND and TEST
 * are answered with UNSUPPORTED_CAPABILITY until the stages that add them.
 */
export const EXECUTION_KINDS = [
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'FILE_READ',
  'CONTEXT_ASSEMBLE',
  'MODEL',
  'REPORT_PUBLISH',
  'FILE_WRITE',
  'COMMAND',
  'TEST',
  'REPOSITORY_LIST',
  'MESSAGE_PUBLISH',
] as const;
export const ExecutionKindSchema = Type.Enum(EXECUTION_KINDS, {
  $id: 'platform.common.ExecutionKind.v1',
});
export type ExecutionKind = Static<typeof ExecutionKindSchema>;

/** The execution kinds that are dispatched to the Supervisor and run by an Executor. */
export const EXECUTOR_KINDS = [
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'FILE_READ',
  'CONTEXT_ASSEMBLE',
  'MODEL',
  'REPOSITORY_LIST',
] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

/** The kinds whose Unit declares `repo.read` and therefore needs a Lease. */
export const REPOSITORY_KINDS = [
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'FILE_READ',
  'REPOSITORY_LIST',
] as const;
