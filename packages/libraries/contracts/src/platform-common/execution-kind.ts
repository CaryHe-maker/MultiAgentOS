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
