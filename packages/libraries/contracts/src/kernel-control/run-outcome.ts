import { Type, type Static } from 'typebox';
import { ArtifactRefSchema, ErrorCategorySchema } from '../platform-common/common-schemas.js';
import { ExecutionKindSchema } from '../platform-common/execution-kind.js';
import { IdSchemas } from '../platform-common/ids.js';
import { ReasonCodeSchema } from '../platform-common/reason-code.js';
import { closed, text } from '../platform-common/schema-helpers.js';

/** The reason that entered convergence first wins; only VIOLATION can upgrade it. */
export const CloseReasonSchema = Type.Enum(
  ['COMPLETED', 'FAILED', 'RUN_TIMEOUT', 'CANCELLED', 'VIOLATION'],
  { $id: 'kernel.control.CloseReason.v0' },
);
export type CloseReason = Static<typeof CloseReasonSchema>;

/** `detail` never carries source, prompts or credentials and is not used for decisions. */
export const RunFailureSchema = closed(
  {
    code: ReasonCodeSchema,
    category: ErrorCategorySchema,
    source: Type.Enum(['WORKFLOW', 'KERNEL']),
    unitRequestId: Type.Optional(IdSchemas.requestId),
    detail: Type.Optional(text(200)),
  },
  'kernel.control.RunFailure.v0',
);
export type RunFailure = Static<typeof RunFailureSchema>;

export const UnknownEffectSchema = closed(
  {
    unitAttemptId: IdSchemas.unitAttemptId,
    executionId: IdSchemas.executionId,
    executionKind: ExecutionKindSchema,
    effect: Type.Enum(['MODEL_REQUEST_UNCONFIRMED', 'EXECUTION_STOP_UNCONFIRMED']),
  },
  'kernel.control.UnknownEffect.v0',
);
export type UnknownEffect = Static<typeof UnknownEffectSchema>;

/**
 * RunEnd, the fields RunClosed and RunFinished share (M1Interface 5.2). It is not a registered
 * Schema of its own. The three variants encode which of `failure` and `reportRef` is required
 * for each closeReason (M1Interface 5.4).
 */
export const runEndVariants = <T extends string>(type: T) => {
  const common = {
    type: Type.Literal(type),
    unknownEffects: Type.Array(UnknownEffectSchema),
    runSummaryRef: ArtifactRefSchema,
  };
  const completed = closed({
    ...common,
    closeReason: Type.Literal('COMPLETED'),
    reportRef: ArtifactRefSchema,
  });
  const failed = closed({
    ...common,
    closeReason: Type.Enum(['FAILED', 'VIOLATION']),
    failure: RunFailureSchema,
  });
  const stopped = closed({ ...common, closeReason: Type.Enum(['RUN_TIMEOUT', 'CANCELLED']) });
  return [completed, failed, stopped] as [typeof completed, typeof failed, typeof stopped];
};
