import { Type, type Static } from 'typebox';
import { pinnedRefOf } from '../catalog/definition-schemas.js';
import { BudgetStateSchema } from '../kernel-unit/budget-state.js';
import { IdSchemas } from '../platform-common/ids.js';
import { TimestampSchema, closed, count } from '../platform-common/schema-helpers.js';
import { UnknownEffectSchema, runOutcomeVariants } from './run-outcome.js';

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
