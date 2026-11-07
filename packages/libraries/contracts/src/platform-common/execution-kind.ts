import { Type, type Static } from 'typebox';

/**
 * Every execution kind a Unit can have (Interface/Definitions 5). TEST is answered with
 * UNSUPPORTED_CAPABILITY until the stage that adds it.
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
  'FILE_EDIT',
  'OUTPUT_READ',
  'GIT_INSPECT',
  'WEB_SEARCH',
  'WEB_FETCH',
  /** Kernel's own, for a compaction (M2Design 9.6): no Unit has it. */
  'CONTEXT_PRUNE',
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
  'FILE_WRITE',
  'FILE_EDIT',
  'OUTPUT_READ',
  'COMMAND',
  'GIT_INSPECT',
  'WEB_SEARCH',
  'WEB_FETCH',
  'CONTEXT_PRUNE',
] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

/** The kinds whose Unit declares `repo.read` and therefore needs a Lease. */
export const REPOSITORY_KINDS = [
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'FILE_READ',
  'REPOSITORY_LIST',
  'GIT_INSPECT',
] as const;

/** The kinds whose Unit declares `workspace.write`. */
export const WRITE_KINDS = ['FILE_WRITE', 'FILE_EDIT'] as const;

/** The kinds whose Unit declares `command.exec`; they run in a sandbox (M2Design 6). */
export const COMMAND_KINDS = ['COMMAND'] as const;
