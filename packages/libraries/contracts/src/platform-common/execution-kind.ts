import { Type, type Static } from 'typebox';

/** The last three kinds are answered with UNSUPPORTED_CAPABILITY in M1 (M1Interface 6.1). */
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
] as const;
export const ExecutionKindSchema = Type.Enum(EXECUTION_KINDS, {
  $id: 'platform.common.ExecutionKind.v0',
});
export type ExecutionKind = Static<typeof ExecutionKindSchema>;

/** The execution kinds that are dispatched to the Supervisor and run by an Executor. */
export const EXECUTOR_KINDS = [
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'FILE_READ',
  'CONTEXT_ASSEMBLE',
  'MODEL',
] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

/** The kinds whose Unit declares `repo.read` and therefore needs a Lease. */
export const REPOSITORY_KINDS = ['REPOSITORY_ORIENT', 'REPOSITORY_SEARCH', 'FILE_READ'] as const;

/** Major 1 adds kinds, which a frozen enum cannot (Interface/Definitions 5). */
export const EXECUTION_KINDS_V1 = [
  ...EXECUTION_KINDS,
  'REPOSITORY_LIST',
  'MESSAGE_PUBLISH',
] as const;
export const ExecutionKindV1Schema = Type.Enum(EXECUTION_KINDS_V1, {
  $id: 'platform.common.ExecutionKind.v1',
});
export type ExecutionKindV1 = Static<typeof ExecutionKindV1Schema>;

export const EXECUTOR_KINDS_V1 = [...EXECUTOR_KINDS, 'REPOSITORY_LIST'] as const;
export type ExecutorKindV1 = (typeof EXECUTOR_KINDS_V1)[number];
export const REPOSITORY_KINDS_V1 = [...REPOSITORY_KINDS, 'REPOSITORY_LIST'] as const;
