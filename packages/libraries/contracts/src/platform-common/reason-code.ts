import { Type } from 'typebox';
import type { ErrorCategory } from './common-schemas.js';

/** Closed enumeration of M1Interface 3.4; each code has exactly one category. */
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
} as const satisfies Record<string, ErrorCategory>;

export type ReasonCode = keyof typeof REASON_CODE_CATEGORY;
export const REASON_CODES = Object.keys(REASON_CODE_CATEGORY) as ReasonCode[];
export const ReasonCodeSchema = Type.Unsafe<ReasonCode>(
  Type.Enum(REASON_CODES, { $id: 'platform.common.ReasonCode.v0' }),
);

/**
 * Where each reason code may appear (the "出现位置" and "产生者" columns of M1Interface 3.4).
 * Every Schema that carries a reason code accepts only the codes of its own list.
 */

/** SyscallRejected with `issuer = 'GATEWAY'`. RUN_BLOCKED is listed separately below. */
export const GATEWAY_REJECTED_CODES = [
  'INVALID_REQUEST',
  'CALLER_FORBIDDEN',
  'RUN_NOT_FOUND',
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
] as const satisfies readonly ReasonCode[];
export type GatewayRejectedCode = (typeof GATEWAY_REJECTED_CODES)[number];
export type CoreRejectedCode = (typeof CORE_REJECTED_CODES)[number];
/** Every reason code a SyscallRejected may carry; RUN_BLOCKED may come from either issuer. */
export const SYSCALL_REJECTED_CODES = [
  ...new Set<ReasonCode>([...GATEWAY_REJECTED_CODES, 'RUN_BLOCKED', ...CORE_REJECTED_CODES]),
];

/** An Executor's `REJECTED` outcome: a normal out-of-bounds request (ExecutorSet 5). */
export const EXECUTOR_REJECTED_CODES = [
  'OUT_OF_SCOPE',
  'NOT_FOUND',
  'UNSUPPORTED_FILE',
  'INVALID_RANGE',
  'INVALID_QUERY',
  'LIMIT_EXCEEDED',
] as const satisfies readonly ReasonCode[];
/** An Executor's `FAILED` outcome. */
export const EXECUTOR_FAILED_CODES = [
  'PROVIDER_UNREACHABLE',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_AUTH',
  'PROVIDER_ERROR',
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

/** A UnitReport with `status = 'REJECTED'` (docs/M1/Kernel/Interaction.md 5.4). */
export const UNIT_REJECTED_CODES = [
  'INVALID_INPUT',
  'INVALID_ARTIFACT_REF',
  'USER_DECLINED',
  'BUDGET_WRAP_UP',
  'BUDGET_EXHAUSTED',
  'FINAL_CALL_USED',
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
export const UNIT_REPORT_CODES = [...UNIT_REJECTED_CODES, ...UNIT_FAILED_CODES] as const;

/** A closed set of reason codes as a Schema whose static type is the union of those codes. */
export const reasonCodeOf = <const Codes extends readonly ReasonCode[]>(codes: Codes) =>
  Type.Unsafe<Codes[number]>(Type.Enum([...codes]));
