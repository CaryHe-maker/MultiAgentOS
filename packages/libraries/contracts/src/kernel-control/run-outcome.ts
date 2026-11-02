import { Type, type Static, type TProperties } from 'typebox';
import {
  ArtifactRefSchema,
  ErrorCategorySchema,
  artifactRefOf,
} from '../platform-common/common-schemas.js';
import { EXECUTOR_KINDS, EXECUTOR_KINDS_V1 } from '../platform-common/execution-kind.js';
import { IdSchemas } from '../platform-common/ids.js';
import { MEDIA_TYPES } from '../platform-common/media-types.js';
import {
  REASON_CODE_CATEGORY,
  ReasonCodeSchema,
  VIOLATION_CODES,
  type ReasonCode,
} from '../platform-common/reason-code.js';
import { closed, text } from '../platform-common/schema-helpers.js';

/** The reason that entered convergence first wins; only VIOLATION can upgrade it. */
export const CloseReasonSchema = Type.Enum(
  ['COMPLETED', 'FAILED', 'RUN_TIMEOUT', 'CANCELLED', 'VIOLATION'],
  { $id: 'kernel.control.CloseReason.v0' },
);
export type CloseReason = Static<typeof CloseReasonSchema>;

const failure = {
  code: ReasonCodeSchema,
  category: ErrorCategorySchema,
  source: Type.Enum(['WORKFLOW', 'KERNEL']),
  /** The submitUnit that caused the failure. */
  unitRequestId: Type.Optional(IdSchemas.requestId),
  /** Never carries source, prompts or credentials; not used for decisions or user text. */
  detail: Type.Optional(text(200)),
};
type Failure = { code: ReasonCode; category: string; source: string };
const hasOwnCategory = (value: Failure) => value.category === REASON_CODE_CATEGORY[value.code];
const CATEGORY_ERROR = () => 'category must be the category of code (REASON_CODE_CATEGORY)';

/** `category` is always the one category of `code`. */
export const RunFailureSchema = Type.Refine(
  closed(failure, 'kernel.control.RunFailure.v0'),
  hasOwnCategory,
  CATEGORY_ERROR,
);
export type RunFailure = Static<typeof RunFailureSchema>;

/** The failure of `closeRun(FAILED)`: Workflow is the one that judged it. */
export const WorkflowRunFailureSchema = Type.Unsafe<RunFailure>(
  Type.Refine(
    closed({ ...failure, source: Type.Literal('WORKFLOW') }),
    hasOwnCategory,
    CATEGORY_ERROR,
  ),
);
/** The failure of a run closed as VIOLATION: a security violation judged by the Kernel. */
export const ViolationFailureSchema = Type.Unsafe<RunFailure>(
  closed({
    ...failure,
    code: Type.Enum(VIOLATION_CODES),
    category: Type.Literal('INTEGRITY'),
    source: Type.Literal('KERNEL'),
  }),
);

const effect = { unitAttemptId: IdSchemas.unitAttemptId, executionId: IdSchemas.executionId };
/** A model request can only be unconfirmed for a MODEL execution. */
export const UnknownEffectSchema = Type.Union(
  [
    closed({
      ...effect,
      executionKind: Type.Literal('MODEL'),
      effect: Type.Literal('MODEL_REQUEST_UNCONFIRMED'),
    }),
    closed({
      ...effect,
      executionKind: Type.Enum(EXECUTOR_KINDS),
      effect: Type.Literal('EXECUTION_STOP_UNCONFIRMED'),
    }),
  ],
  { $id: 'kernel.control.UnknownEffect.v0' },
);
export type UnknownEffect = Static<typeof UnknownEffectSchema>;

/** As v0, for every major 1 executor kind (`REPOSITORY_LIST` included). */
export const UnknownEffectV1Schema = Type.Union(
  [
    closed({
      ...effect,
      executionKind: Type.Literal('MODEL'),
      effect: Type.Literal('MODEL_REQUEST_UNCONFIRMED'),
    }),
    closed({
      ...effect,
      executionKind: Type.Enum(EXECUTOR_KINDS_V1),
      effect: Type.Literal('EXECUTION_STOP_UNCONFIRMED'),
    }),
  ],
  { $id: 'kernel.control.UnknownEffect.v1' },
);
export type UnknownEffectV1 = Static<typeof UnknownEffectV1Schema>;

