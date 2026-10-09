import { Type, type Static } from 'typebox';
import { PinnedDefinitionRefSchema } from '../catalog/definition-schemas.js';
import { BudgetStateSchema } from '../kernel-unit/budget-state.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count } from '../platform-common/schema-helpers.js';
import { CloseReasonSchema, RunFailureSchema, UnknownEffectSchema } from './run-outcome.js';

/**
 * Execution part of the run record: assembled by Core, written as an artifact by Execution.
 * `agentRuns[].rounds` counts delivered OK or FAILED model-call UnitReports.
 */
export const RunSummarySchema = closed(
  {
    workflowRunId: IdSchemas.workflowRunId,
    closeReason: CloseReasonSchema,
    failure: Type.Optional(RunFailureSchema),
    reportRef: Type.Optional(ArtifactRefSchema),
    startedAt: TimestampSchema,
    closedAt: TimestampSchema,
    durationMs: count(),
    agentRuns: Type.Array(
      closed({
        agentRunId: IdSchemas.agentRunId,
        agentRef: PinnedDefinitionRefSchema,
        registeredAt: TimestampSchema,
        endedAt: TimestampSchema,
        rounds: count(),
      }),
    ),
    units: closed({
      submitted: count(),
      ok: count(),
      rejected: count(),
      failed: count(),
      notDelivered: count(),
    }),
    model: closed({ requests: count(), finalCallUsed: Type.Boolean() }),
    tokens: closed({
      limit: count(),
      used: count(),
      unknown: count(),
      inputTokens: count(),
      outputTokens: count(),
      finalBudgetState: BudgetStateSchema,
    }),
    unknownEffects: Type.Array(UnknownEffectSchema),
  },
  'kernel.control.RunSummary.v0',
);
export type RunSummary = Static<typeof RunSummarySchema>;
