import { Type, type Static } from 'typebox';
import { pinnedRefOf } from '../catalog/definition-schemas.js';
import { BudgetStateSchema } from '../kernel-unit/budget-state.js';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count } from '../platform-common/schema-helpers.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import {
  CLOSE_REASONS,
  RunFailureSchema,
  UnknownEffectSchema,
  ViolationFailureSchema,
} from './run-outcome.js';
type Units = {
  submitted: number;
  ok: number;
  rejected: number;
  failed: number;
  notDelivered: number;
};
const unitsAddUp = (value: { units: Units }) =>
  value.units.submitted ===
  value.units.ok + value.units.rejected + value.units.failed + value.units.notDelivered;
const UNITS_ERROR = () => 'units.submitted must equal ok + rejected + failed + notDelivered';

const summary = {
  workflowRunId: IdSchemas.workflowRunId,
  sessionId: IdSchemas.sessionId,
  startedAt: TimestampSchema,
  closedAt: TimestampSchema,
  durationMs: count(),
  turns: count(),
  agentRuns: Type.Array(
    closed({
      agentRunId: IdSchemas.agentRunId,
      agentRef: pinnedRefOf('AGENT'),
      registeredAt: TimestampSchema,
      /** Absent when the run closed while the AgentRun was still active. */
      endedAt: Type.Optional(TimestampSchema),
      /** Delivered OK or FAILED model-call UnitReports of this AgentRun. */
      rounds: count(),
      finalCallUsed: Type.Boolean(),
    }),
  ),
  units: closed({
    submitted: count(),
    ok: count(),
    rejected: count(),
    failed: count(),
    notDelivered: count(),
  }),
  model: closed({ requests: count() }),
  tokens: closed({
    limit: count(),
    used: count(),
    unknown: count(),
    inputTokens: count(),
    outputTokens: count(),
    finalBudgetState: BudgetStateSchema,
  }),
  unknownEffects: Type.Array(UnknownEffectSchema),
  resultRef: Type.Optional(ArtifactRefSchema),
};

/**
 * Execution part of the run record: assembled by Core from the run's AgentRuns,
 * Units and ledgers, written as an artifact by Execution. `failure` follows `closeReason`
 * exactly as in RunClosed, and every accepted submitUnit is counted exactly once.
 */
export const RunSummarySchema = Type.Union(
  [
    Type.Refine(
      closed({
        ...summary,
        closeReason: Type.Enum(CLOSE_REASONS.filter((r) => r !== 'FAILED' && r !== 'VIOLATION')),
      }),
      unitsAddUp,
      UNITS_ERROR,
    ),
    Type.Refine(
      closed({ ...summary, closeReason: Type.Literal('FAILED'), failure: RunFailureSchema }),
      unitsAddUp,
      UNITS_ERROR,
    ),
    Type.Refine(
      closed({
        ...summary,
        closeReason: Type.Literal('VIOLATION'),
        failure: ViolationFailureSchema,
      }),
      unitsAddUp,
      UNITS_ERROR,
    ),
  ],
  { $id: 'kernel.control.RunSummary.v1' },
);
export type RunSummary = Static<typeof RunSummarySchema>;
