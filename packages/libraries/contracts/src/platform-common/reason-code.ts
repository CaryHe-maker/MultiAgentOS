import { Type } from 'typebox';
import type { ErrorCategory } from './common-schemas.js';

/** Closed enumeration of the Interface documents; each code has exactly one category. */
export const REASON_CODE_CATEGORY = {
  INVALID_REQUEST: 'VALIDATION',
  CALLER_FORBIDDEN: 'POLICY',
  RUN_NOT_FOUND: 'VALIDATION',
  RUN_BLOCKED: 'CONFLICT',
  REQUEST_CONFLICT: 'CONFLICT',
  RUN_LIMIT: 'CONFLICT',
  REPOSITORY_INVALID: 'VALIDATION',
  DEFINITION_MISMATCH: 'INTEGRITY',
  DEFINITION_UNAVAILABLE: 'DEPENDENCY',
  AGENT_RUN_ACTIVE: 'CONFLICT',
  AGENT_RUN_EXISTS: 'CONFLICT',
  AGENT_RUN_NOT_FOUND: 'VALIDATION',
  AGENT_RUN_ENDED: 'CONFLICT',
  FORBIDDEN: 'POLICY',
  UNSUPPORTED_CAPABILITY: 'CONTRACT',
  INVALID_INPUT: 'VALIDATION',
  QUESTION_NOT_PENDING: 'CONFLICT',
  INVALID_ARTIFACT_REF: 'VALIDATION',
  USER_DECLINED: 'POLICY',
  BUDGET_WRAP_UP: 'RESOURCE',
  BUDGET_EXHAUSTED: 'RESOURCE',
  FINAL_CALL_USED: 'RESOURCE',
  OUT_OF_SCOPE: 'POLICY',
  NOT_FOUND: 'EXECUTION',
  UNSUPPORTED_FILE: 'EXECUTION',
  INVALID_RANGE: 'VALIDATION',
  INVALID_QUERY: 'VALIDATION',
  LIMIT_EXCEEDED: 'RESOURCE',
  PROVIDER_UNREACHABLE: 'DEPENDENCY',
  PROVIDER_RATE_LIMITED: 'DEPENDENCY',
  PROVIDER_AUTH: 'DEPENDENCY',
  PROVIDER_ERROR: 'DEPENDENCY',
  PROVIDER_TOOL_CHOICE_IGNORED: 'DEPENDENCY',
  UNIT_TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
  EXECUTION_CANCELLED: 'EXECUTION',
  SCOPE_MISSING: 'INTEGRITY',
  PATH_ESCAPE: 'INTEGRITY',
  GUARD_FAILURE: 'INTEGRITY',
  EXECUTION_STOP_UNCONFIRMED: 'INTERNAL',
  PIN_FAILED: 'DEPENDENCY',
  WORKFLOW_INTERNAL: 'INTERNAL',
  KERNEL_INTERNAL: 'INTERNAL',
  NO_OPEN_TURN: 'CONFLICT',
  SESSION_COMMAND_UNKNOWN: 'CONFLICT',
  SESSION_QUERY_UNKNOWN: 'CONFLICT',
  PROJECT_FILE_FORBIDDEN: 'POLICY',
  ARTIFACT_EXPIRED: 'RESOURCE',
  SESSION_NOT_FOUND: 'VALIDATION',
  SESSION_IN_USE: 'CONFLICT',
  TEMPLATE_UNSUPPORTED: 'VALIDATION',
  HUMAN_REQUEST_NOT_PENDING: 'CONFLICT',
  CONTEXT_OVERFLOW: 'RESOURCE',
  QUOTA_EXHAUSTED: 'RESOURCE',
  CAPABILITY_NOT_SUBSET: 'POLICY',
  CAPABILITY_NOT_GRANTED: 'POLICY',
  WRITE_OUT_OF_SCOPE: 'POLICY',
  PROTECTED_PATH: 'POLICY',
  ADMISSION_CHECK_FAILED: 'POLICY',
  FILE_CHANGED: 'CONFLICT',
  EDIT_NO_MATCH: 'VALIDATION',
  EDIT_NOT_UNIQUE: 'VALIDATION',
  UNDO_NOT_AVAILABLE: 'CONFLICT',
  NOTHING_TO_UNDO: 'CONFLICT',
  UNDO_UNKNOWN: 'CONFLICT',
} as const satisfies Record<string, ErrorCategory>;

export type ReasonCode = keyof typeof REASON_CODE_CATEGORY;
export const REASON_CODES = Object.keys(REASON_CODE_CATEGORY) as ReasonCode[];
export const ReasonCodeSchema = Type.Unsafe<ReasonCode>(
  Type.Enum(REASON_CODES, { $id: 'platform.common.ReasonCode.v1' }),
);

/**
 * Where each reason code may appear.
 * Every Schema that carries a reason code accepts only the codes of its own list.
 */

