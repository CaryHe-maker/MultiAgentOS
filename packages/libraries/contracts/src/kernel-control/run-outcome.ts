import { Type, type Static } from 'typebox';
import {
  ArtifactRefSchema,
  ErrorCategorySchema,
  artifactRefOf,
} from '../platform-common/common-schemas.js';
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
  closed(failure, 'kernel.control.RunFailure.v1'),
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
  { $id: 'kernel.control.UnknownEffect.v1' },
);
export type UnknownEffect = Static<typeof UnknownEffectSchema>;

export const RunSummaryRefSchema = artifactRefOf(MEDIA_TYPES.runSummary);

/** A timeout is an interrupt, and Workflow reports it as TIMEOUT (M2Design 2.3). */
export const CLOSE_REASONS = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'BUDGET',
  'TIMEOUT',
  'INTERRUPTED',
  'VIOLATION',
  'ENDED_BY_USER',
  'SHUTDOWN',
] as const;
export const CloseReasonSchema = Type.Enum(CLOSE_REASONS, {
  $id: 'kernel.control.CloseReason.v1',
});
export type CloseReason = Static<typeof CloseReasonSchema>;

/** A failure is required exactly for FAILED and VIOLATION; one of the two summary fields is set. */
export const runEnd = <T extends string>(type: T) => {
  const common = {
    type: Type.Literal(type),
    unknownEffects: Type.Array(UnknownEffectSchema),
    resultRef: Type.Optional(ArtifactRefSchema),
  };
  const summary = { ...common, runSummaryRef: RunSummaryRefSchema };
  const unsaved = { ...common, finalizationError: Type.Literal('RUN_SUMMARY_WRITE_FAILED') };
  const normal = {
    closeReason: Type.Enum(CLOSE_REASONS.filter((r) => r !== 'FAILED' && r !== 'VIOLATION')),
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
