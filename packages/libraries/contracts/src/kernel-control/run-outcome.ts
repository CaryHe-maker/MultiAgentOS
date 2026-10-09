import { Type, type Static, type TProperties } from 'typebox';
import { ErrorCategorySchema, artifactRefOf } from '../platform-common/common-schemas.js';
import { EXECUTOR_KINDS } from '../platform-common/execution-kind.js';
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
const ViolationFailureSchema = Type.Unsafe<RunFailure>(
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

/** RunEnd, the fields RunClosed and RunFinished share. It is not a registered Schema itself. */
export const runEndVariants = <T extends string>(type: T) =>
  runOutcomeVariants({
    type: Type.Literal(type),
    unknownEffects: Type.Array(UnknownEffectSchema),
    runSummaryRef: RunSummaryRefSchema,
  });
