import { Type, type Static } from 'typebox';
import { pinnedRefOf } from '../catalog/definition-schemas.js';
import { BudgetStateSchema } from '../kernel-unit/budget-state.js';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count } from '../platform-common/schema-helpers.js';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import {
  CLOSE_REASONS_V1,
  RunFailureSchema,
  UnknownEffectSchema,
  UnknownEffectV1Schema,
  ViolationFailureSchema,
  runOutcomeVariants,
} from './run-outcome.js';

const summary = {
  workflowRunId: IdSchemas.workflowRunId,
  startedAt: TimestampSchema,
  closedAt: TimestampSchema,
  durationMs: count(),
  agentRuns: Type.Array(
    closed({
      agentRunId: IdSchemas.agentRunId,
      agentRef: pinnedRefOf('AGENT'),
      registeredAt: TimestampSchema,
      endedAt: TimestampSchema,
      /** Delivered OK or FAILED model-call UnitReports, counted like Workflow's `roundsUsed`. */
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
};
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
const [completed, failed, violation, stopped] = runOutcomeVariants(summary);

/**
 * Execution part of the run record: assembled by Core, written as an artifact by Execution.
 * `failure` and `reportRef` follow `closeReason` exactly as in RunClosed, and every accepted
 * submitUnit is counted in exactly one of `ok`, `rejected`, `failed` and `notDelivered`.
 */
export const RunSummarySchema = Type.Union(
  [
    Type.Refine(completed, unitsAddUp, UNITS_ERROR),
    Type.Refine(failed, unitsAddUp, UNITS_ERROR),
    Type.Refine(violation, unitsAddUp, UNITS_ERROR),
    Type.Refine(stopped, unitsAddUp, UNITS_ERROR),
  ],
  { $id: 'kernel.control.RunSummary.v0' },
);
export type RunSummary = Static<typeof RunSummarySchema>;

// --- Major 1 ---------------------------------------------------------------------------------

const summaryV1 = {
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
  unknownEffects: Type.Array(UnknownEffectV1Schema),
  resultRef: Type.Optional(ArtifactRefSchema),
};

/**
 * Execution part of the run record in major 1: assembled by Core from the run's AgentRuns,
 * Units and ledgers, written as an artifact by Execution. `failure` follows `closeReason`
 * exactly as in RunClosed, and every accepted submitUnit is counted exactly once.
 */
export const RunSummaryV1Schema = Type.Union(
  [
    Type.Refine(
      closed({
        ...summaryV1,
        closeReason: Type.Enum(CLOSE_REASONS_V1.filter((r) => r !== 'FAILED' && r !== 'VIOLATION')),
      }),
      unitsAddUp,
      UNITS_ERROR,
    ),
    Type.Refine(
      closed({ ...summaryV1, closeReason: Type.Literal('FAILED'), failure: RunFailureSchema }),
      unitsAddUp,
      UNITS_ERROR,
    ),
    Type.Refine(
      closed({
        ...summaryV1,
        closeReason: Type.Literal('VIOLATION'),
        failure: ViolationFailureSchema,
      }),
      unitsAddUp,
      UNITS_ERROR,
    ),
  ],
  { $id: 'kernel.control.RunSummary.v1' },
);
export type RunSummaryV1 = Static<typeof RunSummaryV1Schema>;