/** SyscallRejected with `issuer = 'GATEWAY'`. RUN_BLOCKED is listed separately below. */
export const GATEWAY_REJECTED_CODES = [
  'INVALID_REQUEST',
  'CALLER_FORBIDDEN',
  'RUN_NOT_FOUND',
  'SESSION_NOT_FOUND',
] as const satisfies readonly ReasonCode[];
/** SyscallRejected with `issuer = 'CORE'`. RUN_BLOCKED is listed separately below. */
export const CORE_REJECTED_CODES = [
  'RUN_NOT_FOUND',
  'REQUEST_CONFLICT',
  'RUN_LIMIT',
  'REPOSITORY_INVALID',
  'DEFINITION_MISMATCH',
  'DEFINITION_UNAVAILABLE',
  'AGENT_RUN_ACTIVE',
  'AGENT_RUN_EXISTS',
  'AGENT_RUN_NOT_FOUND',
  'AGENT_RUN_ENDED',
  'FORBIDDEN',
  'UNSUPPORTED_CAPABILITY',
  'INVALID_INPUT',
  'QUESTION_NOT_PENDING',
  'INVALID_ARTIFACT_REF',
  'NO_OPEN_TURN',
  'SESSION_COMMAND_UNKNOWN',
  'SESSION_QUERY_UNKNOWN',
  'PROJECT_FILE_FORBIDDEN',
  'SESSION_NOT_FOUND',
  'SESSION_IN_USE',
  'TEMPLATE_UNSUPPORTED',
  'HUMAN_REQUEST_NOT_PENDING',
  'ARTIFACT_EXPIRED',
  'USER_DECLINED',
  'CAPABILITY_NOT_SUBSET',
  'UNDO_NOT_AVAILABLE',
  'NOTHING_TO_UNDO',
  'UNDO_UNKNOWN',
] as const satisfies readonly ReasonCode[];
export type GatewayRejectedCode = (typeof GATEWAY_REJECTED_CODES)[number];
export type CoreRejectedCode = (typeof CORE_REJECTED_CODES)[number];
/** Every reason code a SyscallRejected may carry; RUN_BLOCKED may come from either issuer. */
/** An Executor's `REJECTED` outcome: a normal out-of-bounds request (ExecutorSet 5). */
export const EXECUTOR_REJECTED_CODES = [
  'OUT_OF_SCOPE',
  'NOT_FOUND',
  'UNSUPPORTED_FILE',
  'INVALID_RANGE',
  'INVALID_QUERY',
  'LIMIT_EXCEEDED',
  'WRITE_OUT_OF_SCOPE',
  'PROTECTED_PATH',
  'FILE_CHANGED',
  'EDIT_NO_MATCH',
  'EDIT_NOT_UNIQUE',
] as const satisfies readonly ReasonCode[];
/** An Executor's `FAILED` outcome. */
export const EXECUTOR_FAILED_CODES = [
  'PROVIDER_UNREACHABLE',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_AUTH',
  'PROVIDER_ERROR',
  'PROVIDER_TOOL_CHOICE_IGNORED',
  'INTERNAL',
] as const satisfies readonly ReasonCode[];
/** An Executor's `VIOLATION` outcome, and the `failure.code` of a run closed as VIOLATION. */
export const VIOLATION_CODES = [
  'SCOPE_MISSING',
  'PATH_ESCAPE',
  'GUARD_FAILURE',
] as const satisfies readonly ReasonCode[];
/** `TERMINATED` and `STOP_UNCONFIRMED`, which only the Supervisor decides. */
export const TERMINATION_CODES = [
  'UNIT_TIMEOUT',
  'EXECUTION_CANCELLED',
] as const satisfies readonly ReasonCode[];
export type ExecutorRejectedCode = (typeof EXECUTOR_REJECTED_CODES)[number];
export type ExecutorFailedCode = (typeof EXECUTOR_FAILED_CODES)[number];
export type ViolationCode = (typeof VIOLATION_CODES)[number];
export type TerminationCode = (typeof TERMINATION_CODES)[number];

/** A UnitReport with `status = 'REJECTED'` (Kernel/Interaction 5.4). */
export const UNIT_REJECTED_CODES = [
  'INVALID_INPUT',
  'INVALID_ARTIFACT_REF',
  'USER_DECLINED',
  'BUDGET_WRAP_UP',
  'BUDGET_EXHAUSTED',
  'FINAL_CALL_USED',
  'ARTIFACT_EXPIRED',
  'QUOTA_EXHAUSTED',
  'CAPABILITY_NOT_GRANTED',
  'ADMISSION_CHECK_FAILED',
  ...EXECUTOR_REJECTED_CODES,
] as const satisfies readonly ReasonCode[];
/** A UnitReport with `status = 'FAILED'`. */
export const UNIT_FAILED_CODES = [
  ...EXECUTOR_FAILED_CODES,
  'UNIT_TIMEOUT',
] as const satisfies readonly ReasonCode[];
export type UnitRejectedCode = (typeof UNIT_REJECTED_CODES)[number];
export type UnitFailedCode = (typeof UNIT_FAILED_CODES)[number];
/** Every reason code a UnitReport may carry, and therefore every key of a failurePolicy. */

/** What a definition may decide; a quota and an expired artifact mean the same for every Unit. */
export const FAILURE_POLICY_CODES = [
  ...UNIT_REJECTED_CODES.filter(
    (
      code,
    ): code is Exclude<
      (typeof UNIT_REJECTED_CODES)[number],
      'QUOTA_EXHAUSTED' | 'ARTIFACT_EXPIRED'
    > => code !== 'QUOTA_EXHAUSTED' && code !== 'ARTIFACT_EXPIRED',
  ),
  ...UNIT_FAILED_CODES,
];

/** A closed set of reason codes as a Schema whose static type is the union of those codes. */
export const reasonCodeOf = <const Codes extends readonly ReasonCode[]>(codes: Codes) =>
  Type.Unsafe<Codes[number]>(Type.Enum([...codes]));