export const ReportRefSchema = artifactRefOf(MEDIA_TYPES.analysisReport);
export const RunSummaryRefSchema = artifactRefOf(MEDIA_TYPES.runSummary);

/**
 * The four ways a run ends (M1Interface 5.4), each with exactly its own fields: COMPLETED has
 * `reportRef` and no `failure`; FAILED has `failure`; VIOLATION has a `failure` that is a
 * security violation from the Kernel; RUN_TIMEOUT and CANCELLED have neither. RunClosed,
 * RunFinished and RunSummary are all built from these variants.
 */
export const runOutcomeVariants = <P extends TProperties>(common: P) => {
  const completed = closed({
    ...common,
    closeReason: Type.Literal('COMPLETED'),
    reportRef: ReportRefSchema,
  });
  const failed = closed({
    ...common,
    closeReason: Type.Literal('FAILED'),
    failure: RunFailureSchema,
  });
  const violation = closed({
    ...common,
    closeReason: Type.Literal('VIOLATION'),
    failure: ViolationFailureSchema,
  });
  const stopped = closed({ ...common, closeReason: Type.Enum(['RUN_TIMEOUT', 'CANCELLED']) });
  return [completed, failed, violation, stopped] as [
    typeof completed,
    typeof failed,
    typeof violation,
    typeof stopped,
  ];
};

/** Normal endings carry a RunSummary; a failed write has a typed error and no forged reference. */
export const runEndVariants = <T extends string>(type: T) => {
  const [completed, failed, violation, stopped] = runOutcomeVariants({
    type: Type.Literal(type),
    unknownEffects: Type.Array(UnknownEffectSchema),
    runSummaryRef: RunSummaryRefSchema,
  });
  const [writeFailedCompleted, writeFailedFailed, writeFailedViolation, writeFailedStopped] =
    runOutcomeVariants({
      type: Type.Literal(type),
      unknownEffects: Type.Array(UnknownEffectSchema),
      finalizationError: Type.Literal('RUN_SUMMARY_WRITE_FAILED'),
    });
  return [
    completed,
    failed,
    violation,
    stopped,
    writeFailedCompleted,
    writeFailedFailed,
    writeFailedViolation,
    writeFailedStopped,
  ] as [
    typeof completed,
    typeof failed,
    typeof violation,
    typeof stopped,
    typeof writeFailedCompleted,
    typeof writeFailedFailed,
    typeof writeFailedViolation,
    typeof writeFailedStopped,
  ];
};

/** RUN_TIMEOUT is gone: a timeout is an interrupt, and Workflow reports TIMEOUT (M2Design 2.3). */
export const CLOSE_REASONS_V1 = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'BUDGET',
  'TIMEOUT',
  'VIOLATION',
  'ENDED_BY_USER',
  'SHUTDOWN',
] as const;
export const CloseReasonV1Schema = Type.Enum(CLOSE_REASONS_V1, {
  $id: 'kernel.control.CloseReason.v1',
});
export type CloseReasonV1 = Static<typeof CloseReasonV1Schema>;

/** A failure is required exactly for FAILED and VIOLATION; one of the two summary fields is set. */
export const runEndV1 = <T extends string>(type: T) => {
  const common = {
    type: Type.Literal(type),
    unknownEffects: Type.Array(UnknownEffectV1Schema),
    resultRef: Type.Optional(ArtifactRefSchema),
  };
  const summary = { ...common, runSummaryRef: RunSummaryRefSchema };
  const unsaved = { ...common, finalizationError: Type.Literal('RUN_SUMMARY_WRITE_FAILED') };
  const normal = {
    closeReason: Type.Enum(CLOSE_REASONS_V1.filter((r) => r !== 'FAILED' && r !== 'VIOLATION')),
  };
  const failed = { closeReason: Type.Literal('FAILED'), failure: RunFailureSchema };
  const violation = { closeReason: Type.Literal('VIOLATION'), failure: ViolationFailureSchema };
  return [
    closed({ ...summary, ...normal }),
    closed({ ...unsaved, ...normal }),
    closed({ ...summary, ...failed }),
    closed({ ...unsaved, ...failed }),
    closed({ ...summary, ...violation }),
    closed({ ...unsaved, ...violation }),
  ] as const;
};
